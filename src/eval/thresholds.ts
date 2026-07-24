/**
 * The quality gate. These are the numbers CI enforces (see `npm run eval`) and
 * that the eval test asserts. Raising a threshold is a deliberate, reviewable
 * commit — the whole point of pinning them here.
 */
export const EVAL_THRESHOLDS = {
  k: 4,
  routingAccuracy: 0.9,
  recallAtK: 0.9,
  groundedness: 0.9, // pass-rate: fraction of answers grounded in their citations
  maxTenantLeaks: 0, // cross-tenant leakage is a hard invariant — zero tolerance
} as const;
