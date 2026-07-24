import type { ChatModel } from "../llm/chatModel";
import type { Embedder } from "../embeddings/hashingEmbedder";
import { HashingEmbedder } from "../embeddings/hashingEmbedder";
import type { TenantScope } from "../core/types";
import type { Citation, SourceDoc } from "../retrieval/types";
import { HybridRetriever } from "../retrieval/hybridRetriever";
import { Supervisor, type RouteDecision } from "../agents/router";
import { makeVerticalAgent } from "../agents/verticalAgent";
import { buildGraph, type GraphDeps } from "./build";
import { DefaultModelGateway, type CallUsage } from "../llm/modelGateway";
import { BudgetExceededError, type BudgetLedger } from "../cost/budget";
import type { RateLimiter } from "../cost/rateLimiter";
import type { RelevanceGuard } from "../cost/relevanceGuard";
import type { MetricsSink } from "../cost/metrics";
import type { ModelRouter, Cohort } from "../cost/modelRouter";
import type { ResponseCache } from "../cost/cache";
import type { Tier } from "../cost/pricing";
import { Scorer, type TurnScore } from "../agents/scorer";
import type { ProfileStore } from "../memory/profile";
import { NULL_TRACER, type Tracer } from "../observability/tracer";

export interface CopilotRequest {
  query: string;
  scope: TenantScope;
  locale?: string;
  cohort?: Cohort;
}

/** Aggregated cost/usage across every model call in one turn. */
export interface TurnUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheHits: number;
  tiers: Tier[];
}

export interface CopilotAnswer {
  query: string;
  /** Null when the turn was declined pre-flight (rate/relevance/budget). */
  route: RouteDecision | null;
  answer: string;
  citations: Citation[];
  notes: string[];
  usage: TurnUsage;
  /** Zone-4 turn score; null when declined. */
  score: TurnScore | null;
  declined: boolean;
}

export interface CopilotGuards {
  budget?: BudgetLedger;
  rateLimiter?: RateLimiter;
  relevanceGuard?: RelevanceGuard;
  /** Zone-4 self-improvement: reads a routing prior, records turn outcomes. */
  profileStore?: ProfileStore;
  /** Observability hook for turn lifecycle events. */
  tracer?: Tracer;
}

export interface CreateCopilotOptions {
  /** Single model backing all tiers (offline) … */
  model?: ChatModel;
  /** … or an explicit per-tier model map (production). One of model/models required. */
  models?: Record<Tier, ChatModel>;
  docs: SourceDoc[];
  embedder?: Embedder;
  k?: number;
  routerThreshold?: number;
  // Cost/abuse controls (all opt-in).
  budget?: BudgetLedger;
  rateLimiter?: RateLimiter;
  relevanceGuard?: RelevanceGuard;
  metrics?: MetricsSink;
  router?: ModelRouter;
  cache?: ResponseCache;
  clock?: () => number;
  maxCompletionTokens?: number;
  // Self-improvement + observability (opt-in).
  profileStore?: ProfileStore;
  scorer?: Scorer;
  tracer?: Tracer;
}

const EMPTY_USAGE: TurnUsage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  cacheHits: 0,
  tiers: [],
};

function summarize(calls: CallUsage[]): TurnUsage {
  const u: TurnUsage = { ...EMPTY_USAGE, calls: calls.length, tiers: [] };
  for (const c of calls) {
    u.promptTokens += c.promptTokens;
    u.completionTokens += c.completionTokens;
    u.totalTokens += c.totalTokens;
    u.costUsd += c.costUsd;
    u.latencyMs += c.latencyMs;
    if (c.cached) u.cacheHits++;
    u.tiers.push(c.tier);
  }
  return u;
}

/**
 * Thin wrapper around the compiled LangGraph graph (ADR-0001) plus the pre-flight
 * cost/abuse controls. `ask()` runs the anti-abuse and budget gates BEFORE any
 * model spend and degrades gracefully — a blocked or over-budget turn returns a
 * declined answer with a reason, never an exception or a partial charge.
 */
export class Copilot {
  private readonly graph: ReturnType<typeof buildGraph>;
  private readonly guards: CopilotGuards;

