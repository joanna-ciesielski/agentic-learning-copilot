# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything.

**Last updated:** 2026-08-12 · **Current phase:** Phase 0 (Contract & ADR) — delivered, awaiting review

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | **Delivered, under review.** Not yet merged. |
| 1 — Streaming ChatModel | Not started. Blocked on Phase 0 sign-off. |
| 2 — Graph event stream | Not started. |
| 3 — SSE server | Not started. |
| 4 — Demo client & state management | Not started. |
| 5 — Hardening & load | Not started. |
| 6 — Docs & portfolio assets | Not started. |

Branch for this changeset: `phase-0/streaming-contract`.

## 2. What Phase 0 added

| File | Purpose |
| --- | --- |
| `docs/plans/streaming-plan.md` | The build plan, verbatim. Its Fixed Decisions are binding. |
| `docs/streaming-contract.md` | Contract v1.0: envelope, catalog, sequencing S1–S8, parity P1–P3, taxonomy, resume R1–R6, Unicode U1–U4. |
| `docs/adr/0008-sse-streaming.md` | Rationale: SSE vs WebSockets vs long-poll; native `http` vs framework; ring buffer vs persistent log. |
| `src/streaming/events.ts` | Contract-as-code: zod schemas, types, constants. No behaviour. |
| `tests/streamingContract.test.ts` | Shape + drift guards for the catalog. 17 tests. |
| `docs/plans/streaming-resume-pack.md` | This file. |

No behavioural code, no server, no changes to any existing file.

## 3. Baseline (verified 2026-08-12)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 18 files, 125 tests (108 pre-existing + 17 new)
npm run test:coverage
#   Statements 98.16%  Branches 89.3%  Functions 98.73%  Lines 99.22%
#   thresholds: 85 across the board
```

The 108 pre-existing tests are untouched and green. `src/streaming/events.ts` is
fully covered by the contract test, so it does not drag the global coverage gate.

## 4. Open decisions — need a call before Phase 1

Full detail in §14 of `docs/streaming-contract.md`. Summary:

1. **Method names.** Plan says `Copilot.run()` / `ChatModel.chat()`; repo has
   `Copilot.ask()` / `ChatModel.complete()`. Proposed: `Copilot.stream()` and
   `ChatModel.streamComplete()`. **Needs sign-off** — it fixes the names used
   from Phase 1 onward.
2. **`answerSha256` on `done`** — addition beyond the plan. Proposed: keep.
3. **`score` on `done`** — nest `TurnScore` rather than add a ninth event type.
4. **Heartbeat carries `seq` but no SSE `id:`**, and is not buffered.
5. **`RESUME_GAP` is a terminal `error`** plus a client-driven restart, because
   the fixed event catalog has no `resume_gap` type and `error` is terminal.

Also flagged for Phase 2: the "mid-stream budget kill" test must target the
window **between the router call and the answer call**, not mid-token —
pre-flight reservation in `DefaultModelGateway.complete()` reserves the whole
answer before the `await`, so a mid-answer kill is unreachable by construction.

## 5. Next action

Once Phase 0 is signed off:

1. Branch `phase-1/streaming-chatmodel` off `main`.
2. Write the parity test **before** the implementation (standing rule 5):
   `concat(chunks) === complete(messages)` for every fixture, with an explicit
   Arabic case drawn from `MULTILINGUAL_CORPUS`.
3. Add `streamComplete(messages): AsyncIterable<TokenChunk>` to `ChatModel`, and
   a grapheme-safe deterministic chunker to `MockChatModel` (`Intl.Segmenter`,
   no `setTimeout` in test mode).
4. Route streamed token accounting through the same
   `estimateTokens` / `BudgetLedger` path; reservation stays pre-flight.
5. DoD: parity green incl. Arabic; ≥90% coverage on new code; 108 pre-existing
   tests still untouched; typecheck, lint, test, test:coverage all green.

## 6. Commands to resume

```bash
git checkout main && git pull
git checkout -b phase-1/streaming-chatmodel
npm ci
npm run typecheck && npm run lint && npm test
npx vitest run tests/streamingContract.test.ts   # contract shape only
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies; parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
