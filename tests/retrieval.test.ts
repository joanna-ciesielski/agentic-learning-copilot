import { describe, it, expect } from "vitest";
import { tokenize, chunkDoc } from "../src/retrieval/text";
import { bm25Scores } from "../src/retrieval/bm25";
import { rrf } from "../src/retrieval/rrf";
import { HybridRetriever } from "../src/retrieval/hybridRetriever";
import type { SourceDoc } from "../src/retrieval/types";
import { CORPUS } from "../src/fixtures/corpus";
import { VERTICALS } from "../src/core/types";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Hello, World! 42x")).toEqual(["hello", "world", "42x"]);
  });
});

describe("chunkDoc", () => {
  const doc: SourceDoc = {
    id: "d1",
    orgId: "acme",
    vertical: "courses",
    title: "T",
    text: "para one.\n\npara two.\n\npara three.",
  };
  it("splits on paragraph boundaries and carries parent metadata", () => {
    const chunks = chunkDoc(doc, 12);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.orgId === "acme" && c.vertical === "courses")).toBe(true);
    expect(chunks[0]!.id).toBe("d1#0");
  });
  it("falls back to a single chunk when there are no paragraph breaks", () => {
    const chunks = chunkDoc({ ...doc, text: "one line only" });
    expect(chunks).toHaveLength(1);
  });
  it("still produces one chunk for whitespace-only text", () => {
    const chunks = chunkDoc({ ...doc, text: "   \n\n   " });
    expect(chunks).toHaveLength(1);
  });
});

describe("bm25Scores", () => {
  it("ranks the doc containing the query term highest", () => {
    const docs = ["the cat sat on the mat", "gravity and orbital motion", "cats are mammals"];
    const scores = bm25Scores("cat", docs);
    expect(scores).toHaveLength(3);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
  it("returns [] for an empty corpus", () => {
    expect(bm25Scores("x", [])).toEqual([]);
  });
});

describe("rrf", () => {
  it("rewards items ranked highly by multiple lists", () => {
    const fused = rrf([
      [1, 2, 3],
      [2, 1, 4],
    ]);
    // 1 and 2 both appear near the top of both lists; 2 is rank0+rank1, 1 is rank0+rank1
    expect(fused[0]!.id === 1 || fused[0]!.id === 2).toBe(true);
    expect(fused.find((f) => f.id === 3)!.score).toBeLessThan(fused[0]!.score);
  });
});

describe("HybridRetriever", () => {
  it("retrieves only chunks matching the (orgId, vertical) filter — no cross-tenant leakage", async () => {
    const r = await HybridRetriever.fromDocs(CORPUS);
    for (const orgId of ["acme", "globex"]) {
      for (const vertical of VERTICALS) {
        const hits = await r.retrieve("developer biology jobs orbit", { orgId, vertical }, 10);
        for (const h of hits) {
          expect(h.chunk.orgId).toBe(orgId);
          expect(h.chunk.vertical).toBe(vertical);
        }
      }
    }
  });

  it("returns [] when no chunk matches the scope", async () => {
    const r = await HybridRetriever.fromDocs(CORPUS);
    expect(await r.retrieve("anything", { orgId: "does-not-exist", vertical: "courses" }, 5)).toEqual([]);
  });

  it("surfaces the on-topic tenant document first", async () => {
    const r = await HybridRetriever.fromDocs(CORPUS);
    const hits = await r.retrieve("photosynthesis chlorophyll calvin cycle", { orgId: "acme", vertical: "courses" }, 3);
    expect(hits[0]!.chunk.docId).toBe("acme-course-photosynthesis");
  });
});
