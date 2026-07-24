/**
 * Reciprocal Rank Fusion. Each input list is item ids in descending relevance
 * order (from one retriever). An item's fused score is the sum of 1/(kConst +
 * rank) across the lists it appears in, so an item ranked highly by multiple
 * retrievers beats one ranked highly by only a single retriever. Returns items
 * sorted by fused score, descending. kConst = 60 is the canonical default.
 */
export function rrf(rankedLists: number[][], kConst = 60): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (kConst + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
