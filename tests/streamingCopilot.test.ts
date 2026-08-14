import { describe, it, expect, beforeAll } from "vitest";
import { createCopilot, type Copilot, type CopilotAnswer } from "../src/graph/copilot";
import { MockChatModel, type ChatMessage } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { BudgetLedger } from "../src/cost/budget";
import { RateLimiter } from "../src/cost/rateLimiter";
import { RelevanceGuard } from "../src/cost/relevanceGuard";
import { InMemoryTracer } from "../src/observability/tracer";
import { CORPUS, TENANT_MARKERS } from "../src/fixtures/corpus";
import { ROUTING_SET } from "../src/fixtures/routing";
import { MULTILINGUAL_CORPUS, MULTILINGUAL_EVAL } from "../src/fixtures/multilingual";
import type { CopilotEvent, TokenEvent, ErrorEvent, DoneEvent } from "../src/streaming/events";
import { createHash } from "node:crypto";

/**
 * Phase 2 e2e tests, written before the implementation they guard (standing
 * rule 5). They assert the contract's behavioural invariants at the event
 * layer, with no HTTP anywhere:
 *  - P1 token parity with ask(), byte-for-byte, over every routing fixture and
 *    the Arabic multilingual fixtures;
 *  - P2 decline parity: identical words on both paths, zero tokens;
 *  - sequencing S1–S8 (terminal exclusivity, route/citation before tokens,
 *    usage immediately before done, strictly monotonic seq);
 *  - guards enforced mid-stream (budget kill in the router→answer window);
 *  - tenant isolation on the streamed path (TENANT_MARKERS).
 */

const SCOPE = { orgId: "acme", userId: "u1" };
const THREAD = "t-e2e";

function offlineModel(): MockChatModel {
  return new MockChatModel(offlineResponder());
}

