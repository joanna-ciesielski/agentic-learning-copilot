import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { createCopilotServer, type ServerOptions } from "../src/server";
import { createCopilot } from "../src/graph/copilot";
import { MockChatModel, type ChatMessage } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { CORPUS } from "../src/fixtures/corpus";
import {
  STREAMING_CONTRACT_VERSION,
  SSE_RETRY_MS,
  CopilotEventSchema,
  type CopilotEvent,
  type ErrorEvent,
  type TokenEvent,
} from "../src/streaming/events";

/**
 * Phase 3 transport tests, written before the implementation (standing rule 5).
 * Real HTTP end to end: node:http server, global fetch, manual SSE parsing from
 * the response ReadableStream — no SSE client library, per the plan's DoD.
 */

interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
  retry?: string;
}

function parseFrames(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: SseFrame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
        else if (line.startsWith("retry: ")) frame.retry = line.slice(7);
      }
      return frame;
    });
}

function eventsOf(frames: SseFrame[]): CopilotEvent[] {
  return frames
    .filter((f) => f.data !== undefined)
    .map((f) => CopilotEventSchema.parse(JSON.parse(f.data!)));
}

const servers: Server[] = [];

async function start(options: ServerOptions): Promise<string> {
  const server = createCopilotServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function offlineServer(overrides: Partial<ServerOptions> = {}): Promise<string> {
  const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
  return start({ copilot, ...overrides });
}

const CHAT_BODY = {
  query: "explain photosynthesis",
  scope: { orgId: "acme", userId: "u1" },
  threadId: "t-http",
};

async function postChat(
  base: string,
  body: unknown = CHAT_BODY,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("SSE server — framing and headers", () => {
  it("answers POST /v1/chat with a contract-conformant event stream", async () => {
    const base = await offlineServer();
    const res = await postChat(base);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("x-streaming-contract-version")).toBe(STREAMING_CONTRACT_VERSION);

    const frames = parseFrames(res.text);
    expect(frames[0]?.retry).toBe(String(SSE_RETRY_MS));

    const events = eventsOf(frames);
    expect(events[0]?.type).toBe("route");
    expect(events.at(-1)?.type).toBe("done");
    expect(events.every((e) => e.threadId === "t-http")).toBe(true);
  });

  it("writes id: matching seq on every replayable frame", async () => {
    const base = await offlineServer();
    const { text } = await postChat(base);
    for (const frame of parseFrames(text)) {
      if (frame.data === undefined || frame.event === "heartbeat") continue;
      const event = JSON.parse(frame.data) as CopilotEvent;
      expect(frame.id).toBe(String(event.seq));
    }
  });

  it("delivers byte-exact answer parity through the transport", async () => {
    const base = await offlineServer();
    const batch = await (
      await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS })
    ).ask({ query: CHAT_BODY.query, scope: CHAT_BODY.scope });

    const { text } = await postChat(base);
    const events = eventsOf(parseFrames(text));
    const streamed = events
      .filter((e): e is TokenEvent => e.type === "token")
      .map((t) => t.text)
      .join("");

    expect(Buffer.from(streamed, "utf8").equals(Buffer.from(batch.answer, "utf8"))).toBe(true);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.answerSha256).toBe(createHash("sha256").update(streamed, "utf8").digest("hex"));
    }
  });

  it("relays a pre-flight decline as a single terminal error event", async () => {
    const { RelevanceGuard } = await import("../src/cost/relevanceGuard");
    const copilot = await createCopilot({
      model: new MockChatModel(offlineResponder()),
      docs: CORPUS,
      relevanceGuard: new RelevanceGuard(),
    });
    const base = await start({ copilot });
    const { status, text } = await postChat(base, { ...CHAT_BODY, query: "   " });
    expect(status).toBe(200);
    const events = eventsOf(parseFrames(text));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as ErrorEvent).code).toBe("IRRELEVANT_QUERY");
  });
});

