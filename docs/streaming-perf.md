# Streaming performance — load run results

**Procedure:** `npm run load` (`scripts/streaming-load.ts`). Offline mock model,
fixture corpus, single process, one core — so these numbers measure the
*streaming machinery* (graph, event layer, zod validation, SSE framing, ring
buffer), not a model provider. Recorded 2026-08 on the CI-class container used
for development; absolute numbers vary by host, the shape is the finding.

Run with `NODE_OPTIONS=--expose-gc npm run load` for precise post-run heap
numbers (unforced `heapUsed` overstates retention — V8 collects lazily).

## Results

### SLO pass — 25 concurrent connections × 10 s (gate: zero errors)

| Metric | Value |
| --- | --- |
| Turns/sec (mean) | 144 |
| Full-stream latency p50 / p97.5 / p99 | 163 ms / 199 ms / 633 ms |
| Errors / timeouts | **0 / 0** |

### Saturation probe — 100 concurrent connections × 10 s (report-only)

| Metric | Value |
| --- | --- |
| Turns/sec (mean) | 164 |
| Full-stream latency p50 / p97.5 / p99 | 385 ms / 2.6 s / 6.6 s |
| Timeouts (10 s client limit) | 23 of 1,659 |
| rss under load | 257 MB |

Throughput barely rises from 25 → 100 connections (144 → 164 turns/sec) while
tail latency multiplies by ~10×: the single core saturates at roughly **150–165
turns/sec**, and extra concurrency past that point buys queueing, not
throughput. The probe's timeouts are that queue exceeding the client's 10 s
limit — a capacity ceiling, not a defect. Production sizing: stay near 25-way
concurrency per core for a sub-second p99, scale horizontally (the resume
buffer's multi-node caveat, contract R6, applies).

### TTFB — time to first token event (the latency a user feels)

| Scenario | p50 | p99 | max |
| --- | --- | --- | --- |
| Unloaded, 50 sequential streams | **7.4 ms** | 508 ms | 508 ms |
| 100-way cold burst (all at once) | 379 ms | 696 ms | 696 ms |

The unloaded p99 is a single outlier sample (one ~500 ms hiccup in 50 —
first-run JIT/GC); the p50 is the honest steady-state. The burst number is the
worst case by construction: every stream fired simultaneously at one core, so
the last stream's first token waits behind ~99 other turns.

Measurement note: autocannon's "latency" for an SSE response is time to *last*
byte (full stream duration) — throughput signal. TTFB is sampled by a
hand-rolled reader that timestamps the first `event: token` frame, because the
first token is what the user perceives as responsiveness.

### Memory and leak checks

| Check | Result |
| --- | --- |
| rss before → under load → settled | 199 MB → 257 MB → 260 MB |
| Heap growth over ~3,100 turns (post-GC) | **−10 MB** (nothing retained) |
| Open server connections after settle | **0** |
| `MaxListenersExceededWarning` | none (also asserted in CI, `tests/sseServer.test.ts`) |

~3,100 turns with per-request random `threadId`s exercised the ring buffer's
LRU across far more than its 256-thread cap; post-GC heap returning below the
starting point confirms eviction works and nothing accumulates per stream. The
settle wait is deliberately longer than undici's 4 s keep-alive idle timeout so
the connection count measures the server, not the sampler's client pool.

## What this run does not measure

Real model latency (the mock answers in microseconds — with a real provider,
TTFB is dominated by the provider's own first-token time and this machinery
adds single-digit milliseconds); multi-core scaling (one process by design);
behaviour behind real proxies (contract §13); sustained multi-hour soak.
