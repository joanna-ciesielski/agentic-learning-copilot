import type { Vertical } from "../core/types";

/** A source document as authored/ingested, owned by exactly one tenant. */
export interface SourceDoc {
  id: string;
  orgId: string;
  vertical: Vertical;
  title: string;
  text: string;
}

/** A retrievable chunk of a source document. Carries the tenant + vertical of its
 *  parent so isolation can be enforced at the chunk level. */
export interface Chunk {
  id: string; // `${docId}#${n}`
  docId: string;
  orgId: string;
  vertical: Vertical;
  title: string;
  text: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/** A citation surfaced to the caller — derived from what was actually retrieved,
 *  never from what the model claims, so citations can't be hallucinated. */
export interface Citation {
  chunkId: string;
  docId: string;
  title: string;
}

/** Every retrieval is scoped to one tenant AND one vertical. */
export interface RetrievalFilter {
  orgId: string;
  vertical: Vertical;
}

export interface Retriever {
  retrieve(query: string, filter: RetrievalFilter, k: number): Promise<ScoredChunk[]>;
}
