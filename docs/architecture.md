# Architecture

This project mirrors a four-zone personalization engine so it reads as a faithful,
production-shaped demonstrator.

- **Zone 1 — Surface:** a thin chat entry taking a query and `{ userId, orgId, locale }`:
  a CLI, and an **SSE streaming server** (`POST /v1/chat` on native `node:http`) with a
  dependency-free demo client — the streaming path is described below.
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

## The streaming path

Incremental delivery is layered on the same graph — one policy path, two delivery
modes. `ask()` runs the compiled graph via `invoke()`; `stream()` runs the *identical*
graph via LangGraph's custom stream mode, where nodes emit pre-envelope payloads only
when a writer is present (ADR-0008 and its addendum).

```
            ┌──────────────────────────── one compiled StateGraph ───────────────────────────┐
            │  supervisor ──(route)──► courses | jobs ──► synthesis ──► scoring              │
            └──────┬──────────────────────────┬──────────────────────────────────────────────┘
   ask(): invoke() │                stream(): │ custom-mode writer (payloads)
                   ▼                          ▼
            CopilotAnswer          Copilot.stream()  ← envelope {seq, threadId, ts} applied
                                          │            here and nowhere else; every event
                                          │            zod-validated against contract v1.0
                                          ▼
                                   SSE transport (node:http)
                                   framing · heartbeats · Last-Event-ID resume over a
                                   bounded ring buffer · backpressure · abort→AbortSignal
                                          │
                                          ▼
                                   demo/client.html
                                   rAF-batched rendering · monotonic-seq guard ·
                                   client-side parity verification (sha256 witnesses)
```

The invariants that keep the two modes honest, all CI-gated: **parity** (streamed
concatenation is byte-equal to the batch answer, Arabic fixtures included), **decline
parity** (identical wording on both paths), **guard equivalence** (budgets, rate caps,
relevance, tenancy — same objects, same order), and **cancellation** (client abort
reaches the graph as an `AbortSignal`; no orphaned model calls). The event layer knows
nothing about HTTP, which is what makes the transport a swap (WebSockets/gRPC) rather
than a rewrite. Contract: [`streaming-contract.md`](streaming-contract.md); measured
limits: [`streaming-perf.md`](streaming-perf.md).

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
- A Next.js / web frontend UI (the "surface" is an API + CLI + a single-file demo
  client for the streaming path).
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
| S0–S6 ✅ | SSE streaming layer: contract/ADR, streaming model+gateway, graph events, transport, demo client, hardening+load, docs | ~25–40 h (plan A) |

These are planning estimates, not commitments; each phase is independently shippable
and CI-gated, so scope can stop cleanly at any phase boundary.