async function collect(stream: AsyncIterable<CopilotEvent>): Promise<CopilotEvent[]> {
  const events: CopilotEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function tokensOf(events: CopilotEvent[]): TokenEvent[] {
  return events.filter((e): e is TokenEvent => e.type === "token");
}

function concatTokens(events: CopilotEvent[]): string {
  return tokensOf(events)
    .map((t) => t.text)
    .join("");
}

function doneOf(events: CopilotEvent[]): DoneEvent {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error(`stream did not end in done: ${done?.type}`);
  return done;
}

function expectByteEqual(actual: string, expected: string): void {
  expect(Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
}

describe("Copilot.stream — P1 parity with ask()", () => {
  // Two independent copilots over the same corpus/model config, so streaming
  // side effects (cache, budget, profile) cannot contaminate the batch answer.
  let streamer: Copilot;
  let batcher: Copilot;

  beforeAll(async () => {
    streamer = await createCopilot({ model: offlineModel(), docs: CORPUS });
    batcher = await createCopilot({ model: offlineModel(), docs: CORPUS });
  });

  it("concat(token events) is byte-equal to ask().answer for every routing fixture", async () => {
    for (const c of ROUTING_SET) {
      const req = { query: c.query, scope: SCOPE };
      const events = await collect(streamer.stream(req, { threadId: THREAD }));
      const batch = await batcher.ask(req);

      expect(batch.declined).toBe(false);
      expectByteEqual(concatTokens(events), batch.answer);
    }
  });

  it("done carries verifiable parity witnesses (sha256, bytes, tokenCount)", async () => {
    const req = { query: "explain photosynthesis", scope: SCOPE };
    const events = await collect(streamer.stream(req, { threadId: THREAD }));
    const done = doneOf(events);
    const answer = concatTokens(events);

    expect(done.tokenCount).toBe(tokensOf(events).length);
    expect(done.answerBytes).toBe(Buffer.byteLength(answer, "utf8"));
    expect(done.answerSha256).toBe(createHash("sha256").update(answer, "utf8").digest("hex"));
  });

  it("holds for the Arabic multilingual fixtures end to end", async () => {
    const s = await createCopilot({ model: offlineModel(), docs: MULTILINGUAL_CORPUS });
    const b = await createCopilot({ model: offlineModel(), docs: MULTILINGUAL_CORPUS });
    for (const probe of MULTILINGUAL_EVAL) {
      const req = { query: probe.query, scope: { orgId: probe.orgId, userId: "u-ml" } };
      const events = await collect(s.stream(req, { threadId: THREAD }));
      const batch = await b.ask(req);
      expectByteEqual(concatTokens(events), batch.answer);
    }
  });

  it("streams the canned decline-to-answer when retrieval is empty, still at parity", async () => {
    const req = { query: "explain photosynthesis", scope: { orgId: "no-such-org", userId: "u9" } };
    const events = await collect(streamer.stream(req, { threadId: THREAD }));
    const batch = await batcher.ask(req);

    expect(batch.declined).toBe(false);
    expect(batch.citations).toHaveLength(0);
    expectByteEqual(concatTokens(events), batch.answer);
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(events.some((e) => e.type === "note" && e.note === "agent:empty-retrieval")).toBe(true);
    expect(doneOf(events).score?.grounded).toBe(false);
  });
});

describe("Copilot.stream — sequencing (S1–S8)", () => {
  let copilot: Copilot;
  let events: CopilotEvent[];

  beforeAll(async () => {
    copilot = await createCopilot({ model: offlineModel(), docs: CORPUS });
    events = await collect(
      copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }),
    );
  });

  it("seq starts at 1 and is strictly monotonic", () => {
    expect(events[0]?.seq).toBe(1);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    }
  });

  it("emits exactly one terminal event, last", () => {
    const terminals = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminals).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("route precedes citation, citation precedes the first token", () => {
    const idx = (type: CopilotEvent["type"]) => events.findIndex((e) => e.type === type);
    expect(idx("route")).toBeGreaterThanOrEqual(0);
    expect(idx("citation")).toBeGreaterThan(idx("route"));
    expect(idx("token")).toBeGreaterThan(idx("citation"));
  });

  it("usage is emitted exactly once, immediately before done", () => {
    const usageIdx = events.findIndex((e) => e.type === "usage");
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(usageIdx).toBe(events.length - 2);
  });

  it("token indexes are contiguous from 0", () => {
    expect(tokensOf(events).map((t) => t.index)).toEqual(tokensOf(events).map((_, i) => i));
  });

  it("every event carries the requested threadId and a clock-derived ts", async () => {
    let tick = 1000;
    const clocked = await collect(
      copilot.stream(
        { query: "explain photosynthesis", scope: SCOPE },
        { threadId: "t-clock", clock: () => tick++ },
      ),
    );
    expect(clocked.every((e) => e.threadId === "t-clock")).toBe(true);
    expect(clocked.every((e, i) => e.ts === 1000 + i)).toBe(true);
  });

  it("rejects a malformed threadId before emitting any event", async () => {
    const stream = copilot.stream({ query: "q", scope: SCOPE }, { threadId: "../etc/passwd" });
    await expect(collect(stream)).rejects.toThrow();
  });

  it("generates a contract-valid threadId when none is supplied", async () => {
    const events = await collect(copilot.stream({ query: "explain photosynthesis", scope: SCOPE }));
    expect(events.length).toBeGreaterThan(0);
    const threadId = events[0]!.threadId;
    expect(/^[A-Za-z0-9_-]{1,128}$/.test(threadId)).toBe(true);
    expect(events.every((e) => e.threadId === threadId)).toBe(true);
  });
});

