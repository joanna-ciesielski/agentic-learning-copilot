import type { ChatModel, ChatMessage } from "./chatModel";
import type { TenantScope } from "../core/types";
import { estimateMessagesTokens, estimateTokens } from "../cost/tokens";
import { costOf, type Tier } from "../cost/pricing";
import { CohortModelRouter, type Cohort, type Task, type ModelRouter } from "../cost/modelRouter";
import { BudgetExceededError, type BudgetLedger } from "../cost/budget";
import { NULL_METRICS, type MetricsSink } from "../cost/metrics";
import type { ResponseCache } from "../cost/cache";

export interface CallContext {
  scope: TenantScope;
  task: Task;
  cohort: Cohort;
  requestId?: string;
}

/** Cost/usage record for a single model call. */
export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  tier: Tier;
  cached: boolean;
  latencyMs: number;
}

export interface CompletionResult extends CallUsage {
  text: string;
}

export interface ModelGateway {
  readonly isModelGateway: true;
  complete(messages: ChatMessage[], ctx: CallContext): Promise<CompletionResult>;
}

export function isModelGateway(x: unknown): x is ModelGateway {
  return typeof x === "object" && x !== null && (x as { isModelGateway?: unknown }).isModelGateway === true;
}

export interface GatewayServices {
  router?: ModelRouter;
  budget?: BudgetLedger;
  cache?: ResponseCache;
  metrics?: MetricsSink;
  /** Injectable clock for deterministic latency in tests. */
  clock?: () => number;
  /** Completion-token allowance used for the pre-flight budget estimate. */
  maxCompletionTokens?: number;
}

/**
 * The single choke point for model calls. Every call:
 *  1. picks a tier (multi-tier routing) from cohort + task,
 *  2. returns a cached response if present (no spend),
 *  3. rejects PRE-FLIGHT with BudgetExceededError if the estimated cost would
 *     push the org over budget (so no tokens are spent on a doomed call),
 *  4. calls the tier's model, settles actual token spend against the budget,
 *  5. caches the response and emits a metric (tokens/cost/latency/tier/cached).
 *
 * In offline mode a single ChatModel backs all tiers; in production `models` is a
 * per-tier map. The rest of the app depends only on this interface.
 */
export class DefaultModelGateway implements ModelGateway {
  readonly isModelGateway = true as const;
  private readonly router: ModelRouter;
  private readonly clock: () => number;
  private readonly maxCompletionTokens: number;

  constructor(
    private readonly models: ChatModel | Record<Tier, ChatModel>,
    private readonly services: GatewayServices = {},
  ) {
    this.router = services.router ?? new CohortModelRouter();
    this.clock = services.clock ?? (() => Date.now());
    this.maxCompletionTokens = services.maxCompletionTokens ?? 256;
  }

  private modelFor(tier: Tier): ChatModel {
    const m = this.models;
    if (isChatModel(m)) return m;
    return m[tier];
  }

  async complete(messages: ChatMessage[], ctx: CallContext): Promise<CompletionResult> {
    const tier = this.router.pickModel(ctx.cohort, ctx.task);
    const { budget, cache, metrics = NULL_METRICS } = this.services;

    // 2. Cache hit → no spend. Keyed by org (see set below) so a cached response
    //    can never be served across tenants.
    const cachedText = cache?.get(messages, ctx.scope.orgId);
    if (cachedText !== undefined) {
      const usage: CallUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        tier,
        cached: true,
        latencyMs: 0,
      };
      this.emit(ctx, metrics, usage);
      return { text: cachedText, ...usage };
    }

    // 3. Pre-flight budget: RESERVE the estimated cost synchronously, before the
    //    await, so two concurrent calls for the same org can't both pass the
    //    check and overspend (a check-then-act race). Reject if the reservation
    //    itself would exceed budget.
    const promptTokens = estimateMessagesTokens(messages);
    const reserve = promptTokens + this.maxCompletionTokens;
    if (budget) {
      if (budget.wouldExceed(ctx.scope.orgId, reserve)) {
        throw new BudgetExceededError(ctx.scope.orgId, reserve, budget.remaining(ctx.scope.orgId));
      }
      budget.add(ctx.scope.orgId, reserve);
    }

    // 4. Call the tier's model. Release the reservation if the call fails,
    //    otherwise reconcile it down to the ACTUAL token spend.
    const t0 = this.clock();
    let text: string;
    try {
      text = await this.modelFor(tier).complete(messages);
    } catch (err) {
      if (budget) budget.add(ctx.scope.orgId, -reserve);
      throw err;
    }
    const latencyMs = this.clock() - t0;
    const completionTokens = estimateTokens(text);
    if (budget) budget.add(ctx.scope.orgId, promptTokens + completionTokens - reserve);

    // 5. Cache (namespaced by org, defense-in-depth) + metric.
    cache?.set(messages, text, ctx.scope.orgId);
    const usage: CallUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: costOf(tier, promptTokens, completionTokens),
      tier,
      cached: false,
      latencyMs,
    };
    this.emit(ctx, metrics, usage);
    return { text, ...usage };
  }

  private emit(ctx: CallContext, metrics: MetricsSink, usage: CallUsage): void {
    metrics.record({
      requestId: ctx.requestId ?? "-",
      orgId: ctx.scope.orgId,
      userId: ctx.scope.userId,
      task: ctx.task,
      tier: usage.tier,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      latencyMs: usage.latencyMs,
      cached: usage.cached,
    });
  }
}

function isChatModel(x: ChatModel | Record<Tier, ChatModel>): x is ChatModel {
  return typeof (x as ChatModel).complete === "function";
}

/** Normalize a ChatModel or gateway into a gateway (ChatModel → zero-services
 *  passthrough that still counts tokens and picks a tier). */
export function asGateway(x: ChatModel | ModelGateway): ModelGateway {
  return isModelGateway(x) ? x : new DefaultModelGateway(x);
}

export const ZERO_USAGE: CallUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  tier: "mid",
  cached: false,
  latencyMs: 0,
};
