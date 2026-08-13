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
import {
  CopilotEventSchema,
  ThreadIdSchema,
  HEARTBEAT_INTERVAL_MS,
  type CopilotEvent,
  type StreamErrorCode,
} from "../streaming/events";
import type { TurnStreamPayload } from "../streaming/payloads";
import type { CopilotStateType } from "./state";
import { createHash, randomUUID } from "node:crypto";

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

export interface StreamOptions {
  /** Resume key carried on every event. Validated against the contract's
   *  pattern; generated when omitted. */
  threadId?: string;
  /** Injectable clock for the `ts` envelope field (deterministic tests). */
  clock?: () => number;
  /**
   * Silence threshold after which a `heartbeat` event is emitted (contract §8).
   * Heartbeats live in the EVENT layer, not the transport, because they consume
   * a `seq` from the stream's single monotonic counter — a transport-minted
   * heartbeat would race the next live event's seq and break monotonicity.
   * Defaults to the contract cadence; 0 disables.
   */
  heartbeatMs?: number;
  /** Cancels the underlying graph run (client abort → no orphaned model calls).
   *  On abort the stream simply stops — no terminal event is emitted, because
   *  the consumer that would read it is gone. */
  signal?: AbortSignal;
}

const HEARTBEAT_DUE: unique symbol = Symbol("heartbeat-due");

/** Race a pending pull against the heartbeat clock. The timer is always
 *  cleared — a stray timeout would hold the process open. */
