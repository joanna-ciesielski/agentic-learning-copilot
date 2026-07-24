# ADR 0005 — Cost discipline via a single model gateway

**Status:** accepted · **Date:** 2026-07

## Context

Phase 3 adds per-org token budgets, multi-tier model routing, caching, metrics,
and anti-abuse caps. These are cross-cutting: every model call needs to be
tiered, budget-checked, cached, and metered. Scattering that logic across the
supervisor and each vertical agent would duplicate it and make it easy to skip.

## Decision

Route **all** model calls through one `ModelGateway`. `DefaultModelGateway.complete()`
is the single choke point that, in order: picks a tier from cohort+task, returns a
cached response if present, rejects **pre-flight** with `BudgetExceededError` if the
estimated spend would exceed the org budget, calls the tier's model, settles actual
token spend, caches the response, and emits a metric.

- **Budgets** are per-org (`BudgetLedger`). The gateway **reserves** the estimated
  cost synchronously *before* the `await` (rejecting if the reservation would
  exceed budget), then reconciles the reservation down to actual spend after the
  call and releases it if the call throws. Reserving before the await closes the
  check-then-act race, so concurrent calls for one org cannot both slip past the
  check and overspend.
- **Tiering** (`CohortModelRouter`) is a small, testable policy: routing never uses
  a frontier model; answering scales frontier/mid/cheap by cohort.
- **Caching**: an embedding cache (`CachingEmbedder`, content-hash) and a response
  cache (`ResponseCache`, keyed by **org namespace** + content version +
  messages-hash). A cache hit costs nothing — the core lever behind the cost
  projection. Namespacing by org makes a cached response un-shareable across
  tenants (defense-in-depth on top of answer messages already embedding
  tenant-scoped context).
- **Metrics** (`MetricsSink`) receive tokens/cost/latency/tier/cached per call; the
  in-memory sink rolls them up, a production sink forwards to PostHog/LangSmith.
- **Anti-abuse** (`RateLimiter` per user, `RelevanceGuard`) run as **pre-flight
  gates in `Copilot.ask`**, before any spend.
- **Graceful degradation**: a blocked or over-budget turn returns a *declined*
  answer with a reason (never an exception, never a partial charge). Budget errors
  are deliberately NOT swallowed by the supervisor's malformed-output fallback.

The agents depend only on the gateway interface; a raw `ChatModel` is auto-wrapped
in a zero-services passthrough, so existing call sites keep working.

## Consequences

- **+** One place to reason about cost, one place to test it; usage is threaded
  back through the graph so every turn reports its own tokens/cost/tiers.
- **+** Enforcement is pre-flight — the budget test proves zero model spend on a
  rejected call.
- **−** Token counts are estimates (ADR-0002's `estimateTokens`); real billing uses
  the provider's tokenizer. Pricing in `PRICING` is illustrative and lives in one
  place to update.
- **−** "Daily" rate limiting is an in-memory counter with `reset()`; production
  keys by `userId:utcDate` in a TTL store.
- **−** A turn declined *mid*-flight (a later call over budget after an earlier one
  succeeded) returns an empty `TurnUsage`; the already-spent tokens are recorded on
  the `MetricsSink`, which is the source of truth for partial spend.
- **−** `RelevanceGuard` is a conservative stub (empty/oversized only); a real
  topical-relevance classifier is the production swap.
