import { TIERS, costOf, type Tier } from "./pricing";

export interface CostAssumptions {
  users: number;
  sessionsPerUserPerMonth: number;
  turnsPerSession: number;
  promptTokensPerTurn: number;
  completionTokensPerTurn: number;
  /** Fraction of turns served from cache (0..1) — these incur no model cost. */
  cacheHitRate: number;
  /** Share of billed turns per tier; should sum to ~1. */
  tierMix: Record<Tier, number>;
}

export interface CostProjection {
  totalTurns: number;
  billedTurns: number;
  monthlyUsd: number;
  byTier: Record<Tier, number>;
  perUserUsd: number;
}

/**
 * Transparent cost model:
 *   billed_turns = users × sessions × turns × (1 − cache_hit_rate)
 *   monthly_cost = Σ_tier  billed_turns × share(tier) × cost(tier, prompt, completion)
 * Every input is explicit and tunable, so the number is defensible and re-runnable.
 */
export function projectMonthlyCost(a: CostAssumptions): CostProjection {
  const totalTurns = a.users * a.sessionsPerUserPerMonth * a.turnsPerSession;
  const billedTurns = totalTurns * (1 - a.cacheHitRate);

  const byTier = { frontier: 0, mid: 0, cheap: 0 } as Record<Tier, number>;
  let monthlyUsd = 0;
  for (const tier of TIERS) {
    const share = a.tierMix[tier] ?? 0;
    const turns = billedTurns * share;
    const cost = turns * costOf(tier, a.promptTokensPerTurn, a.completionTokensPerTurn);
    byTier[tier] = cost;
    monthlyUsd += cost;
  }

  return {
    totalTurns,
    billedTurns,
    monthlyUsd,
    byTier,
    perUserUsd: a.users > 0 ? monthlyUsd / a.users : 0,
  };
}

/** Default assumptions for the posting's "~10K learners" ask. */
export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  users: 10_000,
  sessionsPerUserPerMonth: 8,
  turnsPerSession: 5,
  promptTokensPerTurn: 1200,
  completionTokensPerTurn: 250,
  cacheHitRate: 0.3,
  tierMix: { frontier: 0.15, mid: 0.55, cheap: 0.3 },
};
