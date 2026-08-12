import { describe, it, expect } from "vitest";
import { DefaultModelGateway, isStreamingGateway, type CallContext } from "../src/llm/modelGateway";
import { MockChatModel, type ChatMessage, type ChatModel, type TokenChunk } from "../src/llm/chatModel";
import { BudgetLedger, BudgetExceededError } from "../src/cost/budget";
import { ResponseCache } from "../src/cost/cache";
import { InMemoryMetrics } from "../src/cost/metrics";
import { MULTILINGUAL_CORPUS } from "../src/fixtures/multilingual";

/**
 * Streaming must not open a second, laxer accounting path. Every guarantee the
 * gateway makes for `complete()` — pre-flight reservation before the await,
 * reconciliation to actual spend, org-namespaced caching, one metric per call —
 * has to hold identically for `streamComplete()`. These tests are written before
 * the implementation they guard.
 */

const CTX: CallContext = {
  scope: { orgId: "acme", userId: "u1" },
  task: "answer",
  cohort: "general",
};

const MESSAGES: ChatMessage[] = [{ role: "user", content: "what is a relational database?" }];

async function drain(
  stream: AsyncGenerator<TokenChunk, { text: string; totalTokens: number; cached: boolean }>,
): Promise<{ chunks: TokenChunk[]; result: { text: string; totalTokens: number; cached: boolean } }> {
  const chunks: TokenChunk[] = [];
  let next = await stream.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await stream.next();
  }
  return { chunks, result: next.value };
}

describe("gateway streaming — accounting parity with complete()", () => {
  it("exposes streamComplete and is recognised by the guard", () => {
    const gw = new DefaultModelGateway(new MockChatModel());
    expect(isStreamingGateway(gw)).toBe(true);
  });

  it("settles the same token spend as the non-streamed call", async () => {
    const answer = "A relational database stores data in tables with rows and columns.";
    const batchBudget = new BudgetLedger(100_000);
    const streamBudget = new BudgetLedger(100_000);

    const batchGw = new DefaultModelGateway(new MockChatModel(() => answer), { budget: batchBudget });
    const streamGw = new DefaultModelGateway(new MockChatModel(() => answer), { budget: streamBudget });

    const batch = await batchGw.complete(MESSAGES, CTX);
    const { chunks, result } = await drain(streamGw.streamComplete(MESSAGES, CTX));

    expect(chunks.map((c) => c.text).join("")).toBe(batch.text);
    expect(result.totalTokens).toBe(batch.totalTokens);
    expect(streamBudget.spent("acme")).toBe(batchBudget.spent("acme"));
  });

  it("returns a CompletionResult whose text equals the concatenated chunks", async () => {
    const gw = new DefaultModelGateway(new MockChatModel(() => "concatenate me"));
    const { chunks, result } = await drain(gw.streamComplete(MESSAGES, CTX));
    expect(result.text).toBe(chunks.map((c) => c.text).join(""));
  });

  it("preserves byte-equality for Arabic through the gateway", async () => {
    const arabic = MULTILINGUAL_CORPUS[0]?.text as string;
    const gw = new DefaultModelGateway(new MockChatModel(() => arabic));
    const { chunks } = await drain(gw.streamComplete(MESSAGES, CTX));
    const joined = chunks.map((c) => c.text).join("");
    expect(Buffer.from(joined, "utf8").equals(Buffer.from(arabic, "utf8"))).toBe(true);
  });
});

