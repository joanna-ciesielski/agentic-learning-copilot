import type { ServerResponse } from "node:http";
import {
  SSE_RETRY_MS,
  STREAMING_CONTRACT_VERSION,
  type CopilotEvent,
} from "../streaming/events";

/**
 * SSE framing per contract §9. This is the ~50 lines the ADR promised a
 * framework would dilute: headers, `retry:` once, then one frame per event.
 */

export function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-streaming-contract-version": STREAMING_CONTRACT_VERSION,
  });
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
}

/**
 * One frame: `event:` / `id:` / `data:`, blank-line terminated. The whole event
 * object is JSON on a single `data:` line, so literal newlines inside
 * `token.text` cannot break framing (contract §9). Heartbeats carry no `id:`
 * line — the client's resume cursor must only ever point at a replayable event
 * (contract §8). Returns `res.write`'s backpressure signal.
 */
export function writeEvent(res: ServerResponse, event: CopilotEvent): boolean {
  const id = event.type === "heartbeat" ? "" : `id: ${event.seq}\n`;
  return res.write(`event: ${event.type}\n${id}data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Backpressure (contract §11): a false `write()` pauses the pull loop until
 * `drain`, which also pauses the producing graph — pull-based streaming means
 * a slow client throttles the model instead of growing a queue. A client that
 * stays blocked past `timeoutMs` is disconnected: at that point the socket
 * buffer is full, so a typed error cannot be delivered either — destroying the
 * connection is the honest remaining move (measured in Phase 5).
 */
/**
 * Drive an event stream onto a response: write each frame, park on `drain`
 * when the socket pushes back, stop cleanly if the response dies. Extracted
 * from the request handler so the backpressure branch is unit-testable with a
 * deterministic fake response — the end-to-end version of this path depends on
 * kernel socket-buffer sizes, which differ enough across platforms (macOS vs
 * Linux loopback) to make timing-based integration assertions flaky.
 */
export async function pumpEvents(
  res: ServerResponse,
  events: AsyncIterable<CopilotEvent>,
  opts: { drainTimeoutMs: number; onEvent?: (event: CopilotEvent) => void },
): Promise<void> {
  for await (const event of events) {
    opts.onEvent?.(event);
    if (res.writableEnded || res.destroyed) break;
    const ok = writeEvent(res, event);
    if (!ok) {
      await awaitDrain(res, opts.drainTimeoutMs);
      if (res.destroyed) break;
    }
  }
  if (!res.writableEnded) res.end();
}

export function awaitDrain(res: ServerResponse, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      res.off("drain", onDrain);
      res.destroy();
      resolve();
    }, timeoutMs);
    const onDrain = () => {
      clearTimeout(timer);
      resolve();
    };
    res.once("drain", onDrain);
  });
}
