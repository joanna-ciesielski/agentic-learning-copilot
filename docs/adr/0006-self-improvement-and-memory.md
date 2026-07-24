# ADR 0006 — Self-improvement loop & per-user memory

**Status:** accepted · **Date:** 2026-07

## Context

Zone 4 of the target architecture is a self-improvement loop: a scoring agent
grades answers and interaction signals into a compact per-user profile that tunes
routing on later turns. This needs somewhere for state to live across turns and a
principled way for the profile to influence behavior without destabilizing it.

## Decision

- **Scoring node.** After synthesis, a `scoring` node grades the turn (`Scorer`)
  from signals the graph already has — grounded? how many citations? — into a
  `TurnScore`. No extra model call.
- **Per-user profile (memory).** `ProfileStore`, keyed by `${orgId}:${userId}`
  (tenant-scoped — profiles never cross orgs), accumulates a grounded-answer count
  per vertical. In-memory for dev; Redis/Postgres is the documented production swap
  behind the same interface. This is the `user.md` analog and the graph's cross-turn
  memory.
- **Prior, not an override.** On each turn the orchestrator reads
  `preferredVertical()` and passes it to the supervisor as a *prior*. The prior is
  consulted ONLY when the model is uncertain (low confidence, malformed, or failed)
  — a confident model decision always wins. The prior fires only once the profile
  has enough signal (`minTurns`) and a clear margin between verticals, so a thin or
  balanced profile stays out of the way.

## Consequences

- **+** The loop demonstrably changes routing across turns: the same ambiguous
  query routes differently once a user's grounded answers have favored a vertical
  (verified end-to-end).
- **+** Bounded blast radius — the prior can't override a confident classification,
  so a noisy profile can't hijack clear queries.
- **+** Recording happens at the orchestration boundary (`Copilot.ask`), keeping
  graph nodes free of external side effects.
- **+** Reads are pure (`get()`/`preferredVertical()` never insert), and the prior
  generalizes over `VERTICALS` (argmax with a margin), so it stays correct if a
  vertical is added.
- **−** The profile is a coarse count-based prior, not a learned model; it's a
  demonstrator of the loop shape. A real system would weight recency and explicit
  feedback and likely persist per-thread.
- **−** In-memory store is process-local and unbounded; production needs a TTL/size
  policy and a durable backend.
