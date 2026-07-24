# How this repository maps to the role

This repository is a purpose-built reference implementation for a **Senior Agentic AI
Engineer** role — auditing and hardening a production personalization engine for a
career-intelligence / upskilling platform. It was built to mirror that system's
architecture (a four-zone engine) and its stated success criteria, so the requirements can
be read directly against working, tested code rather than a description.

It is a **scoped, offline-testable demonstrator** on synthetic fixtures — not a live
deployment. Every model call runs against a deterministic mock and a hashing embedder by
default, so the whole thing is reproducible in CI with no keys; real OpenAI/Anthropic
providers and a production vector store drop in behind the existing interfaces. Where a
number is offline-fixture rather than real-model, it says so.

## Requirement → evidence

| Requirement | Priority | How this repo answers it | Where |
| --- | --- | --- | --- |
| Production agentic system (supervisor + vertical agents) | Required | LangGraph.js `StateGraph`: `supervisor → (conditional) → courses \| jobs → synthesis → scoring`; supervisor is guaranteed to route to a valid agent | `src/graph/`, `src/agents/` |
| JavaScript / TypeScript (Node) | Required | Entire project strict TypeScript on Node 20/22; LangChain.js + LangGraph.js | whole repo |
| Strong production RAG (chunking, retrieval, eval) | Required | Hybrid retrieval — dense (embedding cosine) + BM25 fused with Reciprocal Rank Fusion; structure-aware chunking | `src/retrieval/` |
| Per-tenant scope enforcement (no cross-tenant leakage) | Required | Tenant + vertical **hard pre-filter as the first step of every `retrieve()`**; org-namespaced response cache; org-keyed profiles. Gated at **0 leaks** in the eval | `src/retrieval/hybridRetriever.ts`, ADR-0003 |
| Structured-output validation | Required | zod schemas; a fence/prose-tolerant JSON extractor; invalid/off-schema output is rejected and the supervisor degrades safely | `src/core/structured.ts`, `src/agents/router.ts` |
| Regression eval set + CI integration | Required | Versioned fixture eval — routing accuracy, precision/recall@k, MRR, groundedness, tenancy — **gated in CI** (`npm run eval`) | `src/eval/`, `.github/workflows/ci.yml`, ADR-0004 |
| Per-org token budgets with enforcement | Required | `BudgetLedger` with a **pre-flight reserve/reconcile** design; an over-budget turn declines with **zero** model spend; concurrency-safe against parallel calls | `src/cost/budget.ts`, `src/llm/modelGateway.ts`, ADR-0005 |
| Cache strategy | Req/Pref | Content-hash embedding cache (a warm cache embeds 0) + response cache keyed by messages + content version + org | `src/embeddings/cachingEmbedder.ts`, `src/cost/cache.ts` |
| Multi-tier model routing | Preferred | `pickModel(cohort, task)` → frontier / mid / cheap; routing never uses a frontier model | `src/cost/modelRouter.ts` |
| Anti-abuse limits | Preferred | Per-user rate cap + a relevance guard, both enforced pre-flight | `src/cost/rateLimiter.ts`, `src/cost/relevanceGuard.ts` |
| Cost reporting / dashboard hooks | Preferred | `MetricsSink` (tokens / cost / latency / tier / cached per call) + a `Tracer` for turn-lifecycle events, shaped for LangSmith / PostHog | `src/cost/metrics.ts`, `src/observability/tracer.ts` |
| Multilingual (Arabic + English) | Preferred | Unicode-aware tokenizer + a bilingual fixture; a query in either language retrieves the same-language document | `src/retrieval/text.ts`, `src/fixtures/multilingual.ts`, ADR-0007 |
| Vector store beyond in-memory | Preferred | In-memory store behind a `Retriever` interface; MongoDB Atlas / pgvector documented as the production swap | `src/retrieval/`, ADR-0003 |
| Adaptive self-improvement (stretch) | Preferred | Scoring node → per-user `ProfileStore` → routing prior that **demonstrably changes routing across turns** (verified end-to-end) | `src/memory/`, `src/agents/scorer.ts`, ADR-0006 |
| Cost projection for ~10K users | Success criterion | `projectMonthlyCost` + CLI: transparent model with a tunable tier mix and cache-hit rate (~$743/mo at the stated assumptions) | `src/cost/projection.ts`, `npm run cost` |
| Able to teach (docs) | Required | 7 ADRs, an architecture doc, a 10-row failure-mode catalog, and a thorough README | `docs/`, `README.md` |

## Engineering bar

108 tests across 17 files at **98% statement / 89% branch** coverage, **0 npm
vulnerabilities**, strict TypeScript with zero `any`/`ts-ignore`/`eslint-disable`, and CI
green on Node 20 & 22 (typecheck → lint → build → coverage → eval). Each phase was built,
independently code-reviewed, and hardened before the next.

## What is a demonstrator vs. production

The mock model + hashing embedder keep the suite offline and deterministic, so the eval's
routing/groundedness numbers prove the **harness, gates, and guards** — not real-model
quality; a real provider re-runs the identical gates behind the same `ChatModel` /
`Embedder` interfaces. The self-improvement profile is a coarse count-based prior (no
recency/exploration), multilingual retrieval is lexical on the toy embedder, and the
in-memory stores need durable backends in production. All of this is called out in the
ADRs rather than glossed over.

## Beyond this repo

I've built on this exact TypeScript / LangGraph.js stack for a (non-public) client project
— this repo converts that experience into something inspectable. I'm glad to walk through
that work and my agentic-reasoning work (CURE-Bench) in a call, and to start with a short
paid trial auditing a slice of your current engine.
