import { describe, it, expect } from "vitest";
import { CachingEmbedder } from "../src/embeddings/cachingEmbedder";
import { HashingEmbedder, type Embedder } from "../src/embeddings/hashingEmbedder";
import { ResponseCache } from "../src/cost/cache";

/** Base embedder that counts how many texts it actually embeds. */
class CountingEmbedder implements Embedder {
  readonly dim = 32;
  embedded = 0;
  private readonly base = new HashingEmbedder(32);
  async embed(texts: string[]): Promise<number[][]> {
    this.embedded += texts.length;
    return this.base.embed(texts);
  }
}

describe("CachingEmbedder", () => {
  it("a warm cache embeds ZERO new texts on a repeat call", async () => {
    const base = new CountingEmbedder();
    const cached = new CachingEmbedder(base);

    await cached.embed(["photosynthesis", "orbital mechanics"]);
    expect(base.embedded).toBe(2); // cold: both computed

    await cached.embed(["photosynthesis", "orbital mechanics"]);
    expect(base.embedded).toBe(2); // warm: no new embeds
    expect(cached.stats.misses).toBe(2); // 2 cold computes
    expect(cached.stats.hits).toBe(2); // 2 warm reuses (not counting the cold computes)
  });

  it("dedupes within a single batch and preserves order/dimensions", async () => {
    const base = new CountingEmbedder();
    const cached = new CachingEmbedder(base);
    const out = await cached.embed(["a", "a", "b"]);
    expect(base.embedded).toBe(2); // "a" embedded once despite appearing twice
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(out[1]);
    expect(out.every((v) => v.length === 32)).toBe(true);
  });
});

describe("ResponseCache", () => {
  it("hits on identical messages and misses after a version bump", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    const c1 = new ResponseCache("v1");
    expect(c1.get(msgs)).toBeUndefined();
    c1.set(msgs, "answer");
    expect(c1.get(msgs)).toBe("answer");
    expect(c1.size).toBe(1);

    // Different version namespace → different key space.
    const c2 = new ResponseCache("v2");
    expect(c2.get(msgs)).toBeUndefined();
  });
});
