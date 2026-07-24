import { describe, it, expect } from "vitest";
import {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  groundednessScore,
  isGrounded,
} from "../src/eval/metrics";
import { runEval, checkGates, type EvalReport } from "../src/eval/runEval";
import { EVAL_THRESHOLDS } from "../src/eval/thresholds";
import { FIXTURE_VERSION } from "../src/eval/dataset";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { CORPUS } from "../src/fixtures/corpus";

describe("retrieval metrics", () => {
  it("precision@k = relevant in top-k / k", () => {
    expect(precisionAtK(["a", "b", "c", "d"], new Set(["a", "c"]), 4)).toBe(0.5);
    expect(precisionAtK([], new Set(["a"]), 0)).toBe(0);
  });

  it("recall@k = relevant found / relevant total (vacuous when no gold)", () => {
    expect(recallAtK(["a", "b", "c", "d"], new Set(["a", "c", "x"]), 4)).toBeCloseTo(2 / 3, 6);
    expect(recallAtK([], new Set(), 4)).toBe(1);
  });

  it("reciprocal rank of the first relevant item", () => {
    expect(reciprocalRank(["x", "a", "b"], new Set(["a"]))).toBe(0.5);
    expect(reciprocalRank(["x", "y"], new Set(["a"]))).toBe(0);
  });
});

describe("groundedness", () => {
  it("scores a supported answer high and an unsupported one low", () => {
    const ctx = ["Photosynthesis converts light energy into glucose in chloroplasts"];
    expect(groundednessScore("photosynthesis converts light into glucose", ctx)).toBe(1);
    expect(isGrounded("dragons breathe fire over castles", ctx)).toBe(false);
  });

  it("treats an empty answer as ungrounded", () => {
    expect(groundednessScore("", ["anything"])).toBe(0);
  });
});

describe("checkGates", () => {
  it("flags every metric below threshold, including tenant leakage", () => {
    const bad: EvalReport = {
      fixtureVersion: FIXTURE_VERSION,
      routing: { accuracy: 0.5, correct: 5, total: 10 },
      retrieval: { k: 4, precisionAtK: 0.25, recallAtK: 0.5, mrr: 0.5, total: 10 },
      groundedness: { passRate: 0.5, meanScore: 0.5, grounded: 5, total: 10 },
      tenancy: { leaks: 2, total: 4, isolationRate: 0.5 },
    };
    const res = checkGates(bad);
    expect(res.passed).toBe(false);
    expect(res.failures).toHaveLength(4);
  });

  it("passes a report that meets every gate with zero leaks", () => {
    const good: EvalReport = {
      fixtureVersion: FIXTURE_VERSION,
      routing: { accuracy: 0.95, correct: 19, total: 20 },
      retrieval: { k: 4, precisionAtK: 0.25, recallAtK: 1, mrr: 1, total: 16 },
      groundedness: { passRate: 1, meanScore: 1, grounded: 16, total: 16 },
      tenancy: { leaks: 0, total: 4, isolationRate: 1 },
    };
    expect(checkGates(good).passed).toBe(true);
  });
});

describe("runEval — Phase 2 quality gate (offline)", () => {
  it("meets every gate on the versioned fixtures", async () => {
    const report = await runEval({ model: new MockChatModel(offlineResponder()), docs: CORPUS });

    expect(report.fixtureVersion).toBe(FIXTURE_VERSION);
    expect(report.routing.accuracy).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.routingAccuracy);
    expect(report.retrieval.recallAtK).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.recallAtK);
    expect(report.groundedness.passRate).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.groundedness);
    expect(report.tenancy.leaks).toBe(0);
    expect(checkGates(report).passed).toBe(true);
  });
});