describe("Copilot.stream — P2 decline parity and guards", () => {
  async function declinePair(
    make: () => Promise<Copilot>,
    query = "explain photosynthesis",
  ): Promise<{ events: CopilotEvent[]; batch: CopilotAnswer }> {
    const s = await make();
    const b = await make();
    const req = { query, scope: SCOPE };
    return {
      events: await collect(s.stream(req, { threadId: THREAD })),
      batch: await b.ask(req),
    };
  }

  function expectSingleError(events: CopilotEvent[], batch: CopilotAnswer): ErrorEvent {
    expect(batch.declined).toBe(true);
    expect(events).toHaveLength(1);
    const only = events[0]!;
    expect(only.type).toBe("error");
    const err = only as ErrorEvent;
    // P2: identical words on both paths.
    expect(err.message).toBe(batch.answer);
    expect(err.partial).toBe(false);
    return err;
  }

  it("rate limit → single RATE_LIMITED error, message verbatim from ask()", async () => {
    const { events, batch } = await declinePair(() =>
      createCopilot({ model: offlineModel(), docs: CORPUS, rateLimiter: new RateLimiter(0) }),
    );
    expect(expectSingleError(events, batch).code).toBe("RATE_LIMITED");
  });

  it("relevance guard → single IRRELEVANT_QUERY error", async () => {
    const { events, batch } = await declinePair(
      () => createCopilot({ model: offlineModel(), docs: CORPUS, relevanceGuard: new RelevanceGuard() }),
      "   ",
    );
    expect(expectSingleError(events, batch).code).toBe("IRRELEVANT_QUERY");
  });

  it("exhausted budget pre-flight → single BUDGET_EXCEEDED error", async () => {
    const { events, batch } = await declinePair(() =>
      createCopilot({ model: offlineModel(), docs: CORPUS, budget: new BudgetLedger(0) }),
    );
    expect(expectSingleError(events, batch).code).toBe("BUDGET_EXCEEDED");
  });

  it("budget kill in the router→answer window: route emitted, zero tokens, typed error", async () => {
    // Measure the router call's actual spend on an unconstrained copilot, then
    // set the limit so the router fits but the answer call's reservation cannot.
    const probe = await createCopilot({ model: offlineModel(), docs: CORPUS });
    const measured = await probe.ask({ query: "explain photosynthesis", scope: SCOPE });
    const routerSpend = measured.route!.usage.totalTokens;

    const limit = routerSpend + 300; // answer reservation is prompt(+context) + 256 > 300
    const make = () =>
      createCopilot({ model: offlineModel(), docs: CORPUS, budget: new BudgetLedger(limit) });

    const s = await make();
    const events = await collect(
      s.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }),
    );
    const b = await make();
    const batch = await b.ask({ query: "explain photosynthesis", scope: SCOPE });

    expect(events.some((e) => e.type === "route")).toBe(true);
    expect(tokensOf(events)).toHaveLength(0);
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    const err = last as ErrorEvent;
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.partial).toBe(false);
    // Same words as the batch path's mid-turn decline.
    expect(batch.declined).toBe(true);
    expect(err.message).toBe(batch.answer);
  });

  it("consumes the same rate-limit quota as ask()", async () => {
    const rateLimiter = new RateLimiter(2);
    const copilot = await createCopilot({ model: offlineModel(), docs: CORPUS, rateLimiter });

    const first = await collect(copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }));
    expect(first.at(-1)?.type).toBe("done");
    const second = await collect(copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }));
    expect(second.at(-1)?.type).toBe("done");

    const third = await collect(copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }));
    expect(third).toHaveLength(1);
    expect((third[0] as ErrorEvent).code).toBe("RATE_LIMITED");
  });

  it("a provider failure surfaces as a terminal UPSTREAM_ERROR with no internals leaked", async () => {
    const exploding = new MockChatModel((messages) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("routing supervisor")) return offlineResponder()(messages);
      throw new Error("provider secret: api key sk-12345 rejected");
    });
    const copilot = await createCopilot({ model: exploding, docs: CORPUS });
    const events = await collect(
      copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }),
    );

    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    const err = last as ErrorEvent;
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.retryable).toBe(true);
    expect(err.partial).toBe(false);
    expect(err.message).not.toContain("sk-12345");
  });
});

describe("Copilot.stream — degradation paths", () => {
  it("a provider that fails MID-STREAM terminates with partial:true after real tokens", async () => {
    const model = {
      id: "mid-fail",
      complete: async (m: Parameters<ReturnType<typeof offlineResponder>>[0]) => offlineResponder()(m),
      async *streamComplete() {
        yield { index: 0, text: "partial " };
        yield { index: 1, text: "answer" };
        throw new Error("connection reset by provider");
      },
    };
    const copilot = await createCopilot({ model, docs: CORPUS });
    const events = await collect(
      copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }),
    );

    expect(tokensOf(events).length).toBeGreaterThan(0);
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    const err = last as ErrorEvent;
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.partial).toBe(true);
    expect(err.message).not.toContain("connection reset");
    // S1 still holds: the error is terminal and unique.
    expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1);
  });

  it("degrades to a replayed answer for a batch-only provider, still at parity", async () => {
    // A ChatModel without streamComplete: the gateway falls back to one chunk
    // carrying the whole answer — worse delivery, never a different answer.
    const batchOnly = {
      id: "batch-only",
      complete: async (m: Parameters<ReturnType<typeof offlineResponder>>[0]) => offlineResponder()(m),
    };
    const s = await createCopilot({ model: batchOnly, docs: CORPUS });
    const b = await createCopilot({ model: offlineModel(), docs: CORPUS });
    const req = { query: "explain photosynthesis", scope: SCOPE };
    const events = await collect(s.stream(req, { threadId: THREAD }));
    const batch = await b.ask(req);

    expect(tokensOf(events).length).toBeGreaterThan(0);
    expectByteEqual(concatTokens(events), batch.answer);
    expect(doneOf(events).answerSha256).toBe(
      createHash("sha256").update(batch.answer, "utf8").digest("hex"),
    );
  });

  it("agent replays chunks itself when handed a gateway that cannot stream", async () => {
    // A caller-injected custom gateway without streamComplete exercises the
    // agent-level fallback (distinct from the gateway-level one above).
    const { makeVerticalAgent } = await import("../src/agents/verticalAgent");
    const { HybridRetriever } = await import("../src/retrieval/hybridRetriever");
    const { ZERO_USAGE } = await import("../src/llm/modelGateway");

    const retriever = await HybridRetriever.fromDocs(CORPUS, new (await import("../src/embeddings/hashingEmbedder")).HashingEmbedder());
    const answer = "Grounded answer from a batch-only gateway.";
    const gateway = {
      isModelGateway: true as const,
      complete: async () => ({ text: answer, ...ZERO_USAGE }),
    };
    const agent = makeVerticalAgent("courses", retriever, gateway);

    const payloads: { kind: string; chunk?: { text: string } }[] = [];
    const result = await agent.run("explain photosynthesis", SCOPE, "general", (p) => payloads.push(p));

    expect(result.answer).toBe(answer);
    const streamed = payloads.filter((p) => p.kind === "token").map((p) => p.chunk!.text).join("");
    expectByteEqual(streamed, answer);
    expect(payloads[0]?.kind).toBe("citation"); // S3: citations before tokens
  });
});

