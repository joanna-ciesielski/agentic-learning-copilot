import type { Embedder } from "../embeddings/hashingEmbedder";
import { HashingEmbedder } from "../embeddings/hashingEmbedder";
import { bm25Scores } from "./bm25";
import { rrf } from "./rrf";
import { chunkDoc } from "./text";
import type { Chunk, RetrievalFilter, Retriever, ScoredChunk, SourceDoc } from "./types";

/** Dot product. Vectors from the embedder are L2-normalized, so this is cosine. */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * In-memory hybrid retriever: dense (embedding cosine) + lexical (BM25), fused
 * with Reciprocal Rank Fusion. Tenant + vertical isolation is enforced as the
 * FIRST step of every retrieve() — the candidate set is filtered down to the
 * caller's (orgId, vertical) before any scoring, so cross-tenant content is
 * never even a candidate. This is the production swap point for MongoDB Atlas
 * Vector Search / pgvector (documented, not deployed).
 */
export class HybridRetriever implements Retriever {
  private constructor(
    private readonly chunks: Chunk[],
    private readonly vectors: number[][],
    private readonly embedder: Embedder,
  ) {}

  /** Ingest documents: chunk, embed, and index in memory. */
  static async fromDocs(docs: SourceDoc[], embedder: Embedder = new HashingEmbedder()): Promise<HybridRetriever> {
    const chunks = docs.flatMap((d) => chunkDoc(d));
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    return new HybridRetriever(chunks, vectors, embedder);
  }

  get size(): number {
    return this.chunks.length;
  }

  async retrieve(query: string, filter: RetrievalFilter, k: number): Promise<ScoredChunk[]> {
    // 1. Isolation boundary FIRST: only this tenant + vertical are candidates.
    const candidates = this.chunks
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.orgId === filter.orgId && c.vertical === filter.vertical);
    if (candidates.length === 0) return [];

    // 2. Dense ranking (cosine over the candidate vectors).
    const [qv = []] = await this.embedder.embed([query]);
    const denseRanked = [...candidates]
      .map(({ i }) => ({ i, score: dot(qv, this.vectors[i] ?? []) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.i);

    // 3. Lexical ranking (BM25 over the candidate texts).
    const bmScores = bm25Scores(
      query,
      candidates.map(({ c }) => c.text),
    );
    const bmRanked = candidates
      .map(({ i }, pos) => ({ i, score: bmScores[pos] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.i);

    // 4. Fuse and take top-k.
    const fused = rrf([denseRanked, bmRanked]);
    return fused.slice(0, k).map(({ id, score }) => ({ chunk: this.chunks[id]!, score }));
  }
}