  constructor(deps: GraphDeps, guards: CopilotGuards = {}) {
    this.graph = buildGraph(deps);
    this.guards = guards;
  }

  async ask(req: CopilotRequest): Promise<CopilotAnswer> {
    const cohort = req.cohort ?? "general";
    const { orgId, userId } = req.scope;
    const { rateLimiter, relevanceGuard, budget, profileStore, tracer = NULL_TRACER } = this.guards;

    tracer.emit({ type: "turn.start", data: { orgId, userId, cohort, query: req.query } });

    // Pre-flight gates — reject before spending a single token.
    if (rateLimiter && !rateLimiter.tryConsume(userId)) {
      return this.declined(req, "rate-limit: per-user request cap reached", tracer);
    }
    if (relevanceGuard && !relevanceGuard.isRelevant(req.query)) {
      return this.declined(req, "off-topic: query outside supported domains", tracer);
    }
    if (budget && budget.remaining(orgId) <= 0) {
      return this.declined(req, "budget: org token budget exhausted", tracer);
    }

    // Zone-4: read this user's routing prior from their profile.
    const routingPrior = profileStore ? profileStore.preferredVertical(req.scope) : null;

    let out: Awaited<ReturnType<typeof this.graph.invoke>>;
    try {
      out = await this.graph.invoke({
        query: req.query,
        scope: req.scope,
        locale: req.locale ?? "en",
        cohort,
        routingPrior,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return this.declined(req, "budget: token budget exceeded mid-turn", tracer);
      }
      throw err;
    }

    const score = out.score;
    // Zone-4: record the turn outcome so the profile tunes later routing.
    if (profileStore && out.route) {
      profileStore.record(req.scope, out.route.vertical, out.grounded);
    }

    tracer.emit({ type: "turn.route", data: { vertical: out.route?.vertical, prior: routingPrior } });
    tracer.emit({ type: "turn.score", data: { grounded: score?.grounded, quality: score?.quality } });
    const usage = summarize(out.usage);
    tracer.emit({ type: "turn.end", data: { totalTokens: usage.totalTokens, costUsd: usage.costUsd } });

    return {
      query: req.query,
      route: out.route,
      answer: out.answer,
      citations: out.citations,
      notes: out.notes,
      usage,
      score,
      declined: false,
    };
  }

  private declined(req: CopilotRequest, reason: string, tracer: Tracer): CopilotAnswer {
    tracer.emit({ type: "turn.declined", data: { reason } });
    tracer.emit({ type: "turn.end", data: { declined: true } });
    return {
      query: req.query,
      route: null,
      answer: `Request declined — ${reason}.`,
      citations: [],
      notes: [`declined:${reason}`],
      usage: EMPTY_USAGE,
      score: null,
      declined: true,
    };
  }
}

/**
 * Ingest `docs` into a hybrid retriever and wire the supervisor + two vertical
 * agents behind a ModelGateway (tiering, budgets, caching, metrics) and the
 * pre-flight guards. Async because ingestion embeds the corpus.
 */
export async function createCopilot(opts: CreateCopilotOptions): Promise<Copilot> {
  const backing = opts.models ?? opts.model;
  if (!backing) throw new Error("createCopilot requires `model` or `models`");

  const embedder = opts.embedder ?? new HashingEmbedder();
  const retriever = await HybridRetriever.fromDocs(opts.docs, embedder);
  const k = opts.k ?? 4;

  const gateway = new DefaultModelGateway(backing, {
    router: opts.router,
    budget: opts.budget,
    cache: opts.cache,
    metrics: opts.metrics,
    clock: opts.clock,
    maxCompletionTokens: opts.maxCompletionTokens,
  });

  const deps: GraphDeps = {
    supervisor: new Supervisor(gateway, opts.routerThreshold ?? 0.5),
    courses: makeVerticalAgent("courses", retriever, gateway, k),
    jobs: makeVerticalAgent("jobs", retriever, gateway, k),
    scorer: opts.scorer,
  };

  return new Copilot(deps, {
    budget: opts.budget,
    rateLimiter: opts.rateLimiter,
    relevanceGuard: opts.relevanceGuard,
    profileStore: opts.profileStore,
    tracer: opts.tracer,
  });
}
