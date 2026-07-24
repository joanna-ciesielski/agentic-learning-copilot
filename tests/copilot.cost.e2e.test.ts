import { describe, it, expect } from "vitest";
import { createCopilot } from "../src/graph/copilot";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { BudgetLedger } from "../src/cost/budget";
import { RateLimiter } from "../src/cost/rateLimiter";
import { RelevanceGuard } from "../src/cost/relevanceGuard";
import { InMemoryMetrics } from "../src/cost/metrics";
import { ResponseCache } from "../src/cost/cache";
import { CORPUS } from "../src/fixtures/corpus";

const scope = { orgId: "acme", userId: "u1" };

function countingModel() {
  const state = { calls: 0 };
  const model = new MockChatModel((messages) => {
    state.calls++;
    return offlineResponder()(messages);
  });
  return { model, state };
}

describe("Copilot cost & abuse controls (end-to-end)", () => {
  it("populates per-turn usage (route + answer calls)", async () => {
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
    const res = await copilot.ask({ query: "explain photosynthesis", scope });
    expect(res.declined).toBe(false);
    expect(res.usage.calls).toBe(2); // supervisor route + vertical answer
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.usage.costUsd).toBeGreaterThan(0);
  });

  it("rejects an over-budget org PRE-FLIGHT without any model spend", async () => {
    const { model, state } = countingModel();
    const copilot = await createCopilot({ model, docs: CORPUS, budget: new BudgetLedger(0) });
    const res = await copilot.ask({ query: "explain photosynthesis", scope });

    expect(res.declined).toBe(true);
    expect(res.route).toBeNull();
    expect(res.notes.join(" ")).toContain("budget");
    expect(res.usage.calls).toBe(0);
    expect(state.calls).toBe(0); // the model was never invoked
  });

  it("degrades gracefully when the budget is exceeded MID-turn", async () => {
    const { model, state } = countingModel();
    // Passes the pre-flight remaining>0 check, but too small for a real call → the
    // gateway throws mid-turn and the orchestrator declines instead of crashing.
    const copilot = await createCopilot({ model, docs: CORPUS, budget: new BudgetLedger(5) });
    const res = await copilot.ask({ query: "explain photosynthesis", scope });
    expect(res.declined).toBe(true);
    expect(res.notes.join(" ")).toContain("budget");
    expect(state.calls).toBe(0); // pre-flight in the gateway blocked the first call
  });

  it("enforces the per-user request cap", async () => {
    const copilot = await createCopilot({
      model: new MockChatModel(offlineResponder()),
      docs: CORPUS,
      rateLimiter: new RateLimiter(1),
    });
    const first = await copilot.ask({ query: "explain photosynthesis", scope });
    const second = await copilot.ask({ query: "explain photosynthesis", scope });
    expect(first.declined).toBe(false);
    expect(second.declined).toBe(true);
    expect(second.notes.join(" ")).toContain("rate-limit");
  });

  it("declines an off-topic (empty) query via the relevance guard", async () => {
    const copilot = await createCopilot({
      model: new MockChatModel(offlineResponder()),
      docs: CORPUS,
      relevanceGuard: new RelevanceGuard(),
    });
    const res = await copilot.ask({ query: "   ", scope });
    expect(res.declined).toBe(true);
    expect(res.notes.join(" ")).toContain("off-topic");
  });

  it("selects model tier by cohort (paid → frontier answer, unverified → cheap)", async () => {
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
    const paid = await copilot.ask({ query: "explain photosynthesis", scope, cohort: "paid" });
    const unverified = await copilot.ask({ query: "explain photosynthesis", scope, cohort: "unverified" });
    expect(paid.usage.tiers).toContain("frontier");
    expect(unverified.usage.tiers.every((t) => t === "cheap")).toBe(true);
  });

  it("emits metrics for every model call", async () => {
    const metrics = new InMemoryMetrics();
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS, metrics });
    await copilot.ask({ query: "explain photosynthesis", scope });
    const s = metrics.summary();
    expect(s.calls).toBe(2);
    expect(s.totalTokens).toBeGreaterThan(0);
    expect(s.costUsd).toBeGreaterThan(0);
  });

  it("a warm response cache makes a repeated turn free", async () => {
    const { model, state } = countingModel();
    const copilot = await createCopilot({ model, docs: CORPUS, cache: new ResponseCache() });
    const first = await copilot.ask({ query: "explain photosynthesis", scope });
    const second = await copilot.ask({ query: "explain photosynthesis", scope });

    expect(first.usage.cacheHits).toBe(0);
    expect(second.usage.cacheHits).toBe(second.usage.calls); // all cached
    expect(second.usage.costUsd).toBe(0);
    expect(state.calls).toBe(2); // only the first turn hit the model (route + answer)
  });
});
