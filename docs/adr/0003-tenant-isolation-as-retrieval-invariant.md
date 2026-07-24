# ADR 0003 — Tenant isolation as a retrieval invariant

**Status:** accepted · **Date:** 2026-07

## Context

The platform is multi-tenant: each org's learners must only ever see that org's
content. "No cross-tenant leakage" is a required success criterion and a data
security boundary, not a nice-to-have. There are two ways to implement it:
post-filter (retrieve broadly, then drop foreign results) or pre-filter (scope
the candidate set before any scoring).

## Decision

Enforce isolation as the **first step of every `retrieve()`**: the candidate set
is reduced to the caller's `(orgId, vertical)` before dense or lexical scoring
runs. Foreign content is never a candidate, never scored, never ranked, and can
never appear in a top-k list. Citations are additionally derived only from
retrieved chunks, so the boundary holds through to the answer.

## Consequences

- **+** Leakage is structurally impossible in the retrieval path, not merely
  filtered out afterward (post-filters are one forgotten line from leaking).
- **+** Cheap: scoring runs over a smaller candidate set.
- **+** Testable as an invariant — adversarial "marker probe" tests query one
  tenant's scope with another tenant's content and assert nothing foreign returns.
- **−** A production vector store (MongoDB Atlas / pgvector) must push the same
  `orgId`/`vertical` filter into the query itself — documented as the swap
  requirement so the invariant survives the move off the in-memory store.
