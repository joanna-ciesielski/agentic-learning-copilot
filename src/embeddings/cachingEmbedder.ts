import { createHash } from "node:crypto";
import type { Embedder } from "./hashingEmbedder";

function hash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/**
 * Content-hash embedding cache. Wraps any `Embedder`; identical text is embedded
 * once and reused. A warm cache embeds zero new texts, which is the point — real
 * embedding calls cost money and latency. Exposes `stats` so tests/metrics can
 * assert the hit/miss behavior.
 */
export class CachingEmbedder implements Embedder {
  readonly dim: number;
  private readonly cache = new Map<string, number[]>();
  readonly stats = { hits: 0, misses: 0 };

  constructor(private readonly base: Embedder) {
    this.dim = base.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Compute only the texts we haven't seen (deduped), then assemble in order.
    const missing: string[] = [];
    const missingSeen = new Set<string>();
    for (const t of texts) {
      const key = hash(t);
      if (!this.cache.has(key) && !missingSeen.has(key)) {
        missing.push(t);
        missingSeen.add(key);
      }
    }
    if (missing.length > 0) {
      const vectors = await this.base.embed(missing);
      missing.forEach((t, i) => this.cache.set(hash(t), vectors[i] ?? []));
      this.stats.misses += missing.length;
    }
    // Hits = texts served without a recompute this call (reuse), not total lookups.
    this.stats.hits += texts.length - missing.length;
    return texts.map((t) => this.cache.get(hash(t)) ?? []);
  }

  get size(): number {
    return this.cache.size;
  }
}
