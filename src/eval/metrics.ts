import { tokenize } from "../retrieval/text";

/** Fraction of the top-k retrieved items that are relevant. */
export function precisionAtK(retrieved: string[], gold: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => gold.has(id)).length;
  return hits / k;
}

/** Fraction of the relevant items that appear in the top-k retrieved. */
export function recallAtK(retrieved: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 1; // nothing to find → vacuously satisfied
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => gold.has(id)).length;
  return hits / gold.size;
}

/** Reciprocal rank of the first relevant item (0 if none retrieved). */
export function reciprocalRank(retrieved: string[], gold: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.has(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

// A small stopword + boilerplate set so groundedness scores content words, not
// filler. The offline responder's "based on the retrieved material" preamble is
// included so it doesn't inflate support.
const IGNORE = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "as",
  "how", "what", "which", "into", "with", "that", "this", "it", "its", "by", "from",
  "based", "retrieved", "material", "re",
]);

function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !IGNORE.has(t));
}

/**
 * Groundedness / faithfulness score in [0,1]: the fraction of the answer's
 * content tokens that are supported by (present in) the cited context. An answer
 * that asserts things absent from its sources scores low. Returns 0 for an empty
 * answer and 1 for an answer with no content tokens to check.
 */
export function groundednessScore(answer: string, contextTexts: string[]): number {
  const supported = new Set(contentTokens(contextTexts.join(" ")));
  const tokens = contentTokens(answer);
  // No verifiable content tokens (empty or all-filler) → nothing is grounded.
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => supported.has(t)).length;
  return hits / tokens.length;
}

export function isGrounded(answer: string, contextTexts: string[], threshold = 0.6): boolean {
  return groundednessScore(answer, contextTexts) >= threshold;
}
