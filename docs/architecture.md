# Architecture

This project mirrors a four-zone personalization engine so it reads as a faithful,
production-shaped demonstrator.

- **Zone 1 — Surface:** a thin chat entry (HTTP + CLI) taking a query and
  `{ userId, orgId, locale }`.
- **Zone 2 — Agents (LangGraph.js):** a **supervisor** classifies intent and routes to
  **vertical agents** — **Courses** (RAG over lessons/transcripts) and **Jobs** (RAG over
  postings) — with extensible **Events/Comms** stubs. Modeled as a `StateGraph`:
  supervisor node → conditional edges → agent nodes → synthesis → scoring. The supervisor
  reads a Zone-4 routing prior; the scoring node closes the self-improvement loop.
- **Zone 3 — Backends:** ingestion, a **per-tenant-scoped** vector store, and hybrid
  retrieval (dense + BM25 + RRF, optional rerank). In-memory store for dev/test;
  MongoDB Atlas / pgvector documented as the production swap.
- **Zone 4 — Self-improvement loop:** a scoring agent grades answers and interaction
  signals into a compact per-user profile that tunes routing on later turns.

Cross-cutting controls apply to every call: per-org token budgets (fail-fast),
multi-tier model routing (frontier/mid/cheap), a regression eval set + CI gate,
caching + anti-abuse caps, and metrics/observability hooks.

## Design principles

- **Offline-testable by default.** A deterministic hashing embedder + mock chat model
  keep the whole pipeline runnable with no keys and no network, so CI is fast and free.
- **Structured output, not string parsing.** zod schemas validate every model output.
- **Tenant isolation is a security invariant**, verified with adversarial tests.
- **Quality is measured, not claimed** — a fixture eval set gates CI (Phase 2).

## Non-goals (explicitly out of scope)

This is a portfolio-grade **demonstrator of the pattern**, not a live platform. It does
**not** include:

- Real authentication / authorization or user management.
- A production database or persistence layer (dev uses in-memory; prod stores are
  documented, not deployed).
- A Next.js / web frontend UI (the "surface" is an API + CLI).
- Horizontal scaling, high-availability, or multi-region concerns.
- Real course/job data at platform scale — fixtures are small and illustrative.
- Fine-tuning or training of models.

Keeping these out is deliberate: it lets the project prove the **architecture and
engineering discipline** (agents, retrieval, eval, tenancy, cost, safety) without the
noise of a full deployment.

## Rough effort estimate

Indicative build effort for a single engineer working AI-assisted (Phases 0–4
are complete):

| Phase | Scope | Rough effort |
| ----- | ----- | ------------ |
| 1 ✅ | Supervisor + 2 vertical agents, per-agent RAG, tenant scoping, tests | ~1–1.5 days |
| 2 ✅ | Fixture eval set + CI gate (routing, retrieval, groundedness) | ~0.5–1 day |
| 3 ✅ | Per-org budgets, multi-tier routing, caching, metrics, anti-abuse | ~1 day |
| 4 ✅ | Self-improvement loop + Arabic/English multilingual + tracing | ~1–1.5 days |

These are planning estimates, not commitments; each phase is independently shippable
and CI-gated, so scope can stop cleanly at any phase boundary.
