import { Annotation } from "@langchain/langgraph";
import type { TenantScope, Vertical } from "../core/types";
import type { RouteDecision } from "../agents/router";
import type { Citation } from "../retrieval/types";
import type { Cohort } from "../cost/modelRouter";
import type { CallUsage } from "../llm/modelGateway";
import type { TurnScore } from "../agents/scorer";

/**
 * Typed LangGraph state channel for the copilot graph. Scalar channels are
 * last-write-wins; `notes` and `usage` accumulate across nodes. `routingPrior`
 * is the Zone-4 profile hint set by the orchestrator; `score` is written by the
 * scoring node that closes the self-improvement loop.
 */
export const CopilotState = Annotation.Root({
  query: Annotation<string>(),
  scope: Annotation<TenantScope>(),
  locale: Annotation<string>(),
  cohort: Annotation<Cohort>({ reducer: (_prev, next) => next, default: () => "general" }),
  routingPrior: Annotation<Vertical | null>({ reducer: (_prev, next) => next, default: () => null }),
  route: Annotation<RouteDecision>(),
  answer: Annotation<string>(),
  citations: Annotation<Citation[]>({ reducer: (_prev, next) => next, default: () => [] }),
  grounded: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  score: Annotation<TurnScore | null>({ reducer: (_prev, next) => next, default: () => null }),
  usage: Annotation<CallUsage[]>({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
  notes: Annotation<string[]>({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
});

export type CopilotStateType = typeof CopilotState.State;
