# Agentic Learning & Career Copilot

> A LangGraph.js **supervisor + vertical-agents** system for a career-intelligence /
> upskilling platform — grounded by per-tenant hybrid retrieval, with evaluation,
> cost, and safety controls. **TypeScript · Node · LangGraph.js.**

[![CI](https://github.com/JoannaCiesielski/agentic-learning-copilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JoannaCiesielski/agentic-learning-copilot/actions/workflows/ci.yml)

**Status: all phases (0–4) complete.** A LangGraph.js supervisor routes each query to a
Courses or Jobs RAG agent over per-tenant hybrid retrieval, with zod-validated routing and
citations grounded in retrieval, backed by a versioned fixture eval gate; every model call
runs through a gateway enforcing per-org token budgets, multi-tier routing, caching,
metrics, and per-user abuse caps; and a Zone-4 self-improvement loop scores each turn into a
per-user profile that tunes routing on later turns, with Arabic/English multilingual
retrieval and tracing hooks. Every phase ships tested and CI-gated; the whole graph runs
offline.

## Why this exists

A demonstrator of a production-shaped agentic architecture: a supervisor agent routes
each learner query to specialized vertical agents (Courses, Jobs), each answering from
retrieved, tenant-scoped content with validated structured output — with regression
evals, per-org token budgets, and multi-tier model routing layered on top. The
architecture mirrors a real four-zone personalization engine (Surfaces → Agents →
Backends → Self-improvement loop).

## Quickstart

Requires Node 20+ (`.nvmrc` pins 20; CI runs Node 20 & 22).

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run lint            # eslint (flat config)
npm test                # vitest — runs fully OFFLINE, no API keys
npm run test:coverage   # vitest + v8 coverage, gated at 85% (stmts/branch/funcs/lines)
npm run build           # tsc emit → dist/ (JS + .d.ts + sourcemaps)
npm run demo -- --org acme "explain how photosynthesis works"   # offline end-to-end
npm run eval            # fixture eval; fails if routing/recall/groundedness regress
npm run cost            # monthly cost projection for ~10K learners
```

Everything runs with a deterministic hashing embedder and a mock chat model, so it needs
no network and no keys. Real providers (OpenAI/Anthropic) plug in behind the same
`ChatModel` / `Embedder` interfaces; copy `.env.example` to `.env` for those.

## Using it

```ts
import { createCopilot, MockChatModel, offlineResponder, CORPUS } from "agentic-learning-copilot";

const copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
const res = await copilot.ask({ query: "show me ML engineer jobs", scope: { orgId: "acme", userId: "u1" } });
// → res.route.vertical === "jobs"; res.citations are acme-only, grounded in retrieval
```

Swap `new MockChatModel(offlineResponder())` for a real OpenAI/Anthropic `ChatModel`
adapter and the same graph runs against a live model.

## What's here now (Phases 0–1)

**Core primitives (Phase 0).** Async `Embedder` (deterministic offline hashing impl),
provider-agnostic `ChatModel` + scriptable `MockChatModel`, and `parseStructured()` /
`extractJson()` — zod validation tolerant of the ```` ```json ```` fences and prose real
models emit.

**Agentic core (Phase 1).**

- **Supervisor** (`src/agents/router.ts`) — classifies each query to a vertical via the
  model under a zod contract (`RouteSchema`); malformed, off-schema, or low-confidence
  output degrades to a deterministic keyword router, so an **invalid agent can never be
  selected**.
- **Vertical RAG agents** (`src/agents/verticalAgent.ts`) — Courses & Jobs; retrieve
  tenant-scoped context and answer grounded in it. Citations come from what was actually
  retrieved, never from model claims. Empty retrieval → a safe decline, not a hallucination.
- **Hybrid retrieval** (`src/retrieval/`) — dense (embedding cosine) + BM25, fused with
  RRF. **Tenant + vertical isolation is the first step of every retrieve()**, so foreign
  content is never even a candidate. In-memory store; MongoDB Atlas / pgvector is the
  documented production swap.
- **LangGraph.js graph** (`src/graph/`) — `START → supervisor →(conditional)→ courses |
  jobs → synthesis → END`, typed state channel, behind a thin `Copilot` wrapper (ADR-0001).

**Eval + quality gate (Phase 2).**

- **Versioned fixtures** (`src/eval/dataset.ts`, `FIXTURE_VERSION`) — a two-tenant corpus
  (16 docs), a labeled routing set, and gold source-doc labels for retrieval.
- **Metrics** (`src/eval/metrics.ts`) — routing accuracy, precision@k / recall@k / MRR,
  a groundedness (answer-support) score, and cross-tenant leakage.
- **CI gate** (`npm run eval`, `src/eval/`) — fails the build if routing accuracy < 0.90,
  recall@k < 0.90, groundedness < 0.90, or **any** cross-tenant leak; thresholds live in one
  place (`EVAL_THRESHOLDS`). Current offline run: routing **95.8%**, recall@4 **100%**,
  groundedness **100%**, MRR **1.00**, tenant isolation **100%** (0 leaks / 4 probes).
- **Failure-mode catalog** — [`docs/failure-modes.md`](docs/failure-modes.md) documents 10
  failure modes and the guard + test for each.

**Cost discipline (Phase 3).** Every model call runs through a `ModelGateway` (`src/llm/`,
`src/cost/`) that:

- **Per-org token budgets** — pre-flight rejection (`BudgetExceededError`); an over-budget
  turn declines with **zero** model spend, and mid-turn overage degrades gracefully.
- **Multi-tier model routing** — `pickModel(cohort, task)`: routing never uses a frontier
  model; answering scales frontier/mid/cheap by cohort.
- **Caching** — content-hash embedding cache (a warm cache embeds 0) + response cache
  (messages + content version); cache hits cost nothing.
- **Metrics** — tokens/cost/latency/tier/cached emitted per call; per-turn usage is
  returned on every answer.
- **Anti-abuse** — per-user rate cap + a relevance guard, both pre-flight.
- **Cost projection** — `npm run cost` estimates monthly spend for ~10K learners with a
  tunable tier mix and cache-hit rate.

**Self-improvement, multilingual & tracing (Phase 4).**

- **Self-improvement loop** (`src/memory/`, `src/agents/scorer.ts`) — a `scoring` node
  grades each turn into a per-user `ProfileStore`; the supervisor reads a **routing prior**
  from it, used only when the model is uncertain, so the same ambiguous query routes
  differently once a user's grounded answers favor a vertical (verified end-to-end).
- **Multilingual** (`src/retrieval/text.ts`, `src/fixtures/multilingual.ts`) — a
  Unicode-aware tokenizer + an Arabic/English bilingual fixture; a query in either language
  retrieves the same-language document.
- **Tracing** (`src/observability/tracer.ts`) — turn-lifecycle events
  (`turn.start`/`route`/`score`/`end`) for a LangSmith/PostHog-style sink.

**Quality.** 108 tests (≥85% coverage gate) covering the Phase 1–4 DoD: 100% valid routing,
zero cross-tenant leakage (unit probes + gated eval metric), zod rejection of off-schema
output, a green end-to-end graph, the eval gate, the cost controls (budget pre-flight,
tier-by-cohort, warm-cache-free, per-user cap, metrics), profile-tuned routing across turns,
bilingual retrieval, and emitted trace events. Numbers are offline-fixture (deterministic
stand-in responder); a real provider re-runs the identical gates behind the same `ChatModel`.

## Roadmap

| Phase | Focus | Status |
| ----- | ----- | ------ |
| 0 | Scaffold + offline test harness | ✅ done |
| 1 | Supervisor + Courses/Jobs agents (LangGraph.js), per-agent RAG, tenant scoping | ✅ done |
| 2 | Fixture eval set + CI quality gate (routing accuracy, retrieval metrics, groundedness) | ✅ done |
| 3 | Cost discipline: per-org budgets, multi-tier routing, caching, metrics, anti-abuse | ✅ done |
| 4 | Self-improvement loop + multilingual (Arabic/English) + tracing | ✅ done |

See [`docs/architecture.md`](docs/architecture.md) for the full design, non-goals, and
effort estimate, and [`docs/adr/`](docs/adr) for architecture decision records.

## License

MIT — see [LICENSE](LICENSE).
