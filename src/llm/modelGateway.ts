import {
  streamOrFallback,
  type ChatModel,
  type ChatMessage,
  type TokenChunk,
} from "./chatModel";
import { chunkByGraphemes, DEFAULT_CHUNK_SIZE } from "../streaming/chunking";
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
  /**
   * Optional incremental delivery, accounted identically to `complete()`. The
   * generator's RETURN value is the settled `CompletionResult` — a `for await`
   * consumer sees only chunks, while a caller that needs usage drives `.next()`
   * itself and reads the final value. Optional for the same reason it is
   * optional on `ChatModel`: a gateway that cannot stream is still a gateway.
   */
  streamComplete?(
    messages: ChatMessage[],
    ctx: CallContext,
  ): AsyncGenerator<TokenChunk, CompletionResult>;
}

/** A gateway known to support incremental delivery. */
export interface StreamingModelGateway extends ModelGateway {
  streamComplete(
    messages: ChatMessage[],
    ctx: CallContext,
  ): AsyncGenerator<TokenChunk, CompletionResult>;
}

export function isModelGateway(x: unknown): x is ModelGateway {
  return typeof x === "object" && x !== null && (x as { isModelGateway?: unknown }).isModelGateway === true;
}

export function isStreamingGateway(gateway: ModelGateway): gateway is StreamingModelGateway {
  return typeof gateway.streamComplete === "function";
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
  /** Grapheme clusters per chunk when the gateway replays a cached answer. */
  streamChunkSize?: number;
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
 * `complete()` and `streamComplete()` run the SAME five steps through the same
 * private helpers. Streaming is a delivery mechanism, not a second accounting
 * path — there is no route through this class that spends tokens without a
 * reservation, a reconciliation and a metric.
 *
 * In offline mode a single ChatModel backs all tiers; in production `models` is a
 * per-tier map. The rest of the app depends only on this interface.
 */
export class DefaultModelGateway implements StreamingModelGateway {
  readonly isModelGateway = true as const;
  private readonly router: ModelRouter;
  private readonly clock: () => number;
  private readonly maxCompletionTokens: number;
  private readonly streamChunkSize: number;

  constructor(
    private readonly models: ChatModel | Record<Tier, ChatModel>,
    private readonly services: GatewayServices = {},
  ) {
    this.router = services.router ?? new CohortModelRouter();
    this.clock = services.clock ?? (() => Date.now());
    this.maxCompletionTokens = services.maxCompletionTokens ?? 256;
    this.streamChunkSize = services.streamChunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  private modelFor(tier: Tier): ChatModel {
    const m = this.models;
    if (isChatModel(m)) return m;
    return m[tier];
  }

  async complete(messages: ChatMessage[], ctx: CallContext): Promise<CompletionResult> {
    const tier = this.router.pickModel(ctx.cohort, ctx.task);

    const hit = this.cacheHit(messages, ctx, tier);
    if (hit) return hit;

    const { promptTokens, reserve } = this.reserve(ctx.scope.orgId, messages);
    const t0 = this.clock();
    let text: string;
    try {
      text = await this.modelFor(tier).complete(messages);
    } catch (err) {
      this.release(ctx.scope.orgId, reserve);
      throw err;
    }
    return this.settle(messages, ctx, tier, text, promptTokens, reserve, this.clock() - t0);
  }

  async *streamComplete(
    messages: ChatMessage[],
    ctx: CallContext,
  ): AsyncGenerator<TokenChunk, CompletionResult> {
    const tier = this.router.pickModel(ctx.cohort, ctx.task);

    const hit = this.cacheHit(messages, ctx, tier);
    if (hit) {
      // Replay the cached answer as chunks so a cache hit still looks like a
      // stream to the client. Boundaries need not match the live stream's — the
      // parity invariant is about concatenation, not about where chunks fall.
      yield* indexed(chunkByGraphemes(hit.text, this.streamChunkSize));
      return hit;
    }

    // Reserve BEFORE the first yield, for the same reason `complete()` reserves
    // before its await: two concurrent streams for one org must not both pass
    // the check and overspend.
    const { promptTokens, reserve } = this.reserve(ctx.scope.orgId, messages);
    const t0 = this.clock();
    // Creating the generator is inert — nothing runs until the first .next() —
    // so it is safe to create it here, where the finally below can reach it.
    const source = streamOrFallback(this.modelFor(tier), messages);
    let settled = false;
    try {
      let next = await source.next();
      while (!next.done) {
        yield next.value;
        next = await source.next();
      }
      const result = this.settle(
        messages,
        ctx,
        tier,
        next.value,
        promptTokens,
        reserve,
        this.clock() - t0,
      );
      settled = true;
      return result;
    } finally {
      // Covers a provider failure AND a consumer that abandons the stream early
      // (a `break` runs this generator's `return`, which lands here). Two leaks
      // to close, in this order:
      //  1. the budget reservation — released first, so a failing provider
      //     cleanup can never leave the org permanently short;
      //  2. the upstream generator — a manual .next() loop does not propagate
      //     close the way `for await` does, so without this the provider keeps
      //     generating tokens nobody reads (the orphaned call Phase 3's abort
      //     test asserts against). Safe on an already-finished generator.
      if (!settled) {
        this.release(ctx.scope.orgId, reserve);
        try {
          await source.return("");
        } catch {
          // Provider cleanup failures must not mask the original error or the
          // consumer's early return; the reservation is already released.
        }
      }
    }
  }

  /** Step 2. Cache hit → no spend. Keyed by org (see `settle`) so a cached
   *  response can never be served across tenants. */
  private cacheHit(
    messages: ChatMessage[],
    ctx: CallContext,
    tier: Tier,
  ): CompletionResult | undefined {
    const cachedText = this.services.cache?.get(messages, ctx.scope.orgId);
    if (cachedText === undefined) return undefined;
    const usage: CallUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      tier,
      cached: true,
      latencyMs: 0,
    };
    this.emit(ctx, this.services.metrics ?? NULL_METRICS, usage);
    return { text: cachedText, ...usage };
  }

  /** Step 3. RESERVE the estimated cost synchronously, before any await or
   *  yield, so two concurrent calls for the same org can't both pass the check
   *  and overspend (a check-then-act race). Throws if the reservation itself
   *  would exceed budget. */
  private reserve(orgId: string, messages: ChatMessage[]): { promptTokens: number; reserve: number } {
    const promptTokens = estimateMessagesTokens(messages);
    const reserve = promptTokens + this.maxCompletionTokens;
    const budget = this.services.budget;
    if (budget) {
      if (budget.wouldExceed(orgId, reserve)) {
        throw new BudgetExceededError(orgId, reserve, budget.remaining(orgId));
      }
      budget.add(orgId, reserve);
    }
    return { promptTokens, reserve };
  }

  /** Hand back an unused reservation. */
  private release(orgId: string, reserve: number): void {
    this.services.budget?.add(orgId, -reserve);
  }

  /** Steps 4–5. Reconcile the reservation down to actual spend, cache the
   *  response (namespaced by org, defense-in-depth), emit the metric. */
  private settle(
    messages: ChatMessage[],
    ctx: CallContext,
    tier: Tier,
    text: string,
    promptTokens: number,
    reserve: number,
    latencyMs: number,
  ): CompletionResult {
    const completionTokens = estimateTokens(text);
    this.services.budget?.add(ctx.scope.orgId, promptTokens + completionTokens - reserve);
    this.services.cache?.set(messages, text, ctx.scope.orgId);

    const usage: CallUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: costOf(tier, promptTokens, completionTokens),
      tier,
      cached: false,
      latencyMs,
    };
    this.emit(ctx, this.services.metrics ?? NULL_METRICS, usage);
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

/** Attach contiguous 0-based ordinals to pre-split text. */
function* indexed(pieces: string[]): Generator<TokenChunk> {
  let index = 0;
  for (const text of pieces) yield { index: index++, text };
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
