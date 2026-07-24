import { describe, it, expect } from "vitest";
import { tokenize } from "../src/retrieval/text";
import { HybridRetriever } from "../src/retrieval/hybridRetriever";
import { MULTILINGUAL_CORPUS, MULTILINGUAL_EVAL } from "../src/fixtures/multilingual";

describe("tokenize — Unicode aware", () => {
  it("keeps Arabic (non-Latin) tokens instead of stripping them", () => {
    const toks = tokenize("الكلوروفيل والضوء");
    expect(toks.length).toBe(2);
    expect(toks[0]).toBe("الكلوروفيل");
  });
  it("still handles Latin text and mixed punctuation", () => {
    expect(tokenize("Hello, World! 42x")).toEqual(["hello", "world", "42x"]);
  });
});

describe("bilingual retrieval", () => {
  it("retrieves the same-language document for Arabic and English queries", async () => {
    const retriever = await HybridRetriever.fromDocs(MULTILINGUAL_CORPUS);
    for (const probe of MULTILINGUAL_EVAL) {
      const hits = await retriever.retrieve(probe.query, { orgId: probe.orgId, vertical: probe.vertical }, 2);
      expect(hits[0]!.chunk.docId).toBe(probe.gold);
    }
  });
});