describe("SSE server — request validation", () => {
  it("rejects a non-POST method", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/v1/chat`);
    expect(res.status).toBe(405);
  });

  it("rejects an unknown path", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON with 400", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/v1/chat`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("rejects a contract-invalid threadId with 400 before any stream starts", async () => {
    const base = await offlineServer();
    const { status } = await postChat(base, { ...CHAT_BODY, threadId: "../etc/passwd" });
    expect(status).toBe(400);
  });

  it("generates a contract-valid threadId when the body omits one", async () => {
    const base = await offlineServer();
    const { status, text } = await postChat(base, { query: CHAT_BODY.query, scope: CHAT_BODY.scope });
    expect(status).toBe(200);
    const events = eventsOf(parseFrames(text));
    expect(events.length).toBeGreaterThan(0);
    const threadId = events[0]!.threadId;
    expect(/^[A-Za-z0-9_-]{1,128}$/.test(threadId)).toBe(true);
    expect(events.every((e) => e.threadId === threadId)).toBe(true);
  });

  it("rejects a body missing scope with 400", async () => {
    const base = await offlineServer();
    const { status } = await postChat(base, { query: "q" });
    expect(status).toBe(400);
  });
});

describe("SSE server — resume (contract §7)", () => {
  it("replays the tail after Last-Event-ID within the buffer", async () => {
    const base = await offlineServer();
    const first = eventsOf(parseFrames((await postChat(base)).text));
    const cursor = first[1]!.seq; // resume from the second event

    const { text } = await postChat(base, CHAT_BODY, { "last-event-id": String(cursor) });
    const replayed = eventsOf(parseFrames(text));

    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((e) => e.seq > cursor)).toBe(true);
    expect(replayed.map((e) => e.seq)).toEqual(first.filter((e) => e.seq > cursor).map((e) => e.seq));
    expect(replayed.at(-1)?.type).toBe("done");
  });

  it("emits a terminal RESUME_GAP when the cursor has been evicted", async () => {
    const base = await offlineServer({ ringEventsPerThread: 2 });
    await postChat(base); // completes; only the last 2 events remain buffered

    const { text } = await postChat(base, CHAT_BODY, { "last-event-id": "1" });
    const events = eventsOf(parseFrames(text));
    expect(events).toHaveLength(1);
    const err = events[0] as ErrorEvent;
    expect(err.type).toBe("error");
    expect(err.code).toBe("RESUME_GAP");
    expect(err.retryable).toBe(true);
  });

  it("emits RESUME_GAP for an unknown threadId", async () => {
    const base = await offlineServer();
    const { text } = await postChat(base, { ...CHAT_BODY, threadId: "t-never-seen" }, { "last-event-id": "3" });
    const events = eventsOf(parseFrames(text));
    expect(events).toHaveLength(1);
    expect((events[0] as ErrorEvent).code).toBe("RESUME_GAP");
  });

  it("treats a malformed Last-Event-ID as absent and streams fresh (R5)", async () => {
    const base = await offlineServer();
    const { text } = await postChat(base, CHAT_BODY, { "last-event-id": "not-a-number" });
    const events = eventsOf(parseFrames(text));
    expect(events[0]?.seq).toBe(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("a fresh POST on the same threadId starts a new logical stream (R8)", async () => {
    const base = await offlineServer();
    await postChat(base);
    const second = eventsOf(parseFrames((await postChat(base)).text));
    expect(second[0]?.seq).toBe(1);
    expect(second.at(-1)?.type).toBe("done");
  });

  it("closes an incomplete replayed turn with a terminal error (R7)", async () => {
    // Abort a slow turn mid-stream, then resume: the replay cannot complete the
    // dead turn, so the transport must close it with a terminal error rather
    // than leave the client hanging.
    const slow = new MockChatModel(offlineResponder(), { delayMs: 30 });
    const copilot = await createCopilot({ model: slow, docs: CORPUS });
    const base = await start({ copilot });

    const aborter = new AbortController();
    const res = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
      signal: aborter.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // first bytes arrived
    aborter.abort();
    await new Promise((r) => setTimeout(r, 150)); // let the server observe the abort

    const { text } = await postChat(base, CHAT_BODY, { "last-event-id": "0" });
    const events = eventsOf(parseFrames(text));
    expect(events.length).toBeGreaterThan(0);
    const last = events.at(-1)!;
    expect(last.type).toBe("error");
    expect((last as ErrorEvent).code).toBe("UPSTREAM_ERROR");
    expect((last as ErrorEvent).retryable).toBe(false);
  });
});

describe("SSE server — heartbeats (contract §8)", () => {
  it("emits heartbeat events without id: lines during silence, and never buffers them", async () => {
    const slow = new MockChatModel(offlineResponder(), { delayMs: 40 });
    const copilot = await createCopilot({ model: slow, docs: CORPUS });
    const base = await start({ copilot, heartbeatMs: 10 });

    const { text } = await postChat(base);
    const frames = parseFrames(text);

    const heartbeatFrames = frames.filter((f) => f.event === "heartbeat");
    expect(heartbeatFrames.length).toBeGreaterThan(0);
    for (const f of heartbeatFrames) {
      expect(f.id).toBeUndefined();
      const parsed = CopilotEventSchema.parse(JSON.parse(f.data!));
      expect(parsed.type).toBe("heartbeat");
    }

    // seq stays strictly monotonic across heartbeats and real events alike.
    const events = eventsOf(frames);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    }

    // Heartbeats consumed seq but are not replayed on resume.
    const replay = eventsOf(parseFrames((await postChat(base, CHAT_BODY, { "last-event-id": "0" })).text));
    expect(replay.some((e) => e.type === "heartbeat")).toBe(false);
    expect(replay.at(-1)?.type).toBe("done");
  });
});

describe("SSE server — units (ring buffer LRU, backpressure)", () => {
  it("evicts the least-recently-used thread when the thread cap is exceeded", async () => {
    const { ThreadRingBuffer } = await import("../src/server/ringBuffer");
    const ring = new ThreadRingBuffer(8, 2);
    const ev = (threadId: string, seq: number): CopilotEvent =>
      CopilotEventSchema.parse({ seq, threadId, ts: 1, type: "note", note: "n" });

    ring.push(ev("t-a", 1));
    ring.push(ev("t-b", 1));
    ring.push(ev("t-c", 1)); // t-a is LRU → evicted
    expect(ring.threadCount).toBe(2);
    expect(ring.resumeFrom("t-a", 1).kind).toBe("gap");
    expect(ring.resumeFrom("t-b", 0).kind).toBe("replay");
  });

  it("does not buffer heartbeats and reports incomplete turns", async () => {
    const { ThreadRingBuffer } = await import("../src/server/ringBuffer");
    const ring = new ThreadRingBuffer();
    ring.push(CopilotEventSchema.parse({ seq: 1, threadId: "t", ts: 1, type: "heartbeat" }));
    ring.push(CopilotEventSchema.parse({ seq: 2, threadId: "t", ts: 1, type: "note", note: "n" }));

    const result = ring.resumeFrom("t", 0);
    expect(result.kind).toBe("replay");
    if (result.kind === "replay") {
      expect(result.events.map((e) => e.seq)).toEqual([2]); // heartbeat absent
      expect(result.complete).toBe(false);
    }
  });

  it("awaitDrain resolves on drain and clears its timer", async () => {
    const { awaitDrain } = await import("../src/server/sse");
    const { EventEmitter } = await import("node:events");
    const res = new EventEmitter() as unknown as import("node:http").ServerResponse;
    let destroyed = false;
    (res as unknown as { destroy: () => void }).destroy = () => {
      destroyed = true;
    };

    const pending = awaitDrain(res, 5_000);
    res.emit("drain");
    await pending;
    expect(destroyed).toBe(false);
  });

  it("awaitDrain disconnects a client that never drains within the timeout", async () => {
    const { awaitDrain } = await import("../src/server/sse");
    const { EventEmitter } = await import("node:events");
    const res = new EventEmitter() as unknown as import("node:http").ServerResponse;
    let destroyed = false;
    (res as unknown as { destroy: () => void }).destroy = () => {
      destroyed = true;
    };

    await awaitDrain(res, 5);
    expect(destroyed).toBe(true);
  });

  it("rejects an oversized request body with 413", async () => {
    const base = await offlineServer();
    const { status } = await postChat(base, { ...CHAT_BODY, query: "x".repeat(70 * 1024) });
    expect(status).toBe(413);
  });
});

describe("SSE server — demo assets and stress mode (Phase 4)", () => {
  it("serves the demo client at GET /", async () => {
    const base = await offlineServer();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("PATTERN 1"); // the labeled teaching patterns ship in the file
    expect(html).toContain("PATTERN 6");
  });

  it("streams synthetic contract-valid events at the requested count", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/v1/stress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rate: 5000, count: 400, threadId: "t-stress" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const events = eventsOf(parseFrames(await res.text()));
    const tokens = events.filter((e): e is TokenEvent => e.type === "token");
    expect(tokens).toHaveLength(400);
    expect(tokens.map((t) => t.index)).toEqual(tokens.map((_, i) => i));
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    }

    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    if (done.type === "done") {
      const text = tokens.map((t) => t.text).join("");
      expect(done.tokenCount).toBe(400);
      expect(done.answerBytes).toBe(Buffer.byteLength(text, "utf8"));
      expect(done.answerSha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });

  it("clamps stress parameters instead of failing", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/v1/stress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rate: 999_999, count: 50 }),
    });
    expect(res.status).toBe(200);
    const events = eventsOf(parseFrames(await res.text()));
    expect(events.filter((e) => e.type === "token")).toHaveLength(50);
  });

  it("serves the demo at the /demo alias and rejects GET /v1/stress", async () => {
    const base = await offlineServer();
    const demo = await fetch(`${base}/demo`);
    expect(demo.status).toBe(200);
    expect(await demo.text()).toContain("PATTERN 1");
    const get = await fetch(`${base}/v1/stress`);
    expect(get.status).toBe(405);
  });

  it("applies defaults on an empty stress body and stops when the client aborts", async () => {
    const base = await offlineServer();
    const aborter = new AbortController();
    const res = await fetch(`${base}/v1/stress`, {
      method: "POST",
      body: "", // empty body → default rate/count/threadId
      signal: aborter.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read(); // events flowing under defaults
    expect(first.done).toBe(false);
    aborter.abort();
    // The server's close listener must stop the mint loop; give it a tick and
    // confirm the server is still healthy by running a normal request.
    await new Promise((r) => setTimeout(r, 100));
    const after = await postChat(base);
    expect(after.status).toBe(200);
    expect(eventsOf(parseFrames(after.text)).at(-1)?.type).toBe("done");
  });

  it("rejects malformed stress bodies with 400", async () => {
    const base = await offlineServer();
    const res = await fetch(`${base}/v1/stress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: "many" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("SSE server — hardening (Phase 5 failure catalog)", () => {
  it("slow client: backpressure pauses the stream, parity still holds end-to-end", async () => {
    // A large answer against a client that refuses to read for a while: the
    // socket buffer fills, write() returns false, and the server must park in
    // awaitDrain rather than buffering without bound — then finish correctly
    // once the client catches up.
    const bigAnswer = `chunk ${"lorem ipsum dolor sit amet ".repeat(5000)}`; // ~135 KB
    const responder = offlineResponder();
    const model = new MockChatModel(
      (messages: ChatMessage[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        return system.includes("routing supervisor") ? responder(messages) : bigAnswer;
      },
      // Large chunks: the socket buffer (~16 KB) still fills against a stalled
      // reader, without minting tens of thousands of events.
      { chunkSize: 512 },
    );
    const copilot = await createCopilot({ model, docs: CORPUS });
    const base = await start({ copilot });

    const res = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });
    const reader = res.body!.getReader();
    const first = await reader.read(); // headers + first frames arrive
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 400)); // stall: kernel buffers fill

    let text = new TextDecoder().decode(first.value);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const events = eventsOf(parseFrames(text));
    const streamed = events
      .filter((e): e is TokenEvent => e.type === "token")
      .map((t) => t.text)
      .join("");
    expect(Buffer.from(streamed, "utf8").equals(Buffer.from(bigAnswer, "utf8"))).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  }, 15_000);

  it("resume storm: concurrent resumes of one thread all replay identically", async () => {
    const base = await offlineServer();
    const original = eventsOf(parseFrames((await postChat(base)).text));
    const cursor = original[0]!.seq;

    const replays = await Promise.all(
      Array.from({ length: 20 }, () =>
        postChat(base, CHAT_BODY, { "last-event-id": String(cursor) }).then((r) =>
          eventsOf(parseFrames(r.text)),
        ),
      ),
    );
    const expected = original.filter((e) => e.seq > cursor).map((e) => e.seq);
    for (const replay of replays) {
      expect(replay.map((e) => e.seq)).toEqual(expected);
      expect(replay.at(-1)?.type).toBe("done");
    }
  });

  it("duplicate Last-Event-ID: repeated identical resumes are idempotent", async () => {
    const base = await offlineServer();
    const original = eventsOf(parseFrames((await postChat(base)).text));
    const cursor = original[1]!.seq;

    const a = eventsOf(parseFrames((await postChat(base, CHAT_BODY, { "last-event-id": String(cursor) })).text));
    const b = eventsOf(parseFrames((await postChat(base, CHAT_BODY, { "last-event-id": String(cursor) })).text));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("heartbeat-only idle connection: a long silent window is bridged, then completes", async () => {
    // One slow answer chunk creates a ~300 ms silence; heartbeats at 20 ms
    // must bridge it (connection alive, seq advancing) before any token.
    const responder = offlineResponder();
    const model = new MockChatModel(responder, { delayMs: 300, chunkSize: 4096 });
    const copilot = await createCopilot({ model, docs: CORPUS });
    const base = await start({ copilot, heartbeatMs: 20 });

    const events = eventsOf(parseFrames((await postChat(base)).text));
    const firstTokenPos = events.findIndex((e) => e.type === "token");
    const heartbeatsBefore = events.slice(0, firstTokenPos).filter((e) => e.type === "heartbeat");
    expect(heartbeatsBefore.length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("no listener or connection leaks across many sequential streams", async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);

    const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
    const base = await start({ copilot });
    const server = servers.at(-1)!;

    for (let i = 0; i < 30; i++) {
      await postChat(base, { ...CHAT_BODY, threadId: `t-leak-${i}` });
    }
    // Let keep-alive sockets settle, then assert the server is back to zero.
    await new Promise((r) => setTimeout(r, 150));
    const open = await new Promise<number>((resolve, reject) =>
      server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
    );
    process.off("warning", onWarning);

    // undici keeps a small keep-alive pool (1–2 sockets); the leak signal this
    // guards against is growth toward the request count, not small constants.
    expect(open).toBeLessThanOrEqual(4);
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });
});

describe("SSE server — lifecycle (abort cancels the run)", () => {
  it("client abort during routing prevents the answer call entirely", async () => {
    // A model whose routing call is slow, so the abort deterministically lands
    // between the supervisor and the agent node — the window where an orphaned
    // answer call would otherwise be spawned.
    const responder = offlineResponder();
    let slowRoutingCalls = 0;
    let slowAnswerCalls = 0;
    const slowRouting = {
      id: "slow-routing",
      complete: async (messages: ChatMessage[]) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("routing supervisor")) {
          slowRoutingCalls++;
          await new Promise((r) => setTimeout(r, 120));
        } else {
          slowAnswerCalls++;
        }
        return responder(messages);
      },
    };
    const server = await start({ copilot: await createCopilot({ model: slowRouting, docs: CORPUS }) });

    const aborter = new AbortController();
    const pending = fetch(`${server}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
      signal: aborter.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30)); // inside the routing sleep
    aborter.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 300)); // grace: let any orphaned call surface

    expect(slowRoutingCalls).toBe(1);
    expect(slowAnswerCalls).toBe(0);
  });
});