async function nextOrHeartbeat<T>(pending: Promise<T>, ms: number): Promise<T | typeof HEARTBEAT_DUE> {
  if (ms <= 0) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof HEARTBEAT_DUE>((resolve) => {
        timer = setTimeout(() => resolve(HEARTBEAT_DUE), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The one place the decline wording lives. `ask()` returns it as the answer
 *  and `stream()` carries it on the error event, so P2 (identical words on both
 *  paths) is structural rather than a string kept in sync by hand. */
function declineAnswer(reason: string): string {
  return `Request declined — ${reason}.`;
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
    const { profileStore, tracer = NULL_TRACER } = this.guards;

    tracer.emit({ type: "turn.start", data: { orgId, userId, cohort, query: req.query } });

    // Pre-flight gates — reject before spending a single token.
    const preflight = this.preflightDecline(req);
    if (preflight) return this.declined(req, preflight.reason, tracer);

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

  /**
   * Streamed counterpart of `ask()`. Same graph, same guards, same side effects
   * (rate-limit consumption, profile record, tracer lifecycle) — the difference
   * is delivery: an AsyncIterable of contract events instead of one answer.
   *
   * Events are sourced from LangGraph's custom stream mode (nodes write
   * pre-envelope payloads; see ADR 0008 addendum). The envelope — monotonic
   * `seq`, `threadId`, `ts` — is applied here and nowhere else, and every
   * outbound event is validated against the contract schema, so a payload that
   * drifts from docs/streaming-contract.md fails loudly in CI rather than
   * quietly on the wire.
   *
   * Divergence from ask(), per contract §6: ask() rethrows unexpected errors;
   * stream() terminates with a typed UPSTREAM_ERROR event carrying no internal
   * detail (that goes to the tracer). A stream never ends in an exception once
   * the first event has been emitted.
   */
  async *stream(req: CopilotRequest, opts: StreamOptions = {}): AsyncGenerator<CopilotEvent, void> {
    const clock = opts.clock ?? (() => Date.now());
    const threadId = opts.threadId === undefined ? randomUUID() : ThreadIdSchema.parse(opts.threadId);
    let seq = 0;
    let tokenCount = 0;
    const make = (event: Record<string, unknown>): CopilotEvent =>
      CopilotEventSchema.parse({ seq: ++seq, threadId, ts: clock(), ...event });

    const cohort = req.cohort ?? "general";
    const { profileStore, tracer = NULL_TRACER } = this.guards;

    tracer.emit({
      type: "turn.start",
      data: { orgId: req.scope.orgId, userId: req.scope.userId, cohort, query: req.query },
    });

    const preflight = this.preflightDecline(req);
    if (preflight) {
      tracer.emit({ type: "turn.declined", data: { reason: preflight.reason } });
      tracer.emit({ type: "turn.end", data: { declined: true } });
      yield make({
        type: "error",
        code: preflight.code,
        message: declineAnswer(preflight.reason),
        retryable: false,
        partial: false,
      });
      return;
    }

    const routingPrior = profileStore ? profileStore.preferredVertical(req.scope) : null;
    const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    let out: CopilotStateType | undefined;

    try {
      const graphStream = (await this.graph.stream(
        { query: req.query, scope: req.scope, locale: req.locale ?? "en", cohort, routingPrior },
        { streamMode: ["custom", "values"], signal: opts.signal },
      )) as AsyncIterable<["custom", TurnStreamPayload] | ["values", CopilotStateType]>;

      const iterator = graphStream[Symbol.asyncIterator]();
      let pending: ReturnType<typeof iterator.next> | undefined;
      try {
        for (;;) {
          // Keep the SAME pending pull across heartbeats: the heartbeat loses
          // the race, it must not abandon (or double-pull) the graph.
          pending ??= iterator.next();
          const winner = await nextOrHeartbeat(pending, heartbeatMs);
          if (winner === HEARTBEAT_DUE) {
            yield make({ type: "heartbeat" });
            continue;
          }
          pending = undefined;
          if (winner.done) break;

          const [mode, payload] = winner.value;
          if (mode === "values") {
            // Cross-mode ordering is NOT guaranteed (probe-verified: a values
            // chunk can precede a node's late custom events), so the final state
            // is only recorded here; usage/done are emitted after the drain.
            out = payload;
            continue;
          }
          switch (payload.kind) {
            case "route":
              yield make({
                type: "route",
                vertical: payload.vertical,
                confidence: payload.confidence,
                viaFallback: payload.viaFallback,
                prior: payload.prior,
              });
              break;
            case "citation":
              yield make({ type: "citation", citations: payload.citations });
              break;
            case "token":
              tokenCount++;
              yield make({ type: "token", index: payload.chunk.index, text: payload.chunk.text });
              break;
            case "note":
              yield make({ type: "note", note: payload.note });
              break;
          }
        }
      } finally {
        // A consumer break lands here with the graph still live; closing the
        // iterator propagates cancellation down to the gateway and provider
        // (the Phase 1 machinery). Harmless on an already-finished iterator.
        try {
          await iterator.return?.(undefined as never);
        } catch {
          // Closing a failed stream must not mask the original error.
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) {
        // Client abort: the consumer is gone, so no terminal event is emitted.
        tracer.emit({ type: "turn.end", data: { aborted: true } });
        return;
      }
      if (err instanceof BudgetExceededError) {
        const reason = "budget: token budget exceeded mid-turn";
        tracer.emit({ type: "turn.declined", data: { reason } });
        tracer.emit({ type: "turn.end", data: { declined: true } });
        yield make({
          type: "error",
          code: "BUDGET_EXCEEDED",
          message: declineAnswer(reason),
          retryable: false,
          partial: tokenCount > 0,
        });
        return;
      }
      // Detail goes to the tracer; only a user-safe sentence crosses the wire.
      tracer.emit({ type: "turn.error", data: { message: err instanceof Error ? err.message : String(err) } });
      tracer.emit({ type: "turn.end", data: { failed: true } });
      yield make({
        type: "error",
        code: "UPSTREAM_ERROR",
        message: "The answer stream failed before completion.",
        retryable: true,
        partial: tokenCount > 0,
      });
      return;
    }

    if (!out) throw new Error("graph stream ended without a values chunk");

    if (profileStore && out.route) {
      profileStore.record(req.scope, out.route.vertical, out.grounded);
    }
    tracer.emit({ type: "turn.route", data: { vertical: out.route?.vertical, prior: routingPrior } });
    tracer.emit({ type: "turn.score", data: { grounded: out.score?.grounded, quality: out.score?.quality } });
    const usage = summarize(out.usage);
    tracer.emit({ type: "turn.end", data: { totalTokens: usage.totalTokens, costUsd: usage.costUsd } });

    yield make({ type: "usage", usage });
    yield make({
      type: "done",
      tokenCount,
      answerBytes: Buffer.byteLength(out.answer, "utf8"),
      answerSha256: createHash("sha256").update(out.answer, "utf8").digest("hex"),
      score: out.score ?? null,
    });
  }

  /** The three pre-flight gates, in the same order for ask() and stream(),
   *  mapped to the contract's error taxonomy. */
  private preflightDecline(
    req: CopilotRequest,
  ): { code: StreamErrorCode; reason: string } | null {
    const { rateLimiter, relevanceGuard, budget } = this.guards;
    if (rateLimiter && !rateLimiter.tryConsume(req.scope.userId)) {
      return { code: "RATE_LIMITED", reason: "rate-limit: per-user request cap reached" };
    }
    if (relevanceGuard && !relevanceGuard.isRelevant(req.query)) {
      return { code: "IRRELEVANT_QUERY", reason: "off-topic: query outside supported domains" };
    }
    if (budget && budget.remaining(req.scope.orgId) <= 0) {
      return { code: "BUDGET_EXCEEDED", reason: "budget: org token budget exhausted" };
    }
    return null;
  }

  private declined(req: CopilotRequest, reason: string, tracer: Tracer): CopilotAnswer {
    tracer.emit({ type: "turn.declined", data: { reason } });
    tracer.emit({ type: "turn.end", data: { declined: true } });
    return {
      query: req.query,
      route: null,
      answer: declineAnswer(reason),
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
