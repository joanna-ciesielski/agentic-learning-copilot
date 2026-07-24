import { tokenize } from "./text";

/**
 * BM25 relevance scores for `docs` against `query`, index-aligned to `docs`.
 * Classic Okapi BM25 (k1, b tunable). Computed over whatever subset is passed
 * in — callers pass the already tenant-scoped chunk texts, so BM25 never sees
 * another tenant's documents.
 */
export function bm25Scores(query: string, docs: string[], k1 = 1.5, b = 0.75): number[] {
  const tokenized = docs.map(tokenize);
  const N = docs.length;
  if (N === 0) return [];

  const lengths = tokenized.map((t) => t.length);
  const avgdl = lengths.reduce((s, x) => s + x, 0) / N || 1;

  const df = new Map<string, number>();
  for (const toks of tokenized) {
    for (const term of new Set(toks)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const qTerms = [...new Set(tokenize(query))];

  return tokenized.map((toks, i) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of qTerms) {
      const n = df.get(term);
      if (!n) continue;
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const dl = lengths[i] ?? 0;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return score;
  });
}