describe("gateway streaming — budget enforcement", () => {
  it("rejects pre-flight, before any chunk is yielded", async () => {
    const budget = new BudgetLedger(5); // far below the prompt estimate
    const gw = new DefaultModelGateway(new MockChatModel(() => "never reached"), { budget });
    const stream = gw.streamComplete(MESSAGES, CTX);

    await expect(stream.next()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budget.spent("acme")).toBe(0);
  });

  it("releases the reservation when the model fails mid-stream", async () => {
    const budget = new BudgetLedger(100_000);
    const exploding: ChatModel = {
      id: "exploding",
      complete: async () => "unused",
      // eslint-disable-next-line require-yield
      async *streamComplete(): AsyncGenerator<TokenChunk> {
        throw new Error("provider dropped the connection");
      },
    };
    const gw = new DefaultModelGateway(exploding, { budget });

    await expect(drain(gw.streamComplete(MESSAGES, CTX))).rejects.toThrow("provider dropped");
    expect(budget.spent("acme")).toBe(0);
  });

  it("closes the provider stream and releases the reservation when the consumer breaks early", async () => {
    // A manual .next() loop does not propagate close the way `for await` does,
    // so the gateway must close its upstream source explicitly. Without that, a
    // disconnecting client leaves the provider generating tokens nobody reads.
    const budget = new BudgetLedger(100_000);
    let providerClosed = false;
    const provider: ChatModel = {
      id: "long-winded",
      complete: async () => "unused",
      async *streamComplete(): AsyncGenerator<TokenChunk> {
        try {
          for (let i = 0; ; i++) yield { index: i, text: `chunk-${i} ` };
        } finally {
          providerClosed = true;
        }
      },
    };
    const gw = new DefaultModelGateway(provider, { budget });

    for await (const chunk of gw.streamComplete(MESSAGES, CTX)) {
      expect(chunk.index).toBe(0);
      break; // client disconnects mid-answer
    }

    expect(providerClosed).toBe(true);
    expect(budget.spent("acme")).toBe(0);
  });

  it("reserves before the first chunk and reconciles down to actual spend", async () => {
    const budget = new BudgetLedger(100_000);
    const gw = new DefaultModelGateway(new MockChatModel(() => "short"), {
      budget,
      maxCompletionTokens: 4_000,
    });

    const stream = gw.streamComplete(MESSAGES, CTX);
    await stream.next(); // first chunk: reservation is already in the ledger
    const reserved = budget.spent("acme");
    expect(reserved).toBeGreaterThan(1_000);

    const { result } = await drain(stream);
    expect(budget.spent("acme")).toBe(result.totalTokens);
    expect(budget.spent("acme")).toBeLessThan(reserved);
  });
});

describe("gateway streaming — cache and metrics", () => {
  it("streams a cache hit with zero spend", async () => {
    const cache = new ResponseCache();
    const budget = new BudgetLedger(100_000);
    const metrics = new InMemoryMetrics();
    const gw = new DefaultModelGateway(new MockChatModel(() => "cached answer text"), {
      cache,
      budget,
      metrics,
    });

    await drain(gw.streamComplete(MESSAGES, CTX));
    const spentAfterFirst = budget.spent("acme");

    const { chunks, result } = await drain(gw.streamComplete(MESSAGES, CTX));
    expect(chunks.map((c) => c.text).join("")).toBe("cached answer text");
    expect(result.cached).toBe(true);
    expect(result.totalTokens).toBe(0);
    expect(budget.spent("acme")).toBe(spentAfterFirst);
    expect(metrics.summary().cacheHits).toBe(1);
  });

  it("populates the cache so a later non-streamed call hits it", async () => {
    const cache = new ResponseCache();
    const gw = new DefaultModelGateway(new MockChatModel(() => "written by the stream"), { cache });

    await drain(gw.streamComplete(MESSAGES, CTX));
    const batch = await gw.complete(MESSAGES, CTX);

    expect(batch.cached).toBe(true);
    expect(batch.text).toBe("written by the stream");
  });

  it("namespaces the streamed cache entry by org, so it cannot cross tenants", async () => {
    const cache = new ResponseCache();
    const gw = new DefaultModelGateway(new MockChatModel(() => "acme-only"), { cache });

    await drain(gw.streamComplete(MESSAGES, CTX));
    const other = await gw.complete(MESSAGES, {
      ...CTX,
      scope: { orgId: "other-org", userId: "u2" },
    });

    expect(other.cached).toBe(false);
  });

  it("emits exactly one metric per streamed call", async () => {
    const metrics = new InMemoryMetrics();
    const gw = new DefaultModelGateway(new MockChatModel(() => "one metric"), { metrics });

    await drain(gw.streamComplete(MESSAGES, CTX));
    expect(metrics.events).toHaveLength(1);
    expect(metrics.events[0]?.orgId).toBe("acme");
    expect(metrics.events[0]?.cached).toBe(false);
  });

  it("falls back to complete() for a provider that cannot stream, still accounted", async () => {
    const budget = new BudgetLedger(100_000);
    const nonStreaming: ChatModel = { id: "batch-only", complete: async () => "batch only answer" };
    const gw = new DefaultModelGateway(nonStreaming, { budget });

    const { chunks, result } = await drain(gw.streamComplete(MESSAGES, CTX));
    expect(chunks).toHaveLength(1);
    expect(result.text).toBe("batch only answer");
    expect(budget.spent("acme")).toBe(result.totalTokens);
  });
});
