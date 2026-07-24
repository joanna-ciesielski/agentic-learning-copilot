import { describe, it, expect } from "vitest";
import { makeVerticalAgent } from "../src/agents/verticalAgent";
import { HybridRetriever } from "../src/retrieval/hybridRetriever";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { CORPUS } from "../src/fixtures/corpus";

describe("VerticalAgent", () => {
  it("answers grounded in tenant-scoped retrieval with citations from retrieval only", async () => {
    const retriever = await HybridRetriever.fromDocs(CORPUS);
    const agent = makeVerticalAgent("courses", retriever, new MockChatModel(offlineResponder()));
    const res = await agent.run("explain photosynthesis", { orgId: "acme", userId: "u1" });

    expect(res.grounded).toBe(true);
    expect(res.citations.length).toBeGreaterThan(0);
    // Citations reference real chunks that exist in the corpus (not hallucinated).
    const validIds = new Set(CORPUS.map((d) => d.id));
    expect(res.citations.every((c) => validIds.has(c.docId))).toBe(true);
  });

  it("declines instead of hallucinating when retrieval is empty", async () => {
    const retriever = await HybridRetriever.fromDocs(CORPUS);
    const agent = makeVerticalAgent("courses", retriever, new MockChatModel(offlineResponder()));
    const res = await agent.run("anything", { orgId: "no-such-org", userId: "u1" });

    expect(res.grounded).toBe(false);
    expect(res.citations).toEqual([]);
    expect(res.answer.toLowerCase()).toContain("don't have material");
  });

  it("only ever cites the caller's own tenant", async () => {
    const retriever = await HybridRetriever.fromDocs(CORPUS);
    const agent = makeVerticalAgent("jobs", retriever, new MockChatModel(offlineResponder()));
    // Query worded toward Globex's posting, but scoped to Acme.
    const res = await agent.run("frontend developer react GLOBEX-JOB-909", { orgId: "acme", userId: "u1" });
    expect(res.citations.every((c) => c.docId.startsWith("acme-"))).toBe(true);
  });
});
