import { describe, it, expect } from "vitest";
import { DefaultModelGateway, type CallContext } from "../src/llm/modelGateway";
import { MockChatModel } from "../src/llm/chatModel";
import { BudgetLedger, BudgetExceededError } from "../src/cost/budget";
import { InMemoryMetrics } from "../src/cost/metrics";
import { ResponseCache } from "../src/cost/cache";

const MSGS = [
  { role: "system" as const, content: "you are a helpful assistant" },
  { role: "user" as const, content: "explain photosynthesis in one line" },
];
const CTX: CallContext = { scope: { orgId: "acme", userId: "u1" }, task: "answer", cohort: "general" };

/** A model that counts invocations, so we can prove pre-flight/cache skip it. */
function countingModel() {
  const state = { calls: 0 };
  const model = new MockChatModel(() => {
    state.calls++;
    return "light becomes sugar";
  });
  return { model, state };
}

describe("DefaultModelGateway", () => {
  it("emits a metric with tokens, cost, latency, and tier", async () => {
    const metrics = new InMemoryMetrics();
    let t = 0;
    const gw = new DefaultModelGateway(new MockChatModel(() => "hello world"), {
      metrics,
      clock: () => (t += 5),
    });
    const res = await gw.complete(MSGS, CTX);

    expect(res.tier).toBe("mid"); // general + answer
    expect(res.totalTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(metrics.events).toHaveLength(1);
    const e = metrics.events[0]!;
    expect(e.orgId).toBe("acme");
    expect(e.totalTokens).toBe(res.totalTokens);
    expect(e.costUsd).toBeGreaterThan(0);
  });

  it("selects the tier from cohort + task", async () => {
    const gw = new DefaultModelGateway(new MockChatModel(() => "x"));
    expect((await gw.complete(MSGS, { ...CTX, cohort: "paid" })).tier).toBe("frontier");
    expect((await gw.complete(MSGS, { ...CTX, cohort: "unverified" })).tier).toBe("cheap");
    expect((await gw.complete(MSGS, { ...CTX, task: "route", cohort: "paid" })).tier).toBe("mid");
  });

  it("rejects PRE-FLIGHT on over-budget without calling the model", async () => {
    const { model, state } = countingModel();
    const budget = new BudgetLedger(1); // impossibly small
    const gw = new DefaultModelGateway(model, { budget });

    await expect(gw.complete(MSGS, CTX)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(state.calls).toBe(0); // no spend
    expect(budget.spent("acme")).toBe(0);
  });

  it("charges the budget with actual tokens after a successful call", async () => {
    const budget = new BudgetLedger(10_000);
    const gw = new DefaultModelGateway(new MockChatModel(() => "some answer"), { budget });
    const res = await gw.complete(MSGS, CTX);
    expect(budget.spent("acme")).toBe(res.totalTokens);
  });

  it("routes to the per-tier model when given a tier map", async () => {
    const gw = new DefaultModelGateway(
      {
        frontier: new MockChatModel(() => "FRONTIER"),
        mid: new MockChatModel(() => "MID"),
        cheap: new MockChatModel(() => "CHEAP"),
      },
      {},
    );
    expect((await gw.complete(MSGS, { ...CTX, cohort: "paid" })).text).toBe("FRONTIER");
    expect((await gw.complete(MSGS, { ...CTX, cohort: "general" })).text).toBe("MID");
    expect((await gw.complete(MSGS, { ...CTX, cohort: "unverified" })).text).toBe("CHEAP");
  });

  it("does not overspend under concurrent calls for the same org (reservation)", async () => {
    // reserve per call = promptTokens(16) + maxCompletionTokens(256) = 272.
    // Budget 600 admits at most 2 concurrent reservations (544 ≤ 600 < 816).
    const budget = new BudgetLedger(600);
    const gw = new DefaultModelGateway(new MockChatModel(() => "short"), { budget });

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => gw.complete(MSGS, CTX)),
    );
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(3);
    // The invariant that matters: peak reservation never exceeded the budget.
    expect(budget.spent("acme")).toBeLessThanOrEqual(600);
  });

  it("releases the reservation when the model call throws (no phantom spend)", async () => {
    const budget = new BudgetLedger(10_000);
    const gw = new DefaultModelGateway(
      new MockChatModel(() => {
        throw new Error("provider down");
      }),
      { budget },
    );
    await expect(gw.complete(MSGS, CTX)).rejects.toThrow("provider down");
    expect(budget.spent("acme")).toBe(0); // reservation released
  });

  it("serves a cache hit without calling the model or spending", async () => {
    const { model, state } = countingModel();
    const cache = new ResponseCache();
    const budget = new BudgetLedger(10_000);
    const gw = new DefaultModelGateway(model, { cache, budget });

    const first = await gw.complete(MSGS, CTX);
    expect(first.cached).toBe(false);
    expect(state.calls).toBe(1);
    const spentAfterFirst = budget.spent("acme");

    const second = await gw.complete(MSGS, CTX);
    expect(second.cached).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(state.calls).toBe(1); // model NOT called again
    expect(budget.spent("acme")).toBe(spentAfterFirst); // no additional spend
  });
});
