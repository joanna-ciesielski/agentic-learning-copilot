# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-13 · **Current phase:** Phase 3 (SSE server) — delivered, awaiting DoD confirmation

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | Merged to `main`. |
| 1 — Streaming ChatModel | Merged to `main`. |
| 2 — Graph event stream | Merged to `main` (`c72fabe`). |
| 3 — SSE server | **Delivered, awaiting DoD confirmation.** Branch `phase-3/sse-server`. |
| 4 — Demo client & state management | Not started. Blocked on Phase 3 sign-off. |
| 5 — Hardening & load | Not started. |
| 6 — Docs & portfolio assets | Not started. |

Canonical remote: `github.com/joanna-ciesielski/agentic-learning-copilot`.
Delivery is by git bundle until the repo is added to the sandbox session's
authorized sources (pushes 403 otherwise).

## 2. What Phase 3 added

| File | Change |
| --- | --- |
| `src/server/ringBuffer.ts` | `ThreadRingBuffer` — per-thread replay buffer, LRU across threads. Gap rule is `lastEventId < evictedThrough`, NOT seq contiguity (heartbeats make buffered seqs non-contiguous). |
| `src/server/sse.ts` | Framing per contract §9 (single `data:` line; heartbeats without `id:`), headers, `retry:` once, `awaitDrain` backpressure with disconnect-on-stall. |
| `src/server/index.ts` | `createCopilotServer` — `POST /v1/chat` on `node:http`. Body validation (strict zod, 64 KiB cap → 413), Last-Event-ID resume, R7 dead-turn close, R8 buffer reset, client abort → `AbortSignal`. |
| `src/server/cli.ts` | `npm run serve` — offline demo server (mock model, 15 ms chunk delay, fixture corpus incl. Arabic). |
| `src/graph/copilot.ts` | `StreamOptions.heartbeatMs` (heartbeats minted in the EVENT layer — they consume `seq` from the stream's single counter) and `StreamOptions.signal` (threaded to `graph.stream` config; on abort the stream stops with no terminal event). Pull loop rewritten as race-with-heartbeat; graph iterator explicitly closed in `finally`. |
| `docs/streaming-contract.md` | R7 (dead-turn resume closes with terminal error) and R8 (fresh POST resets the thread's logical stream) — additive, wire schema unchanged. |
| `package.json` / `vitest.config.ts` | `serve` script; `src/server/cli.ts` added to the coverage excludes alongside the other CLIs. |
| `tests/sseServer.test.ts` | 23 tests over real HTTP (fetch + manual SSE parsing, no client lib): framing/headers, transport-level byte parity, 400/404/405/413, resume within buffer, RESUME_GAP on eviction and unknown thread, R5, R7, R8, heartbeats (no `id:`, never buffered, seq stays monotonic), abort-cancels-run by model call counts, ring-buffer LRU + drain units. |

## 3. Baseline (verified 2026-08-13)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 22 files, 266 tests (108 pre-existing untouched)
npm run test:coverage
#   Statements 97.8%  Branches 88.72%  Functions 98.57%  Lines 98.99%
npm run serve       # POST /v1/chat on :3000, offline
```

Uncovered remainder in `src/server/index.ts` is the in-loop backpressure branch
(needs a genuinely slow client — `awaitDrain` itself is unit-tested) and the
top-level late-failure catch; both are Phase 5 probe targets per the plan's
failure catalog.

## 4. Design decisions made during Phase 3

1. **Heartbeats are minted by the event layer, not the transport.** Audit
   finding: heartbeats carry the envelope (fixed decision 3) and therefore
   consume a `seq` — but the seq counter lives in `Copilot.stream()`. A
   transport-minted heartbeat would race the next live event's seq and break
   strict monotonicity. So `StreamOptions.heartbeatMs` races the graph pull
   against a timer inside `stream()`; the transport merely writes heartbeats
   without `id:` and skips buffering them. The pending graph pull is REUSED
   across heartbeats (a heartbeat must not abandon or double-pull the graph).
2. **Gap detection is `evictedThrough`, not seq contiguity.** Buffered seqs are
   legitimately non-contiguous (heartbeats consume seq without being buffered),
   so a contiguity check would false-positive RESUME_GAP. The buffer tracks the
   highest evicted seq per thread instead.
3. **R7 — dead-turn resume.** The plan's resume text assumed a live turn to
   rejoin; an aborted turn has none. Replay-then-hang was unacceptable, so an
   incomplete replay is closed with a terminal `UPSTREAM_ERROR` that is itself
   buffered. Recorded in the contract as an additive clarification.
4. **R8 — fresh POST resets the thread buffer.** Without it, two logical
   streams' seq sequences would interleave in one buffer and resume semantics
   would be undefined.
5. **Abort is `AbortSignal` through graph config, not just iterator close.**
   LangGraph executes ahead of consumption (push-based queue), so closing the
   consumer iterator alone does not stop the run — the signal does, checked by
   LangGraph between tasks. Proven by the call-count test: abort during a slow
   routing call → answer model is never invoked. On abort, `stream()` emits no
   terminal event (the consumer is gone) and ends silently.
6. **413 drains rather than destroys.** Destroying the socket mid-upload
   surfaces as a connection error client-side; the server now discards past the
   cap and answers a clean 413 (memory still bounded).

## 5. Next action — Phase 4 (demo client & state management)

Do not start until Phase 3's DoD is confirmed.

1. Branch `phase-4/demo-client` off `phase-3/sse-server`.
2. `demo/client.html` — single self-contained file, vanilla JS, no build step.
   The six labeled patterns from the plan: rAF-batched render loop decoupled
   from event ingestion; per-frame token coalescing (single text-node update);
   monotonic seq guard; reconnect/resume via Last-Event-ID (note: fetch-based
   SSE — the endpoint is POST, so EventSource does not apply; hand-roll the
   reader + reconnect); latency HUD (tokens/sec, events/sec, frame time,
   dropped frames); stress mode.
3. Stress mode needs a server flag streaming synthetic events at 1–5k
   events/sec — add a `/v1/stress` route or query flag to `src/server` in this
   phase (transport-only; no copilot involvement), per the plan.
4. `docs/demo.md` with the manual script and expected numbers; screenshot/gif
   for the portfolio card.

## 6. Commands to resume

```bash
git checkout phase-3/sse-server
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage
npm run serve

git checkout -b phase-4/demo-client

npx vitest run tests/sseServer.test.ts
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
