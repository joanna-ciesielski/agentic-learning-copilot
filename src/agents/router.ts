import { z } from "zod";
import type { ChatModel, ChatMessage } from "../llm/chatModel";
import {
  asGateway,
  ZERO_USAGE,
  type ModelGateway,
  type CallUsage,
  type CompletionResult,
} from "../llm/modelGateway";
import { BudgetExceededError } from "../cost/budget";
import type { Cohort } from "../cost/modelRouter";
import { VERTICALS, type Vertical, type TenantScope } from "../core/types";
import { parseStructured } from "../core/structured";
import { keywordRoute } from "./keywords";

/** The structured contract the supervisor model must satisfy. The vertical enum
 *  is derived from VERTICALS (single source of truth). Anything outside this
 *  shape (an invented vertical, out-of-range confidence) is rejected by zod
 *  before it can influence routing. */
export const RouteSchema = z.object({
  vertical: z.enum(VERTICALS),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(""),
});
export type Route = z.infer<typeof RouteSchema>;

export interface RouteDecision {
  vertical: Vertical;
  confidence: number;
  reason: string;
  /** True when the model output was unusable/low-confidence and we fell back to
   *  the deterministic keyword router. Surfaced for observability. */
  viaFallback: boolean;
  /** Cost/usage of the routing model call (zero when it fell back without one). */
  usage: CallUsage;
}

/** Default scope for callers that route without a tenant (e.g. unit tests). */
export const DEFAULT_SCOPE: TenantScope = { orgId: "_local", userId: "_local" };

export const ROUTER_SYSTEM = `You are the routing supervisor for a learning & career copilot.
Classify the user's query into exactly ONE vertical:
- "courses": learning content — lessons, concepts, tutorials, study help, exams.
- "jobs": careers — job postings, roles, hiring, applications, salaries, interviews.
Respond with ONLY a JSON object, no prose:
{"vertical":"courses"|"jobs","confidence":<0..1>,"reason":"<short>"}`;

/**
 * Supervisor: classifies a query to a vertical using the injected model (via the
 * ModelGateway, so routing calls are tiered, budgeted, cached, and metered) with
 * a zod-validated structured contract. If the model output is malformed,
 * off-schema, or below the confidence threshold, it degrades to a deterministic
 * keyword router — so the public method ALWAYS returns a valid vertical. Budget
 * errors are NOT swallowed by the fallback: they propagate so the orchestrator
 * can decline the turn.
 */
export class Supervisor {
  private readonly gateway: ModelGateway;

  constructor(
    model: ChatModel | ModelGateway,
    private readonly minConfidence = 0.5,
  ) {
    this.gateway = asGateway(model);
  }

  /**
   * @param prior Optional profile-derived vertical (Zone-4 self-improvement). It
   * is used ONLY when the model is uncertain (low confidence, malformed, or
   * failed) — a confident model decision always wins. This is what lets a user's
   * accumulated profile change routing on later ambiguous turns.
   */
  async route(
    query: string,
    scope: TenantScope = DEFAULT_SCOPE,
    cohort: Cohort = "general",
    prior?: Vertical,
  ): Promise<RouteDecision> {
    const messages: ChatMessage[] = [
      { role: "system", content: ROUTER_SYSTEM },
      { role: "user", content: query },
    ];

    let res: CompletionResult;
    try {
      res = await this.gateway.complete(messages, { scope, task: "route", cohort });
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err; // let the orchestrator decline
      // Genuine model failure → prior (if any) else keyword routing (no usage).
      return {
        vertical: prior ?? keywordRoute(query),
        confidence: 0,
        reason: prior ? "profile-prior(model-error)" : "fallback:model-error",
        viaFallback: true,
        usage: ZERO_USAGE,
      };
    }

    const usage: CallUsage = toUsage(res);
    try {
      const parsed = parseStructured(RouteSchema, res.text); // throws on malformed/off-schema
      const reason = parsed.reason ?? "";
      if (parsed.confidence >= this.minConfidence) {
        return { vertical: parsed.vertical, confidence: parsed.confidence, reason, viaFallback: false, usage };
      }
      // Uncertain → prefer the profile prior when present, else the model's pick.
      const vertical = prior ?? parsed.vertical;
      return {
        vertical,
        confidence: parsed.confidence,
        reason: `${prior ? "profile-prior; " : ""}low-confidence(${parsed.confidence.toFixed(2)}); ${reason}`.trim(),
        viaFallback: true,
        usage,
      };
    } catch {
      return {
        vertical: prior ?? keywordRoute(query),
        confidence: 0,
        reason: prior ? "profile-prior(keyword)" : "fallback:keyword",
        viaFallback: true,
        usage,
      };
    }
  }
}

function toUsage(r: CompletionResult): CallUsage {
  return {
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    costUsd: r.costUsd,
    tier: r.tier,
    cached: r.cached,
    latencyMs: r.latencyMs,
  };
}
