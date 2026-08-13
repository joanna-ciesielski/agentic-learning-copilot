# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-12 · **Current phase:** Phase 2 (Graph event stream) — delivered, awaiting DoD confirmation

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | **Signed off.** Merged (or merging) via PR from `phase-0/streaming-contract`. |
| 1 — Streaming ChatModel | **Signed off** (senior review applied: early-close leak fixed, TierSchema two-way drift guard). Merged via PR from `phase-1/streaming-chatmodel`. |
| 2 — Graph event stream | **Delivered, awaiting DoD confirmation.** Branch `phase-2/graph-event-stream`, stacked on Phase 1. |
| 3 — SSE server | Not started. Blocked on Phase 2 sign-off. |
| 4 — Demo client & state management | Not started. |
| 5 — Hardening & load | Not started. |
| 6 — Docs & portfolio assets | Not started. |

Canonical remote: `github.com/joanna-ciesielski/agentic-learning-copilot` (the
hyphenated account; its `main` was force-updated to the complete history on
2026-08-12 — the `JoannaCiesielski` copy is stale and slated for archiving).

## 2. What Phase 2 added

| File | Change |
| --- | --- |
| `src/streaming/payloads.ts` | New. Pre-envelope node payloads (`route`/`citation`/`token`/`note`), `TurnStreamSink`, `sinkOf(config)`. Nodes are envelope-ignorant by design. |
| `src/streaming/chunking.ts` | `indexedChunks` — grapheme chunks with contiguous ordinals (structural type to avoid a cycle with `chatModel`). |
| `src/agents/verticalAgent.ts` | Optional `sink` param on `run()`. Citations emitted BEFORE the answer call (S3); answer streamed via the gateway; empty-retrieval canned answer replayed as chunks (parity covers that branch); batch-only-gateway fallback replay. |
| `src/graph/build.ts` | Nodes take `(state, config)` and emit payloads via LangGraph's custom-mode writer when present; `noted()` keeps streamed notes and state notes from one array. `ask()` behaviour unchanged (no writer under `invoke()`). |
| `src/graph/copilot.ts` | `stream(req, opts)` — envelope + monotonic `seq` applied in one place; every event zod-validated before yield; pre-flight gates extracted to `preflightDecline()` shared with `ask()`; `declineAnswer()` makes P2 structural; error taxonomy mapping; sha256/bytes/tokenCount witnesses on `done`; tracer/profile/rate-limit side effects mirror `ask()`. |
| `docs/adr/0008-sse-streaming.md` | Addendum recorded: custom stream mode chosen over `messages` mode and Tracer transport, with probe evidence. |
| `docs/plans/streaming-plan.md` | Stale repo URL corrected to the hyphenated account. |
| `tests/streamingCopilot.test.ts` | 23 e2e tests, written first: P1 over every routing fixture + Arabic; P2 decline parity (verbatim message equality); S1–S8 sequencing; budget-kill in the router→answer window; mid-stream provider failure → `partial:true`; tenant markers; tracer mirroring; threadId validation; injectable clock. |

## 3. Baseline (verified 2026-08-12)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 21 files, 243 tests (108 pre-existing untouched)
npm run test:coverage
#   Statements 98.42%  Branches 89.44%  Functions 98.88%  Lines 99.24%
```

Remaining uncovered lines are deliberate: the `if (!out)` defensive throw in
`stream()` (unreachable via public API), the `BUDGET_EXCEEDED partial:true`
branch (unreachable by construction — see contract §5), and `sinkOf`'s
non-function-writer arm.

## 4. Design decisions made during Phase 2

1. **Custom stream mode, not `messages` mode, not the Tracer.** Full rationale
   and probe evidence in the ADR 0008 addendum. Key operational fact: cross-mode
   ordering between `custom` and `values` chunks is NOT guaranteed, so `usage`/
   `done` are emitted only after the graph stream drains.
2. **One compiled graph, two delivery modes.** Nodes guard every emission on
   `sinkOf(config)`; under `invoke()` there is no writer, so `ask()` runs the
   byte-identical pre-streaming path. No second graph, no second policy path.
3. **P2 is structural.** `declineAnswer()` is the single source of the decline
   wording; `ask()` returns it, `stream()` carries it on the error event. The
   parity test asserts strict string equality against a separately-built copilot.
4. **`stream()` never throws once events flow** (except invalid `threadId`,
   which throws before the first event). Unexpected errors become terminal
   `UPSTREAM_ERROR` events with a generic message; detail goes to the tracer.
   This is a documented divergence from `ask()`, which rethrows.
5. **Empty retrieval streams the canned answer.** `ask()` returns it with
   `declined:false`, so P1 applies — the agent replays it via `indexedChunks`
   with no model call and no citation event.
6. **Every outbound event is schema-validated.** Cheap at mock scale; if Phase 5
   load runs show it hot, make it opt-out there with the measurement in hand.

## 5. Open item carried to Phase 3

Consumer `break` on `Copilot.stream()` propagates close through the graph
stream, and the gateway's `finally` releases reservation + closes the provider
stream (Phase 1's fix). What Phase 3 must add: the HTTP layer's client-abort →
`AbortSignal` → graph cancellation, asserted by mock call counts (no orphaned
model calls between nodes).

## 6. Next action — Phase 3 (SSE server)

Do not start until Phase 2's DoD is confirmed.

1. Branch `phase-3/sse-server` off `phase-2/graph-event-stream`.
2. Write the transport tests first with real HTTP (`node:http` + `fetch` +
   manual `ReadableStream` SSE parsing, no client lib): framing, heartbeat,
   resume-within-buffer, resume-after-eviction (`RESUME_GAP`), abort-cancels-run.
3. `src/server/sse.ts` (framing + ring buffer + backpressure per contract §§7–9,
   11) and `src/server/index.ts` (`POST /v1/chat` on `node:http`).
4. Constants already in the contract: heartbeat 15s, ring 512×256 LRU,
   `retry: 2000`, headers incl. `X-Streaming-Contract-Version: 1.0`.
5. Heartbeats: full envelope, no `id:` line, never buffered (§8).
6. `npm run serve` script; zero new runtime dependencies.

## 7. Commands to resume

```bash
git checkout phase-2/graph-event-stream
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage

# Phase 3 starts here
git checkout -b phase-3/sse-server

# Streaming suites alone
npx vitest run tests/streamingContract.test.ts tests/streamingParity.test.ts \
  tests/streamingGateway.test.ts tests/streamingCopilot.test.ts
```

## 8. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
