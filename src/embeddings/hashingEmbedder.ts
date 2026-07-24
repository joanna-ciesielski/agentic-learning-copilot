import { createHash } from "node:crypto";

/** Minimal embedding backend interface. Real (OpenAI/multilingual) and offline
 *  (hashing) implementations share this so the rest of the app is agnostic.
 *
 *  `embed` is async on purpose: the offline hashing implementation is pure and
 *  synchronous, but any real provider (OpenAI/multilingual) is network-bound and
 *  returns a Promise. Committing to the async contract now keeps this interface
 *  stable when those providers plug in behind it in Phase 1. */
export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, offline hashing embedder — maps token hashes into a fixed-width
 * L2-normalized vector. Good enough to exercise real vector math end to end in
 * tests/demos with no API key; NOT production-quality semantics.
 */
export class HashingEmbedder implements Embedder {
  constructor(readonly dim: number = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const digest = createHash("md5").update(token).digest("hex").slice(0, 8);
      const idx = parseInt(digest, 16) % this.dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
