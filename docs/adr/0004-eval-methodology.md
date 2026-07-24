# ADR 0004 — Fixture eval methodology & CI quality gate

**Status:** accepted · **Date:** 2026-07

## Context

"Documented quality metrics on a fixture eval set" is a stated success criterion,
and quality claims are worthless unless they're measured and defended against
regression. We need an eval that runs in CI, offline, deterministically, and fails
the build when quality drops.

## Decision

- **Versioned fixtures.** Corpus, routing set, and retrieval gold labels live in
  the repo under a `FIXTURE_VERSION`. The eval report records the version so a
  metric change is attributable to a fixture edit vs. a code change.
- **Four metric families, gated where the plan requires:**
  - *Routing accuracy* against labeled query→vertical pairs — gate ≥ 0.90.
  - *Retrieval* precision@k, recall@k, MRR against gold source-doc labels —
    **recall@k gated ≥ 0.90**; precision@k and MRR reported (precision@k is
    bounded by 1/k for single-gold cases, so it informs rather than gates).
  - *Groundedness* — token-support of each answer's claim against its cited
    documents — gate ≥ 0.90 pass-rate.
  - *Tenancy* — probes scoped to one org but worded toward a foreign org;
    **cross-tenant leakage gated at exactly 0** (a hard security invariant, not a
    percentage). This lifts the isolation guarantee from a unit test into the
    quality gate itself.
- **Thresholds in one place** (`EVAL_THRESHOLDS`), shared by the CI gate CLI and
  the test suite, so raising the bar is a single reviewable commit.
- **Offline deterministic stand-in.** The eval drives the graph with the mock
  responder, so CI needs no keys and results are reproducible. The numbers prove
  the *harness and guards*; a real provider re-runs the identical gate against
  real output.

## Consequences

- **+** A regression in routing, retrieval, or groundedness fails CI (`npm run
  eval`) and the test suite — quality is enforced, not asserted.
- **+** Queries in the retrieval set are worded to overlap their gold docs; this
  is a deliberate fixture design for a stable signal on a toy embedder, not a
  claim of semantic search quality.
- **−** Offline-fixture numbers are not real-model numbers. This is stated
  everywhere the metrics appear; Phase 2 intentionally gates the pipeline, and a
  real-provider eval is a later swap behind the same `ChatModel` interface.
- **−** Fixtures must be re-versioned and re-labeled when the corpus grows.
