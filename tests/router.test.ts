import { describe, it, expect } from "vitest";
import { Supervisor } from "../src/agents/router";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { isVertical } from "../src/core/types";
import { ROUTING_SET } from "../src/fixtures/routing";

describe("Supervisor", () => {
  it("uses a well-formed, confident model decision", async () => {
    const model = new MockChatModel(() => JSON.stringify({ vertical: "jobs", confidence: 0.9, reason: "clear" }));
    const d = await new Supervisor(model).route("anything");
    expect(d.vertical).toBe("jobs");
    expect(d.viaFallback).toBe(false);
  });

  it("rejects an off-schema vertical via zod and never routes to it (falls back)", async () => {
    // 'sports' is not a valid vertical; zod rejects it, so it can't reach the graph.
    const model = new MockChatModel(() => JSON.stringify({ vertical: "sports", confidence: 0.99 }));
    const d = await new Supervisor(model).route("find me a data analyst job");
    expect(isVertical(d.vertical)).toBe(true);
    expect(d.vertical).toBe("jobs"); // keyword fallback
    expect(d.viaFallback).toBe(true);
  });

  it("falls back to keyword routing when the model call throws", async () => {
    const throwing = new MockChatModel(() => {
      throw new Error("provider unavailable");
    });
    const d = await new Supervisor(throwing).route("show me open data analyst jobs");
    expect(d.vertical).toBe("jobs");
    expect(d.viaFallback).toBe(true);
    expect(d.reason).toContain("model-error");
  });

  it("falls back on non-JSON model output", async () => {
    const d = await new Supervisor(new MockChatModel()).route("explain photosynthesis lesson");
    expect(d.vertical).toBe("courses");
    expect(d.viaFallback).toBe(true);
  });

  it("flags a parsed-but-low-confidence decision as fallback", async () => {
    const model = new MockChatModel(() => JSON.stringify({ vertical: "jobs", confidence: 0.1 }));
    const d = await new Supervisor(model, 0.5).route("q");
    expect(d.viaFallback).toBe(true);
  });

  // DoD: every routing-set query routes to a VALID agent, under BOTH the offline
  // classifier and the degenerate (non-JSON) model.
  it("routes 100% of the routing set to a valid agent (offline classifier)", async () => {
    const sup = new Supervisor(new MockChatModel(offlineResponder()));
    const results = await Promise.all(ROUTING_SET.map((c) => sup.route(c.query)));
    expect(results.every((d) => isVertical(d.vertical))).toBe(true);
  });

  it("routes 100% of the routing set to a valid agent (degenerate model → fallback)", async () => {
    const sup = new Supervisor(new MockChatModel()); // default echo, never valid JSON
    const results = await Promise.all(ROUTING_SET.map((c) => sup.route(c.query)));
    expect(results.every((d) => isVertical(d.vertical))).toBe(true);
  });

  // Informational (Phase 1): offline-classifier accuracy against the labels.
  // Real-model accuracy becomes a hard CI gate in Phase 2.
  it("offline-classifier routing accuracy on the fixture set is high", async () => {
    const sup = new Supervisor(new MockChatModel(offlineResponder()));
    const results = await Promise.all(ROUTING_SET.map((c) => sup.route(c.query)));
    const correct = results.filter((d, i) => d.vertical === ROUTING_SET[i]!.expected).length;
    const accuracy = correct / ROUTING_SET.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});
