import { describe, it, expect } from "vitest";
import { HashingEmbedder } from "../src/embeddings/hashingEmbedder";

describe("HashingEmbedder", () => {
  it("is deterministic and correctly dimensioned", async () => {
    const e = new HashingEmbedder(64);
    const [a] = await e.embed(["sunlight and chlorophyll"]);
    const [b] = await e.embed(["sunlight and chlorophyll"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
  });

  it("L2-normalizes each vector", async () => {
    const [v] = await new HashingEmbedder(128).embed(["photosynthesis converts light"]);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("maps different text to different vectors", async () => {
    const e = new HashingEmbedder(128);
    const [a] = await e.embed(["gravity keeps planets in orbit"]);
    const [b] = await e.embed(["mitochondria are the powerhouse"]);
    expect(a).not.toEqual(b);
  });

  it("returns one vector per input, in order", async () => {
    const out = await new HashingEmbedder(32).embed(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(out.every((v) => v.length === 32)).toBe(true);
  });

  it("handles empty / whitespace text as a zero vector without NaN", async () => {
    const [v] = await new HashingEmbedder(16).embed(["   "]);
    expect(v).toHaveLength(16);
    expect(v!.every((x) => x === 0)).toBe(true); // norm fallback avoids divide-by-zero
  });
});
