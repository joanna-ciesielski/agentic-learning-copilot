# Streaming layer — resume pack

**Assume zero context.** This file is the entry point for the next working
session on the SSE streaming layer. Read it, then read
[`streaming-plan.md`](streaming-plan.md) in full before touching anything. The
plan's Fixed Decisions and the decisions recorded in
[`../streaming-contract.md`](../streaming-contract.md) §14 are both binding.

**Last updated:** 2026-08-14 · **Current phase:** Phase 6 (docs & portfolio) — delivered. **This completes the plan.**

---

## 1. Where things stand

| Phase | State |
| --- | --- |
| 0 — Contract & ADR | Merged to `main`. |
| 1 — Streaming ChatModel | Merged to `main`. |
| 2 — Graph event stream | Merged to `main` (`c72fabe`). |
| 3 — SSE server | Merged to `main` (`e1dcfc9`). |
| 4 — Demo client & state management | Merged to `main` (`6b564c7`), incl. the background-tab HUD fix. |
| 5 — Hardening & load | Merged to `main`, plus two follow-up fixes for platform-timing test bugs found on macOS (slow-client and abort tests moved to deterministic layers). |
| 6 — Docs & portfolio assets | **Delivered.** Branch `phase-6/docs-portfolio`. |

Canonical remote: `github.com/joanna-ciesielski/agentic-learning-copilot`.
Delivery is by git bundle until the repo is added to the sandbox session's
authorized sources (pushes 403 otherwise).

## 2. What Phase 6 added (earlier phases live in git history)

| File | Change |
| --- | --- |
| `README.md` | CI badge fixed to the canonical account; status + 30-second quickstart (`npm run serve`); streaming-layer section; roadmap row S0–S6; test counts updated. |
| `docs/architecture.md` | "The streaming path" section with an ASCII diagram (one graph, two delivery modes) and the four CI-gated invariants; Zone 1 and non-goals updated; effort row added. |
| `docs/application-note.md` | New "Streaming & client state under load" section with the measured numbers; requirement row for AI & streaming architecture review; engineering bar updated honestly (281 tests, 0 runtime-dependency vulnerabilities, dev-only advisories disclosed, the two macOS test bugs named). |
| `docs/demo.md` | The citation-threshold no-ship decision recorded with evidence (RRF scores are rank-shaped and flat — measured ~4% spread — so a ratio filter fits noise; the real lever is a reranker behind the existing seam). |

## 3. Project definition of done — final status

| Plan requirement | Status |
| --- | --- |
| All phase DoDs | Met (each recorded per phase in git history). |
| 108 pre-existing tests untouched and green | `git diff` on the 17 original test files vs pre-streaming main: zero lines. 281 total tests. |
| Parity + isolation + budget-kill invariants CI-gated | `tests/streamingParity`, `streamingGateway`, `streamingCopilot`, `sseServer` — all in the CI path. |
| Demo reproducible offline | `npm i && npm run serve` → demo at :3000, no keys, <5 min. |
| ADR 0008 + contract v1.0 published | Both merged, contract status accepted, §14 decisions + R7/R8 recorded. |
| Portfolio assets refreshed | Screenshot committed; portfolio entry copy delivered outside the repo (plan says outside). |
| Zero new runtime dependencies | Runtime deps still exactly 3; devDependencies added: autocannon, @types/autocannon (plan-permitted). |

Final baseline: 281 tests / 22 files; statements 97.7%, branches 89.2%, functions 98.6%,
lines 98.9%; typecheck/lint clean; `npm audit --omit=dev`: 0 vulnerabilities.

## 4. Open items beyond the plan (not started, deliberately)

Citation quality: reranker behind the retrieval seam (documented, not built — see
`docs/demo.md`). Real-provider adapters remain the standing next build if the repo grows.

## 5. Next action

None within this plan — Phase 6 completes it. Any future session: read this
file, the contract, and ADR-0008; the standing rules below remain in force for
any change touching the streaming surface.

## 6. Commands to resume

```bash
git checkout main
npm ci
npm run typecheck && npm run lint && npm test && npm run test:coverage
npm run serve
NODE_OPTIONS=--expose-gc npm run load
```

## 7. Standing rules in force

One phase at a time, in order; plan + self-audit before code in each phase; the
108 pre-existing tests are never modified; zero new runtime dependencies
(devDependencies only where the plan says, e.g. `autocannon` in Phase 5); parity
tests written before the code they guard; no AI/LLM authorship anywhere; no
personal names in code — roles only; this file updated at the end of every
session.
