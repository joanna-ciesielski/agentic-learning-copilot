import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Copilot } from "../graph/copilot";
import {
  CopilotEventSchema,
  ThreadIdSchema,
  HEARTBEAT_INTERVAL_MS,
  type CopilotEvent,
} from "../streaming/events";
import { ThreadRingBuffer } from "./ringBuffer";
import { awaitDrain, writeEvent, writeSseHead } from "./sse";

export interface ServerOptions {
  copilot: Copilot;
  /** Silence threshold for heartbeat events; contract cadence by default. */
  heartbeatMs?: number;
  /** Ring-buffer bounds — overridable for tests; contract defaults otherwise. */
  ringEventsPerThread?: number;
  ringMaxThreads?: number;
  /** How long a backpressured client may stall before disconnection (§11). */
  drainTimeoutMs?: number;
  /** Injectable clock for transport-minted event envelopes. */
  clock?: () => number;
}

/** Request body for POST /v1/chat. `.strict()` throughout: an unknown field is
 *  a 400, not a silent ignore — the transport is contract-shaped end to end. */
const ChatBodySchema = z
  .object({
    query: z.string().min(1),
    scope: z.object({ orgId: z.string().min(1), userId: z.string().min(1) }).strict(),
    cohort: z.enum(["paid", "general", "unverified"]).optional(),
    threadId: ThreadIdSchema.optional(),
  })
  .strict();

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The SSE endpoint on native node:http (fixed decision 2 — zero new runtime
 * dependencies; Fastify/Hono are the documented production swaps). One route:
 *
 *   POST /v1/chat  {query, scope, cohort?, threadId?}  →  text/event-stream
 *
 * The server is a thin adapter: `Copilot.stream()` owns events, sequencing and
 * guards; this layer owns framing, the replay buffer, heartbeat relay,
 * backpressure and abort. No auth by design — deployment concern, out of scope
 * (contract §13); do not expose as-is.
 */
export function createCopilotServer(options: ServerOptions): Server {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  const clock = options.clock ?? (() => Date.now());
  const buffer = new ThreadRingBuffer(options.ringEventsPerThread, options.ringMaxThreads);

  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Late failures (client gone mid-write) end the response if still open.
      if (!res.writableEnded) res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== "/v1/chat") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed; POST /v1/chat" });

    const { raw, tooLarge } = await readBody(req, MAX_BODY_BYTES);
    if (tooLarge) return json(res, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });

    let body: z.infer<typeof ChatBodySchema>;
    try {
      body = ChatBodySchema.parse(JSON.parse(raw));
    } catch (err) {
      return json(res, 400, { error: err instanceof z.ZodError ? "invalid request body" : "malformed request" });
    }

    const threadId = body.threadId ?? randomUUID();
    const lastEventId = parseLastEventId(req.headers["last-event-id"]);

    writeSseHead(res);

    if (lastEventId !== undefined) {
      return resume(res, threadId, lastEventId);
    }

    // Fresh POST: a new logical stream. Any previous buffer under this thread
    // would interleave two seq sequences, so it is reset (contract R8).
    buffer.reset(threadId);

    const aborter = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) aborter.abort();
    });

    const events = options.copilot.stream(
      { query: body.query, scope: body.scope, cohort: body.cohort },
      { threadId, heartbeatMs, clock, signal: aborter.signal },
    );

    for await (const event of events) {
      buffer.push(event);
      if (res.writableEnded || res.destroyed) break;
      const ok = writeEvent(res, event);
      if (!ok) {
        await awaitDrain(res, drainTimeoutMs);
        if (res.destroyed) break;
      }
    }
    if (!res.writableEnded) res.end();
  }

  /** Contract R3/R4/R7: replay the buffered tail, or a terminal RESUME_GAP; a
   *  replay of a turn that never finished is closed with a terminal error so
   *  the client is never left hanging on a dead turn. */
  function resume(res: ServerResponse, threadId: string, lastEventId: number): void {
    const result = buffer.resumeFrom(threadId, lastEventId);

    if (result.kind === "gap") {
      writeEvent(
        res,
        mint({
          seq: lastEventId + 1,
          threadId,
          type: "error",
          code: "RESUME_GAP",
          message: "Resume position is no longer available; start a new request.",
          retryable: true,
          partial: false,
        }),
      );
      res.end();
      return;
    }

    for (const event of result.events) writeEvent(res, event);

    if (!result.complete) {
      const terminal = mint({
        seq: result.lastSeq + 1,
        threadId,
        type: "error",
        code: "UPSTREAM_ERROR",
        message: "The stream ended before completing; start a new request.",
        retryable: false,
        partial: true,
      });
      buffer.push(terminal); // later resumes of this thread replay the close too
      writeEvent(res, terminal);
    }
    res.end();
  }

  /** Transport-minted events (resume outcomes) go through the same schema gate
   *  as everything the event layer emits. */
  function mint(event: Record<string, unknown>): CopilotEvent {
    return CopilotEventSchema.parse({ ts: clock(), ...event });
  }
}

/** Contract R5: only a well-formed integer counts; anything else is absent. */
function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Reads at most `limit` bytes into memory. Past the limit the remainder is
 *  drained and DISCARDED rather than the socket destroyed — destroying
 *  mid-upload surfaces to the client as a connection error instead of the 413
 *  it should see. Memory stays bounded either way. */
function readBody(req: IncomingMessage, limit: number): Promise<{ raw: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ raw: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export { ThreadRingBuffer } from "./ringBuffer";
export { writeEvent, writeSseHead } from "./sse";
