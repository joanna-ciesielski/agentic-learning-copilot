# Build Plan — Streaming Layer for agentic-learning-copilot (Plan A, v1.0)

Prepared 2026-08-12. Target repo: github.com/joanna-ciesielski/agentic-learning-copilot (verified against `main` as of 2026-08-12: no HTTP server, no streaming anywhere in `src/`; entry points are the library exports in `src/index.ts` and `src/cli.ts`; runtime deps are only `@langchain/core`, `@langchain/langgraph`, `zod`).

## Purpose

Close the two loudest portfolio gaps in one upgrade: (1) SSE streaming APIs for agentic systems, (2) client-side state management under high-frequency updates. After this build, the repo demonstrates a production-shaped streaming path end to end: LangGraph supervisor → token stream → SSE endpoint → demo client that stays at 60fps under stress. This directly answers the "AI & Streaming Architecture Review" bullet in healthcare-AI advisory postings.

**Effort budget: 25–40 hours across 7 phases.** Each phase lands as its own PR with green CI before the next starts (same discipline as Build Plan v2).

## Fixed decisions — do not re-open without new evidence

1. **SSE over WebSockets.** Server→client is unidirectional; SSE gives auto-reconnect + Last-Event-ID for free, traverses proxies/LBs as plain HTTP, and is what the target advisory market asks about. WebSockets documented as the swap for bidirectional needs (ADR).
2. **Native `node:http`, zero new runtime dependencies.** The repo's credibility is its 3-dependency discipline. SSE framing is ~50 lines; a framework would dilute the demonstration. Fastify/Hono documented as production swaps.
3. **Named event types, JSON payloads.** `route`, `token`, `citation`, `usage`, `note`, `done`, `error`, `heartbeat`. Every event carries `{seq, threadId, ts}`. The event contract is versioned in `docs/streaming-contract.md` v1.0 — it is the interface other modules (and the demo client) depend on; changes require a version bump.
4. **Resume via per-thread ring buffer.** Bounded (default 512 events/thread, LRU across threads); `Last-Event-ID` replays from `seq+1` if still buffered, else emits `resume_gap` and restarts cleanly. No persistence — documented Postgres/Redis swap.
5. **Streamed output must equal non-streamed output.** Parity is a CI-gated invariant, not a hope: `concat(tokens) === copilot.run(...).answer` for every fixture case.
6. **Existing guards apply mid-stream.** BudgetLedger, rate caps, relevance guard, tenant isolation — all enforced during streaming. A budget exhausted mid-stream terminates with a typed error event (`code: BUDGET_EXCEEDED`), never a silent hang.
7. **Mock-first, offline-first.** MockChatModel gains deterministic token streaming (fixed chunking, zero timers in tests) so the whole streaming path runs offline in CI exactly like the rest of the repo.

## Phase 0 — Contract & ADR (2–3h)

- `docs/streaming-contract.md` v1.0: event catalog with JSON schemas (zod, exported from `src/streaming/events.ts`), sequencing rules, resume semantics, heartbeat cadence (15s), error taxonomy (`BUDGET_EXCEEDED`, `RATE_LIMITED`, `IRRELEVANT_QUERY`, `UPSTREAM_ERROR`, `RESUME_GAP`).
- `docs/adr/0008-sse-streaming.md`: SSE vs WebSockets vs HTTP long-poll; native `http` vs framework; ring-buffer resume vs persistent log.
- **DoD:** contract reviewed against all fixed decisions; zod schemas compile; no code yet.

## Phase 1 — Streaming ChatModel (3–5h)

- Extend `ChatModel` with `streamChat(messages): AsyncIterable<TokenChunk>`; keep `chat()` intact (non-breaking — all 108 existing tests must stay green untouched).
- `MockChatModel`: deterministic tokenizer-based chunking of the canned Responder output; configurable chunk size; **no `setTimeout` in test mode** (pure async iteration) so tests stay fast and deterministic.
- Token accounting: streamed chunks feed the same `estimateTokens`/`BudgetLedger` path as non-streamed calls; reservation happens pre-flight (reuse the concurrency-safe reservation — the check-then-act race fix must hold under streaming).
- **DoD:** parity test at the model layer (`concat(chunks) === chat().content`) across all fixtures incl. multilingual (Arabic — the Unicode tokenizer bug class must have a streaming regression test); coverage of new code ≥ 90%.

## Phase 2 — Graph event stream (4–6h)

