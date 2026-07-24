/** Model cost tiers. Each maps to a real provider/model in production; in the
 *  offline demo every tier resolves to the same mock model, but the tier still
 *  drives routing decisions, pricing, and metrics. */
export type Tier = "frontier" | "mid" | "cheap";

export const TIERS: readonly Tier[] = ["frontier", "mid", "cheap"] as const;

export interface TierPricing {
  /** USD per 1K input (prompt) tokens. */
  inputPer1k: number;
  /** USD per 1K output (completion) tokens. */
  outputPer1k: number;
}

/** Illustrative pricing (USD / 1K tokens). Values are placeholders for the shape
 *  of the model, not live prices — the cost projection is only as accurate as
 *  these, so they live in one obvious place to update. */
export const PRICING: Record<Tier, TierPricing> = {
  frontier: { inputPer1k: 0.005, outputPer1k: 0.015 },
  mid: { inputPer1k: 0.001, outputPer1k: 0.003 },
  cheap: { inputPer1k: 0.0002, outputPer1k: 0.0006 },
};

export function costOf(tier: Tier, promptTokens: number, completionTokens: number): number {
  const p = PRICING[tier];
  return (promptTokens / 1000) * p.inputPer1k + (completionTokens / 1000) * p.outputPer1k;
}
