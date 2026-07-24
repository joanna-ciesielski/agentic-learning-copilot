import { describe, it, expect } from "vitest";
import { estimateTokens, estimateMessagesTokens } from "../src/cost/tokens";
import { costOf } from "../src/cost/pricing";
import { BudgetLedger, BudgetExceededError } from "../src/cost/budget";
import { CohortModelRouter } from "../src/cost/modelRouter";
import { RateLimiter } from "../src/cost/rateLimiter";
import { RelevanceGuard } from "../src/cost/relevanceGuard";
import { projectMonthlyCost } from "../src/cost/projection";

describe("token estimation", () => {
  it("estimates ~4 chars per token, min 1", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(8))).toBe(2);
    expect(estimateTokens("")).toBe(1);
    expect(estimateMessagesTokens([
      { role: "user", content: "abcd" },
      { role: "system", content: "abcdefgh" },
    ])).toBe(3);
  });
});

describe("pricing", () => {
  it("computes cost from tier and token counts", () => {
    expect(costOf("cheap", 1000, 1000)).toBeCloseTo(0.0008, 6);
    expect(costOf("mid", 1000, 0)).toBeCloseTo(0.001, 6);
    expect(costOf("frontier", 0, 1000)).toBeCloseTo(0.015, 6);
  });
});

describe("BudgetLedger", () => {
  it("tracks spend, remaining, and pre-flight overage per org", () => {
    const b = new BudgetLedger(100);
    expect(b.wouldExceed("o", 101)).toBe(true);
    expect(b.wouldExceed("o", 100)).toBe(false);
    b.add("o", 60);
    expect(b.spent("o")).toBe(60);
    expect(b.remaining("o")).toBe(40);
    expect(b.wouldExceed("o", 50)).toBe(true);
    // Orgs are isolated.
    expect(b.spent("other")).toBe(0);
    // Reset clears spend (daily rollover analog).
    b.reset("o");
    expect(b.spent("o")).toBe(0);
    b.add("o", 5);
    b.reset();
    expect(b.spent("o")).toBe(0);
  });

  it("BudgetExceededError carries context", () => {
    const e = new BudgetExceededError("acme", 500, 10);
    expect(e.orgId).toBe("acme");
    expect(e.name).toBe("BudgetExceededError");
  });
});

describe("CohortModelRouter — tier by cohort", () => {
  const r = new CohortModelRouter();
  it("answering: paid→frontier, general→mid, unverified→cheap", () => {
    expect(r.pickModel("paid", "answer")).toBe("frontier");
    expect(r.pickModel("general", "answer")).toBe("mid");
    expect(r.pickModel("unverified", "answer")).toBe("cheap");
  });
  it("routing is never frontier: known→mid, unverified→cheap", () => {
    expect(r.pickModel("paid", "route")).toBe("mid");
    expect(r.pickModel("general", "route")).toBe("mid");
    expect(r.pickModel("unverified", "route")).toBe("cheap");
  });
});

describe("RateLimiter — per-user cap", () => {
  it("allows up to the cap, then blocks, until reset", () => {
    const rl = new RateLimiter(2);
    expect(rl.tryConsume("u")).toBe(true);
    expect(rl.tryConsume("u")).toBe(true);
    expect(rl.tryConsume("u")).toBe(false);
    expect(rl.used("u")).toBe(2);
    // Other users are independent.
    expect(rl.tryConsume("v")).toBe(true);
    rl.reset("u");
    expect(rl.tryConsume("u")).toBe(true);
  });
});

describe("RelevanceGuard — anti-abuse", () => {
  it("blocks empty and oversized queries, allows normal ones", () => {
    const g = new RelevanceGuard(100);
    expect(g.isRelevant("explain photosynthesis")).toBe(true);
    expect(g.isRelevant("   ")).toBe(false);
    expect(g.isRelevant("x".repeat(101))).toBe(false);
  });
});

describe("projectMonthlyCost", () => {
  it("applies the cache discount and tier mix", () => {
    const p = projectMonthlyCost({
      users: 10,
      sessionsPerUserPerMonth: 1,
      turnsPerSession: 1,
      promptTokensPerTurn: 1000,
      completionTokensPerTurn: 0,
      cacheHitRate: 0,
      tierMix: { frontier: 0, mid: 1, cheap: 0 },
    });
    expect(p.totalTurns).toBe(10);
    expect(p.billedTurns).toBe(10);
    // 10 turns × mid cost(1000 in, 0 out) = 10 × 0.001 = 0.01
    expect(p.monthlyUsd).toBeCloseTo(0.01, 6);
    expect(p.byTier.mid).toBeCloseTo(0.01, 6);
    expect(p.perUserUsd).toBeCloseTo(0.001, 6);
  });

  it("is safe with zero users", () => {
    const p = projectMonthlyCost({
      users: 0,
      sessionsPerUserPerMonth: 1,
      turnsPerSession: 1,
      promptTokensPerTurn: 1000,
      completionTokensPerTurn: 100,
      cacheHitRate: 0,
      tierMix: { frontier: 0, mid: 1, cheap: 0 },
    });
    expect(p.monthlyUsd).toBe(0);
    expect(p.perUserUsd).toBe(0);
  });

  it("cache hit rate reduces billed turns", () => {
    const base = { users: 100, sessionsPerUserPerMonth: 1, turnsPerSession: 1, promptTokensPerTurn: 1000, completionTokensPerTurn: 100, tierMix: { frontier: 0, mid: 1, cheap: 0 } };
    const cold = projectMonthlyCost({ ...base, cacheHitRate: 0 });
    const warm = projectMonthlyCost({ ...base, cacheHitRate: 0.5 });
    expect(warm.monthlyUsd).toBeCloseTo(cold.monthlyUsd * 0.5, 6);
  });
});
