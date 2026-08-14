import autocannon from "autocannon";
import { createCopilotServer } from "../src/server";
import { createCopilot } from "../src/graph/copilot";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { CORPUS } from "../src/fixtures/corpus";
import type { AddressInfo } from "node:net";

/**
 * Phase 5 load run (`npm run load`). Not part of CI — the numbers depend on the
 * host — but the procedure is fixed so runs are comparable. Results are
 * recorded in docs/streaming-perf.md.
 *
 * Two measurements, deliberately separate:
 *  1. autocannon: sustained concurrency. Its "latency" for an SSE response is
 *     time-to-LAST-byte (full stream duration), which is throughput signal.
 *  2. A hand-rolled sampler for TTFB (time-to-first-TOKEN-event): autocannon
 *     cannot see inside the stream, and the first token is the latency a user
 *     actually feels.
 */

/** SLO pass: must complete with zero errors/timeouts. */
const SLO_CONNECTIONS = 25;
/** Saturation probe: report-only — timeouts here mark the ceiling, not a bug. */
const SATURATION_CONNECTIONS = 100;
const DURATION_S = 10;
const TTFB_SEQUENTIAL_SAMPLES = 50;
const TTFB_BURST_SAMPLES = 100;
/** Past undici's 4s keep-alive idle timeout, so client-pool sockets close and
 *  the post-run connection count measures the SERVER, not the sampler. */
const SETTLE_MS = 6_000;

const BODY = JSON.stringify({
  query: "explain photosynthesis",
  scope: { orgId: "acme", userId: "load-user" },
});

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
  const server = createCopilotServer({ copilot });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const memBefore = process.memoryUsage();
  console.log(`server up on :${port} — rss ${mb(memBefore.rss)}, heap ${mb(memBefore.heapUsed)}`);

  // --- 1. sustained concurrency -------------------------------------------
  const cannon = (connections: number) =>
    autocannon({
      url: `${url}/v1/chat`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
      connections,
      duration: DURATION_S,
    });
  const report = (label: string, r: autocannon.Result) => {
    console.log(`\n${label}`);
    console.log(`  requests/sec  p50 ${r.requests.p50}  mean ${r.requests.mean}`);
    console.log(
      `  full-stream latency (ms)  p50 ${r.latency.p50}  p97_5 ${r.latency.p97_5}  p99 ${r.latency.p99}  max ${r.latency.max}`,
    );
    console.log(`  responses ${r["2xx"]}  errors ${r.errors}  timeouts ${r.timeouts}`);
  };

  const slo = await cannon(SLO_CONNECTIONS);
  report(`SLO pass — ${SLO_CONNECTIONS} connections × ${DURATION_S}s (gate: zero errors)`, slo);

  const saturation = await cannon(SATURATION_CONNECTIONS);
  const memPeak = process.memoryUsage();
  report(
    `saturation probe — ${SATURATION_CONNECTIONS} connections × ${DURATION_S}s (report-only)`,
    saturation,
  );
  console.log(`  memory under load  rss ${mb(memPeak.rss)}  heap ${mb(memPeak.heapUsed)}`);

  // --- 2. TTFB: time to first token event ---------------------------------
  const sampleTtfb = async (): Promise<number> => {
    const t0 = performance.now();
    const res = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before a token event");
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes("event: token")) {
        const ttfb = performance.now() - t0;
        await reader.cancel();
        return ttfb;
      }
    }
  };
  const pctOf = (xs: number[], p: number) =>
    xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

  // Unloaded: what one user feels on an idle server.
  const sequential: number[] = [];
  for (let i = 0; i < TTFB_SEQUENTIAL_SAMPLES; i++) sequential.push(await sampleTtfb());
  sequential.sort((a, b) => a - b);
  console.log(`\nTTFB unloaded (${TTFB_SEQUENTIAL_SAMPLES} sequential streams)`);
  console.log(
    `  ttfb (ms)  p50 ${pctOf(sequential, 50).toFixed(1)}  p99 ${pctOf(sequential, 99).toFixed(1)}  max ${sequential.at(-1)!.toFixed(1)}`,
  );

  // Cold burst: every stream fired at once at one core — the last stream's
  // first token waits behind ~all the others' turns. Worst-case, not typical.
  const burst = await Promise.all(Array.from({ length: TTFB_BURST_SAMPLES }, sampleTtfb));
  burst.sort((a, b) => a - b);
  console.log(`TTFB under ${TTFB_BURST_SAMPLES}-way cold burst`);
  console.log(
    `  ttfb (ms)  p50 ${pctOf(burst, 50).toFixed(1)}  p99 ${pctOf(burst, 99).toFixed(1)}  max ${burst.at(-1)!.toFixed(1)}`,
  );

  // --- 3. settle and check for retained memory / stuck connections --------
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  // Unforced heapUsed overstates retention (V8 collects lazily). Run with
  // NODE_OPTIONS=--expose-gc for the precise number; without it, rss is the
  // honest ceiling and heap growth is an upper bound.
  (globalThis as { gc?: () => void }).gc?.();
  const open = await new Promise<number>((resolve, reject) =>
    server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
  );
  const memAfter = process.memoryUsage();
  console.log(`\nafter settle  rss ${mb(memAfter.rss)}  heap ${mb(memAfter.heapUsed)}  open connections ${open}`);
  console.log(
    `heap growth over run: ${mb(memAfter.heapUsed - memBefore.heapUsed)} (ring buffer retains up to 512 events/thread by design)`,
  );

  server.close();
  if (slo.errors > 0 || slo.timeouts > 0) {
    console.error(`LOAD RUN FAILED: SLO pass at ${SLO_CONNECTIONS} connections had errors/timeouts`);
    process.exit(1);
  }
  console.log("LOAD RUN OK (saturation-probe timeouts, if any, mark the ceiling and are reported above)");
}

void main();