describe("Copilot.stream — tenant isolation and observability", () => {
  it("tenant A's stream never contains tenant B's markers, in any event", async () => {
    const copilot = await createCopilot({ model: offlineModel(), docs: CORPUS });
    const probes = [
      { scope: { orgId: "acme", userId: "u1" }, query: "orbital mechanics kepler elliptical orbits", foreign: TENANT_MARKERS.globex },
      { scope: { orgId: "globex", userId: "u2" }, query: "photosynthesis chlorophyll calvin cycle", foreign: TENANT_MARKERS.acme },
    ];

    for (const p of probes) {
      const events = await collect(copilot.stream({ query: p.query, scope: p.scope }, { threadId: THREAD }));
      const streamedText = concatTokens(events);
      for (const marker of p.foreign) {
        expect(streamedText).not.toContain(marker);
      }
      for (const e of events) {
        if (e.type === "citation") {
          expect(e.citations.every((c) => c.docId.startsWith(`${p.scope.orgId}-`))).toBe(true);
        }
      }
    }
  });

  it("an abort during routing prevents the answer call entirely (no orphaned model calls)", async () => {
    // Deterministic in-process version of the abort guarantee: the signal is
    // aborted while the routing call is still pending, with no kernel or
    // socket-close latency involved, so LangGraph's between-task signal check
    // MUST see it before the agent node. The transport-level test asserts the
    // disconnect→signal wiring; this one pins the semantics.
    const responder = offlineResponder();
    let routingCalls = 0;
    let answerCalls = 0;
    const model = {
      id: "slow-routing",
      complete: async (messages: ChatMessage[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("routing supervisor")) {
          routingCalls++;
          await new Promise((r) => setTimeout(r, 120));
        } else {
          answerCalls++;
        }
        return responder(messages);
      },
    };
    const copilot = await createCopilot({ model, docs: CORPUS });

    const aborter = new AbortController();
    setTimeout(() => aborter.abort(), 10); // fires while routing sleeps
    const events = await collect(
      copilot.stream(
        { query: "explain photosynthesis", scope: SCOPE },
        { threadId: THREAD, signal: aborter.signal },
      ),
    );

    expect(routingCalls).toBe(1);
    expect(answerCalls).toBe(0);
    // On abort the stream ends silently: the consumer is gone by definition,
    // so no terminal event is owed (see StreamOptions.signal).
    expect(events.some((e) => e.type === "token")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("heartbeatMs: 0 disables heartbeats entirely", async () => {
    const copilot = await createCopilot({
      model: new MockChatModel(offlineResponder(), { delayMs: 30 }),
      docs: CORPUS,
    });
    const events = await collect(
      copilot.stream(
        { query: "explain photosynthesis", scope: SCOPE },
        { threadId: THREAD, heartbeatMs: 0 },
      ),
    );
    expect(events.some((e) => e.type === "heartbeat")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("mirrors ask()'s tracer lifecycle on the streamed path", async () => {
    const tracer = new InMemoryTracer();
    const copilot = await createCopilot({ model: offlineModel(), docs: CORPUS, tracer });
    await collect(copilot.stream({ query: "explain photosynthesis", scope: SCOPE }, { threadId: THREAD }));

    expect(tracer.ofType("turn.start")).toHaveLength(1);
    expect(tracer.ofType("turn.route")).toHaveLength(1);
    expect(tracer.ofType("turn.end")).toHaveLength(1);
  });
});
