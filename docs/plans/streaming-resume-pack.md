# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-14 · **Current phase:** Phase 5 (hardening & load) — delivered, awaiting DoD confirmation

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | Merged to `main`. |
| 1 — Streaming ChatModel | Merged to `main`. |
| 2 — Graph event stream | Merged to `main` (`c72fabe`). |
| 3 — SSE server | Merged to `main` (`e1dcfc9`). |
| 4 — Demo client & state management | Merged to `main` (`6b564c7`), incl. the background-tab HUD fix. |
| 5 — Hardening & load | **Delivered, awaiting DoD confirmation.** Branch `phase-5/hardening`. |
| 6 — Docs & portfolio assets | Not started. |

Canonical remote: `github.com/joanna-ciesielski/agentic-learning-copilot`.
Delivery is by git bundle until the repo is added to the sandbox session's
authorized sources (pushes 403 otherwise).

## 2. What Phase 5 added (earlier phases live in git history)

| File | Change |
| --- | --- |
| `scripts/streaming-load.ts` + `npm run load` | Load harness: SLO pass (25 conns, zero-error gate), saturation probe (100 conns, report-only), TTFB sampler (sequential + cold burst — autocannon's latency is time-to-LAST-byte, so first-token timing is hand-rolled), memory/leak checks with forced GC and a settle longer than undici's keep-alive so the connection count measures the server. |
| `docs/streaming-perf.md` | Measured: saturation ~150–165 turns/sec on one core; 25-conn SLO clean (p50 163 ms, p99 633 ms full-stream); TTFB unloaded p50 7.4 ms; post-GC heap growth −10 MB over ~3,100 turns; 0 stuck connections. |
| `docs/failure-modes.md` | Modes 11–15: slow client, mid-stream provider failure, resume storm, heartbeat-only idle connection, duplicate Last-Event-ID — each with its guard and test reference. |
| `tests/sseServer.test.ts` | +8: slow-client backpressure with end-to-end parity (135 KB answer vs a stalled reader — covers the in-loop drain branch), resume storm (20 concurrent, byte-identical), duplicate cursor idempotence, heartbeat-bridged idle window, listener/connection leak canary, stress defaults + client abort, /demo alias, GET /v1/stress 405. |
| `tests/streamingCopilot.test.ts` | +1: `heartbeatMs: 0` disables heartbeats. |
| `package.json` / `tsconfig.json` | devDependencies: `autocannon`, `@types/autocannon` (the plan's one permitted addition); `scripts/` now typechecked. |

## 3. Baseline (verified 2026-08-14)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 22 files, 278 tests (108 pre-existing untouched)
npm run test:coverage
#   Statements 97.72%  Branches 89.02%  Functions 98.61%  Lines 98.93%
NODE_OPTIONS=--expose-gc npm run load   # SLO pass must be clean
```

Project coverage gate met: ≥85% branch on new modules, ≥89% overall (89.02%).

## 4. Design decisions made during Phase 5

1. **SLO pass and saturation probe are separate runs.** At 100-way concurrency
   the single core saturates and 10 s-timeout errors appear — that is the
   ceiling being measured, not a bug. The zero-error gate applies at 25
   connections; the 100-connection numbers are reported, not gated.
2. **TTFB is sampled two ways** (sequential = what one user feels: p50 7.4 ms;
   100-way cold burst = worst case by construction: p50 379 ms) because a
   single number would mislead in one direction or the other.
3. **Leak measurement forced a GC first.** Unforced heapUsed showed +120 MB —
   all uncollected garbage; post-GC the run RETURNS memory (−10 MB). The load
   script documents `NODE_OPTIONS=--expose-gc`.
4. **The leak canary tolerates undici's pool.** Client keep-alive keeps 1–2
   sockets; the assert bounds connections ≤4 against 30 requests — growth
   toward the request count is the leak signal, not small constants.

## 5. Next action — Phase 6 (docs & portfolio assets)

Do not start until Phase 5's DoD is confirmed. The last phase, docs-only:

1. Branch `phase-6/docs-portfolio` off `phase-5/hardening`.
2. `docs/architecture.md`: add the streaming path (event layer → transport →
   demo client) to the architecture description and regenerate the diagram
   with the streaming path highlighted.
3. `README.md`: quickstart — clone → `npm i` → `npm run serve` → open the demo;
   the Phase 6 DoD is a stranger doing that in under 5 minutes.
4. `docs/application-note.md`: new section "Streaming & client state under
   load" using the measured numbers from `docs/streaming-perf.md` and
   `docs/demo.md`.
5. Optional flagged polish: citation score-threshold so weak tail retrievals
   (e.g. unrelated docs at k=4) stop appearing in the citation line.
6. Refresh the portfolio entry copy (outside the repo).

## 6. Commands to resume

```bash
git checkout phase-5/hardening
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage
NODE_OPTIONS=--expose-gc npm run load

git checkout -b phase-6/docs-portfolio
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