- `Copilot.stream(request): AsyncIterable<CopilotEvent>` beside `run()`. Emit `route` after supervisor, `token` from the active vertical agent via streamed synthesis, `citation` batch after retrieval, `usage`/`note`/`done` at close. Wire through LangGraph's streaming (or the existing Tracer seam — decide in-phase, record in ADR 0008 addendum).
- Guards: relevance guard rejects before any token (typed error event); budget cutoff mid-iteration terminates the iterable cleanly; tenant scope threaded through unchanged.
- **DoD:** e2e parity test (`concat(token events) === run().answer` for every routing fixture); tenant-isolation streaming test (tenant A's stream never contains tenant B markers — reuse `TENANT_MARKERS`); mid-stream budget-kill test; event `seq` strictly monotonic test.

## Phase 3 — SSE server (4–6h)

- `src/server/sse.ts` + `src/server/index.ts` on `node:http`. `POST /v1/chat` (JSON body: `query`, `scope`, `cohort`, `threadId`) → `text/event-stream` response. Correct framing (`event:`/`data:`/`id:`), `retry:` hint, heartbeat comments every 15s, `X-Accel-Buffering: no`.
- Backpressure: respect `res.write()` return + `drain`; slow-client policy = buffer up to N events then terminate with typed error (documented).
- Resume: ring buffer per `threadId`; honor `Last-Event-ID`.
- Lifecycle: client abort → `AbortSignal` cancels the graph run (no orphaned model calls — assert via mock call counts); server close drains gracefully.
- **DoD:** integration tests with real HTTP (node `fetch` + `ReadableStream` parsing, no SSE client lib); tests for resume-within-buffer, resume-after-eviction (`resume_gap`), heartbeat, abort-cancels-run; `npm run serve` script.

## Phase 4 — Demo client & state management (5–8h)

- `demo/client.html` — single self-contained file (repo ethos), no build step, vanilla JS.
- The teaching artifact for render-lag prevention, each pattern labeled in-code:
  1. Event ingestion decoupled from render: events append to a buffer; render loop flushes on `requestAnimationFrame` (bounded to one DOM commit per frame).
  2. Batched token coalescing (string-builder per frame, single text-node update — no per-token DOM writes).
  3. Monotonic `seq` handling + out-of-order guard.
  4. Reconnect/resume UX via `Last-Event-ID`.
  5. Latency HUD: tokens/sec, events/sec, frame time, dropped-frame counter.
  6. **Stress mode:** server flag streams synthetic events at 1–5k events/sec to demonstrate the HUD staying at ~60fps with batching ON and degrading with it OFF (the before/after is the demo).
- **DoD:** manual script in `docs/demo.md` with expected numbers; screenshot/gif for the portfolio card.

## Phase 5 — Hardening & load (3–5h)

- `autocannon` (devDependency) load run: 100 concurrent streams against mock model; record p50/p99 TTFB (time-to-first-token) and memory ceiling in `docs/streaming-perf.md`; assert no listener leaks.
- Failure catalog additions (extend the 10-mode catalog): slow client, mid-stream provider failure, resume storm, heartbeat-only idle connection, duplicate `Last-Event-ID`.
- **DoD:** all failure modes have a test or documented manual probe; CI green Node 20 & 22; coverage gate unchanged (≥85% branch on new modules, ≥89% overall).

## Phase 6 — Docs & portfolio assets (2–4h)

- Update `docs/architecture.md` + regenerate architecture diagram (streaming path highlighted); README quickstart (`npm run serve` → open demo); `docs/application-note.md` new section "Streaming & client state under load" with the stress-mode numbers; refresh portfolio entry copy.
- **DoD:** a stranger can clone → `npm i` → `npm run serve` → see tokens stream and the stress demo in <5 minutes.

## Risk register

- LangGraph.js streaming API surface may differ from expectation at v1.4.8 → Phase 2 opens with a 1h spike; fallback is emitting via the existing Tracer seam (already designed for events).
- SSE buffering by intermediaries in real deployments → documented, `X-Accel-Buffering` set, heartbeats cover; out of scope to test behind real proxies.
- Scope creep toward auth/multi-node → explicitly out of scope; documented as production swaps (sticky sessions or Redis pub/sub for multi-node resume).

## Definition of done (project)

All phase DoDs; 108 pre-existing tests untouched and green; parity + isolation + budget-kill invariants CI-gated; demo reproducible offline; ADR 0008 + contract v1.0 published; portfolio assets refreshed.
