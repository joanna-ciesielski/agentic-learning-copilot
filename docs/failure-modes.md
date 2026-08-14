# Failure-mode catalog

Observed / anticipated failure modes for the copilot, each paired with the guard
that addresses it and where that guard is exercised. This is a living document;
new modes get added as the eval surfaces them.

| # | Failure mode | Trigger | Guard | Verified in |
| - | ------------ | ------- | ----- | ----------- |
| 1 | **Mis-route** — supervisor sends a query to the wrong vertical | Ambiguous or mixed-signal query | zod-validated model route + deterministic keyword fallback; routing-accuracy gate (≥ 0.90) | `tests/router.test.ts`, `runEval` routing |
| 2 | **Invalid / off-schema route** — model invents a vertical (e.g. `"sports"`) or returns junk | Model hallucination / bad output | `RouteSchema` (zod enum derived from `VERTICALS`) rejects it; supervisor falls back to a valid vertical, so it can never reach the graph | `tests/router.test.ts` ("rejects an off-schema vertical") |
| 3 | **Ungrounded answer / hallucination** — answer asserts things not in sources | Weak retrieval or a chatty model | Citations are taken from retrieval, never model claims; groundedness gate (≥ 0.90) scores answer support against cited text | `tests/eval.test.ts`, `runEval` groundedness |
| 4 | **Cross-tenant leakage** — one org's query surfaces another org's content | Query lexically matches a foreign tenant's docs | Tenant+vertical hard filter is the FIRST step of every `retrieve()` (ADR-0003); foreign content is never a candidate; citations stay in-tenant | `tests/copilot.e2e.test.ts` marker probes, `tests/retrieval.test.ts`, **`runEval` tenancy gate (0 leaks required)** |
| 5 | **Refusal-when-answerable / confident-when-empty** — inventing an answer with no material | Query with no matching content in scope | Empty retrieval short-circuits to a safe decline (`grounded:false`) with an `agent:empty-retrieval` note, instead of a fabricated answer | `tests/verticalAgent.test.ts`, `tests/copilot.e2e.test.ts` |
| 6 | **Malformed model output** — JSON wrapped in ```` ```json ```` fences, prose, or unparseable | Real model formatting | `extractJson` strips fences/prose and finds the first balanced block; unparseable/off-schema → `StructuredOutputError` → supervisor fallback | `tests/structured.test.ts`, `tests/router.test.ts` |
| 7 | **Prompt injection via retrieved content** — a retrieved passage tries to override system rules | Adversarial or poisoned corpus content | Retrieved text is passed as *data* in the user turn, never as system instructions; system role is fixed | (guard in `verticalAgent.ts`; adversarial test set scheduled) |
| 8 | **Runaway cost** — an org burns unbounded tokens | High volume / expensive queries | Per-org `BudgetLedger` with **pre-flight** rejection (`BudgetExceededError`); over-budget turn declines with zero spend; graceful mid-turn degradation | `tests/gateway.test.ts`, `tests/copilot.cost.e2e.test.ts` |
| 9 | **Abuse / request flooding** — one user hammers the service | Scripted or malicious traffic | Per-user `RateLimiter` cap + `RelevanceGuard` (empty/oversized), both pre-flight in `Copilot.ask` | `tests/cost.test.ts`, `tests/copilot.cost.e2e.test.ts` |
| 10 | **Over-spend on repeat work** — paying to recompute identical answers | Duplicate queries | `ResponseCache` (messages + content version) and `CachingEmbedder` (content-hash) — cache hits cost nothing | `tests/cache.test.ts`, `tests/gateway.test.ts` |
| 11 | **Slow client** — a consumer that reads the SSE stream slower than it is produced | Congested link, stalled tab, malicious drip-reader | Pull-based delivery: `res.write()` backpressure parks the loop in `awaitDrain`, which also pauses the producing graph (no unbounded queue); a client stalled past the drain timeout is disconnected | `tests/sseServer.test.ts` ("slow client: backpressure…"); timeout disconnect unit-tested via `awaitDrain` |
| 12 | **Mid-stream provider failure** — the model dies after tokens have flowed | Provider disconnect/5xx mid-answer | Gateway `finally` releases the budget reservation and closes the upstream stream; the event layer terminates with typed `UPSTREAM_ERROR`, `partial: true`, no internals on the wire (detail → tracer); client renders the partial as non-answer | `tests/streamingCopilot.test.ts` ("fails MID-STREAM…"), `tests/streamingGateway.test.ts` |
| 13 | **Resume storm** — many simultaneous reconnects replaying one thread | Flaky network + auto-reconnect fan-out | Replay is a read-only walk of the ring buffer (no graph run, no model spend); concurrent resumes serve identical byte streams | `tests/sseServer.test.ts` ("resume storm…") |
| 14 | **Heartbeat-only idle connection** — long silence between events | Slow provider, long retrieval, idle turn | Event-layer heartbeats every 15 s (envelope, no `id:`, never buffered) keep intermediaries from killing the connection; `seq` stays monotonic across them | `tests/sseServer.test.ts` ("heartbeat-only idle connection…", heartbeat framing test) |
| 15 | **Duplicate `Last-Event-ID`** — the same resume cursor sent repeatedly | Client retry loops, refresh spam | Resume is idempotent: identical cursor → identical replay, every time; no state advances server-side on a read | `tests/sseServer.test.ts` ("duplicate Last-Event-ID…") |

## Notes

- Modes 1–6 and 8–10 have automated guards and tests today. Mode 7's structural
  guard (data vs. instruction separation) is in place; a dedicated adversarial
  injection test set is still to come.
- The routing and groundedness numbers here are **offline-fixture** numbers using
  the deterministic stand-in responder. Phase 2's gate proves the *harness and the
  guards*; swapping in a real provider re-runs the same gate against real output.
