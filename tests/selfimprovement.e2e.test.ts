import { describe, it, expect } from "vitest";
import { createCopilot } from "../src/graph/copilot";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { ProfileStore } from "../src/memory/profile";
import { InMemoryTracer } from "../src/observability/tracer";
import { CORPUS } from "../src/fixtures/corpus";

describe("Self-improvement loop (end-to-end)", () => {
  it("DoD: the profile changes an ambiguous routing decision across turns", async () => {
    const profileStore = new ProfileStore();
    const copilot = await createCopilot({
      model: new MockChatModel(offlineResponder()),
      docs: CORPUS,
      profileStore,
    });
    const scope = { orgId: "acme", userId: "learner-1" };

    // Turn 1 — an ambiguous query, no profile yet → default routing (courses).
    const before = await copilot.ask({ query: "hello there", scope });
    expect(before.route?.vertical).toBe("courses");

    // Turns 2–3 — clear jobs queries build a jobs affinity in the profile.
    await copilot.ask({ query: "show me open data analyst jobs", scope });
    await copilot.ask({ query: "apply for the ML engineer role", scope });

    // Turn 4 — the SAME ambiguous query now routes to jobs because of the profile.
    const after = await copilot.ask({ query: "hello there", scope });
    expect(after.route?.vertical).toBe("jobs");
    expect(after.route?.reason).toContain("profile-prior");
  });

  it("without a profile store, the ambiguous query keeps its default routing", async () => {
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
    const scope = { orgId: "acme", userId: "learner-2" };
    await copilot.ask({ query: "show me open data analyst jobs", scope });
    await copilot.ask({ query: "apply for the ML engineer role", scope });
    const after = await copilot.ask({ query: "hello there", scope });
    expect(after.route?.vertical).toBe("courses"); // unchanged — no memory
  });

  it("scores each turn and surfaces it on the answer", async () => {
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
    const res = await copilot.ask({ query: "explain photosynthesis", scope: { orgId: "acme", userId: "u1" } });
    expect(res.score?.grounded).toBe(true);
    expect(res.score?.quality).toBe(1);
  });

  it("emits observability trace events for the turn lifecycle", async () => {
    const tracer = new InMemoryTracer();
    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS, tracer });
    await copilot.ask({ query: "explain photosynthesis", scope: { orgId: "acme", userId: "u1" } });

    expect(tracer.ofType("turn.start")).toHaveLength(1);
    expect(tracer.ofType("turn.route")).toHaveLength(1);
    expect(tracer.ofType("turn.score")).toHaveLength(1);
    expect(tracer.ofType("turn.end")).toHaveLength(1);
  });
});
