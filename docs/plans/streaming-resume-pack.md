# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-13 · **Current phase:** Phase 4 (demo client & state management) — delivered, awaiting DoD confirmation

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | Merged to `main`. |
| 1 — Streaming ChatModel | Merged to `main`. |
| 2 — Graph event stream | Merged to `main` (`c72fabe`). |
| 3 — SSE server | Merged to `main` (`e1dcfc9`). |
| 4 — Demo client & state management | **Delivered, awaiting DoD confirmation.** Branch `phase-4/demo-client`. |
| 5 — Hardening & load | Not started. |
| 6 — Docs & portfolio assets | Not started. |

Canonical remote: `github.com/joanna-ciesielski/agentic-learning-copilot`.
Delivery is by git bundle until the repo is added to the sandbox session's
authorized sources (pushes 403 otherwise).

## 2. What Phase 4 added (Phase 3 summary now lives in git history)

| File | Change |
| --- | --- |
| `demo/client.html` | The teaching artifact: one self-contained file, vanilla JS, no build step. Six labeled patterns (`PATTERN 1`–`6`): rAF-decoupled ingestion, per-frame token coalescing, monotonic seq + token.index gap guards, hand-rolled fetch-SSE reader with Last-Event-ID resume, 500 ms-windowed latency HUD, stress mode. The anti-pattern ships too, deliberately: batching OFF does `innerHTML +=` + per-event `scrollHeight` (bounded so it degrades instead of tar-pitting). Client-side parity checker hashes rendered tokens against `done.answerSha256`. |
| `src/server/index.ts` | `GET /` serves the demo; `POST /v1/stress` mints synthetic contract-valid token events at the wire (clamped rate ≤10k/s, count ≤100k), no copilot, not buffered for resume, real parity witnesses on `done`. |
| `docs/demo.md` | Manual script with measured numbers (headless Chromium): batching ON = 60 fps / ~2,850 evts/s / 0–2 dropped over 12k events; OFF = main thread frozen ~5 s on 3k events, fps 26 / frame 37.9 ms at recovery, 110+ missed frames. |
| `docs/assets/streaming-demo.png` | Portfolio screenshot captured from a live browser run mid-stress. |
| `tests/sseServer.test.ts` | +4 tests: demo served at `/`, stress stream shape/witnesses at count, parameter clamping, malformed stress body. |

Browser verification (not committed; Playwright + preinstalled Chromium against
`npm run serve`): real turn streams with PARITY OK badge; drop→resume flow ends
in R7 as designed; batching ON holds 60 fps at 3k evts/s; batching OFF degrades
measurably. The dropped-frames counter counts frames that SHOULD have fired
during a gap (a freeze ≈ hundreds), not "1 per hitch".

## 3. Baseline (verified 2026-08-13)

```
npm ci
npm run typecheck   # clean
npm run lint        # clean
npm test            # 22 files, 270 tests (108 pre-existing untouched)
npm run test:coverage
#   Statements 97.31%  Branches 87.42%  Functions 98.61%  Lines 98.69%
npm run serve       # then open http://localhost:3000
```

## 4. Design decisions made during Phase 4

1. **Stress is transport-only and unbuffered.** Synthetic events are minted at
   the wire; buffering 100k throwaway events would evict real turns from the
   ring. Stress streams are documented as non-resumable.
2. **The anti-pattern is bounded on purpose.** Unbounded `innerHTML +=` is
   quadratic and tar-pits the tab for minutes — which demonstrates nothing but
   a frozen page. Trimmed, its per-event cost is high-but-constant: fps
   collapses, the stream still finishes, the toggle stays usable.
3. **Honest dropped-frame accounting.** A fully frozen main thread fires no
   rAF at all, so "1 per hitch" under-reports precisely when it matters most.
   The counter adds `delta/16.7 − 1` per gap.
4. **Stress params clamp, never 400.** The demo's own sliders must not be able
   to produce an error; out-of-range values saturate at the caps.
5. **EventSource does not apply** (the endpoint is POST); the client hand-rolls
   the reader — which is exactly PATTERN 4's teaching point.

## 5. Next action — Phase 5 (hardening & load)

Do not start until Phase 4's DoD is confirmed.

1. Branch `phase-5/hardening` off `phase-4/demo-client`.
2. `autocannon` as a devDependency (the one the plan explicitly allows): 100
   concurrent streams against the mock model; record p50/p99 TTFB and memory
   ceiling in `docs/streaming-perf.md`; assert no listener leaks.
3. Failure-catalog additions to `docs/failure-modes.md`: slow client (the
   uncovered `awaitDrain` in-loop branch is the probe target), mid-stream
   provider failure, resume storm, heartbeat-only idle connection, duplicate
   Last-Event-ID.
4. DoD: every failure mode has a test or documented manual probe; CI green on
   Node 20 & 22; coverage ≥85% branch on new modules, ≥89% overall (currently
   87.42% overall branch — the gap is the server's defensive branches; Phase 5
   probes should close most of it).

## 6. Commands to resume

```bash
git checkout phase-4/demo-client
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage
npm run serve

git checkout -b phase-5/hardening

npx vitest run tests/sseServer.test.ts
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
