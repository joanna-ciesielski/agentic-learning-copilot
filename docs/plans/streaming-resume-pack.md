# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-12 · **Current phase:** Phase 1 (Streaming ChatModel) — delivered, awaiting DoD confirmation

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | **Signed off.** Branch `phase-0/streaming-contract`, not yet merged. |
| 1 — Streaming ChatModel | **Delivered, awaiting DoD confirmation.** Branch `phase-1/streaming-chatmodel`, stacked on Phase 0. |
| 2 — Graph event stream | Not started. Blocked on Phase 1 sign-off. |
| 3 — SSE server | Not started. |
| 4 — Demo client & state management | Not started. |
| 5 — Hardening & load | Not started. |
| 6 — Docs & portfolio assets | Not started. |

Neither branch is pushed: the sandbox git proxy denies credentials for
`JoannaCiesielski/agentic-learning-copilot` until the repo is added to the
session's authorized sources. Both phases were delivered as `git apply` patches
in the meantime.

## 2. What has landed

**Phase 0 — contract & ADR (branch `phase-0/streaming-contract`)**

| File | Purpose |
| --- | --- |
| `docs/plans/streaming-plan.md` | The build plan, verbatim. |
| `docs/streaming-contract.md` | Contract v1.0, status **accepted**. Envelope, catalog, sequencing S1–S8, parity P1–P3, error taxonomy, resume R1–R6, Unicode U1–U4, SSE binding, §14 decisions. |
| `docs/adr/0008-sse-streaming.md` | SSE vs WebSockets vs long-poll; native `http` vs framework; ring buffer vs persistent log. |
| `src/streaming/events.ts` | Contract-as-code: strict zod schemas, types, constants. No behaviour. |
| `tests/streamingContract.test.ts` | Catalog shape + drift guards. |

**Phase 1 — streaming ChatModel (branch `phase-1/streaming-chatmodel`)**

| File | Change |
| --- | --- |
| `src/streaming/chunking.ts` | New. `chunkByGraphemes` — lossless, grapheme-safe, deterministic. The load-bearing piece of parity. |
| `src/llm/chatModel.ts` | `TokenChunk`; optional `streamComplete?` on `ChatModel`; `StreamingChatModel`; `isStreamingChatModel`; `streamOrFallback`; `MockChatModel` streaming + `MockChatModelOptions`. `complete()` untouched. |
| `src/llm/modelGateway.ts` | `streamComplete()` on the gateway, sharing `cacheHit`/`reserve`/`release`/`settle` with `complete()`. `isStreamingGateway`, `StreamingModelGateway`, `GatewayServices.streamChunkSize`. |
| `src/index.ts` | Exports for both phases' new surface. |
| `tests/streamingParity.test.ts` | **P1 parity**, written before the implementation. Byte-equality over the full corpus, the Arabic fixtures, and eleven Unicode edge cases × seven chunk sizes. |
| `tests/streamingGateway.test.ts` | Accounting parity: reservation, release, cache, metrics, tenant namespacing, non-streaming fallback. |

## 3. Baseline (verified 2026-08-12)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 20 files, 220 tests
npm run test:coverage
#   Statements 98.5%  Branches 90.48%  Functions 98.83%  Lines 99.3%
#   thresholds: 85 across the board
```

Per-file coverage on everything Phase 1 added or changed — `chunking.ts`,
`events.ts`, `chatModel.ts`, `modelGateway.ts` — is **100% / 100% / 100%**,
against a DoD floor of 90%.

The 108 pre-existing tests are untouched: `git diff main -- tests/` shows new
files only, no modifications.

## 4. Design decisions made during Phase 1

Recorded here because they are not in the plan and the next session will
otherwise re-litigate them.

1. **Grapheme chunking, not tokenizer chunking.** The plan says "tokenizer-based
   chunking". The repo's `tokenize()` splits on `[^\p{L}\p{N}]+` and **discards
   the separators**, so rejoining its output loses every space and newline —
   parity would fail on the first fixture. `chunkByGraphemes` segments with
   `Intl.Segmenter` instead. Same bug class ADR 0007 fixed one layer down.
2. **`streamComplete` is optional on both interfaces.** Adding a required method
   to `ChatModel`/`ModelGateway` would break any implementer. `streamOrFallback`
   degrades a non-streaming provider to one chunk carrying the whole answer, so
   parity holds trivially rather than being unavailable.
3. **The generator's return value is the settled `CompletionResult`.**
   `AsyncGenerator<TokenChunk, CompletionResult>` — a `for await` consumer sees
   only chunks; Phase 2 drives `.next()` manually to get usage. No side channel.
4. **The gateway's `finally` closes TWO leaks, in order.** A consumer that
   `break`s out of the stream triggers the generator's `return`, which lands in
   `finally`. First the budget reservation is released (otherwise an aborted
   client leaves the org permanently short); then the upstream source generator
   is explicitly closed — a manual `.next()` loop does not propagate close the
   way `for await` does, so without `source.return()` the provider keeps
   generating tokens nobody reads. The release comes first so a failing provider
   cleanup can never skip it. Both paths have regression tests; this is the
   model-layer half of Phase 3's abort-cancels-run assertion.
5. **`complete()` and `streamComplete()` share private helpers.** `cacheHit`,
   `reserve`, `release`, `settle`. Streaming is a delivery mechanism, not a
   second accounting path — there is no route through the gateway that spends
   tokens without a reservation, a reconciliation and a metric. This refactored
   `complete()`'s internals; behaviour is unchanged, proven by the 108
   pre-existing tests staying green.
6. **Pinned locale on the segmenter.** `new Intl.Segmenter("en", …)` rather than
   the runtime default, so a CI machine's locale cannot shift chunk boundaries
   and make streamed output non-reproducible.

## 5. Next action — Phase 2 (graph event stream)

Do not start until Phase 1's DoD is confirmed.

1. Branch `phase-2/graph-event-stream` off `phase-1/streaming-chatmodel`.
2. **Open with the 1h LangGraph spike** the plan's risk register calls for: does
   `@langchain/langgraph` v1.4.8 expose a usable token-level stream, or do events
   come from the existing `Tracer` seam? Record the answer as the ADR 0008
   addendum — the stub for it is already at the bottom of that file.
3. Write the e2e parity test first: `concat(token events) === ask().answer` for
   every routing fixture, plus the Arabic ones.
4. Then `Copilot.stream(req): AsyncIterable<CopilotEvent>` beside `ask()`,
   emitting `route` → `citation` → `token`* → `usage` → `done` per contract
   §4 S1–S8.
5. Guards: pre-flight declines emit a single terminal `error` whose `message`
   equals `ask().answer` verbatim (contract P2) and no other events.
6. **Budget-kill test targets the router→answer window, not mid-token.**
   Pre-flight reservation reserves the whole answer before the first chunk, so a
   mid-answer kill is unreachable by construction. A test that tries would pass
   for the wrong reason. See contract §5.
7. Also required by the Phase 2 DoD: tenant-isolation streaming test reusing
   `TENANT_MARKERS`, and a strictly-monotonic `seq` test.

## 6. Commands to resume

```bash
git checkout phase-1/streaming-chatmodel
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage

# Phase 2 starts here
git checkout -b phase-2/graph-event-stream

# The parity tests, run alone
npx vitest run tests/streamingParity.test.ts tests/streamingGateway.test.ts
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
