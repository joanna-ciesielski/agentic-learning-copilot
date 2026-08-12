import { StateGraph, START, END } from "@langchain/langgraph";
import { CopilotState } from "./state";
import type { Supervisor } from "../agents/router";
import type { VerticalAgent, AgentResult } from "../agents/verticalAgent";
import { Scorer } from "../agents/scorer";
import { sinkOf, type TurnStreamSink } from "../streaming/payloads";

export interface GraphDeps {
  supervisor: Supervisor;
  courses: VerticalAgent;
  jobs: VerticalAgent;
  /** Zone-4 scoring agent; a default is used if omitted. */
  scorer?: Scorer;
}

/** Notes are emitted live AND accumulated into state from the same array, so
 *  the streamed note events and `CopilotAnswer.notes` can never disagree. */
function noted(notes: string[], sink: TurnStreamSink | undefined): string[] {
  if (sink) for (const note of notes) sink({ kind: "note", note });
  return notes;
}

function agentUpdate(result: AgentResult, sink: TurnStreamSink | undefined) {
  return {
    answer: result.answer,
    citations: result.citations,
    grounded: result.grounded,
    usage: result.usage ? [result.usage] : [],
    notes: noted(result.grounded ? [] : [`agent:empty-retrieval`], sink),
  };
}

/**
 * Build and compile the copilot StateGraph:
 *
 *   START → supervisor →(conditional on route.vertical)→ courses | jobs
 *         → synthesis → score → END
 *
 * The conditional edge map only contains "courses" and "jobs"; the supervisor is
 * guaranteed to return one of those. `supervisor` consumes the Zone-4 routing
 * prior; `score` grades the turn (closing the self-improvement loop) and its
 * result is read by the orchestrator to update the user profile.
 */
export function buildGraph(deps: GraphDeps) {
  const scorer = deps.scorer ?? new Scorer();

  return new StateGraph(CopilotState)
    .addNode("supervisor", async (s, config) => {
      const sink = sinkOf(config);
      const route = await deps.supervisor.route(s.query, s.scope, s.cohort, s.routingPrior ?? undefined);
      if (sink) {
        sink({
          kind: "route",
          vertical: route.vertical,
          confidence: route.confidence,
          viaFallback: route.viaFallback,
          prior: s.routingPrior ?? null,
        });
      }
      return {
        route,
        usage: [route.usage],
        notes: noted(route.viaFallback ? [`router:fallback(${route.vertical})`] : [], sink),
      };
    })
    .addNode("courses", async (s, config) => {
      const sink = sinkOf(config);
      return agentUpdate(await deps.courses.run(s.query, s.scope, s.cohort, sink), sink);
    })
    .addNode("jobs", async (s, config) => {
      const sink = sinkOf(config);
      return agentUpdate(await deps.jobs.run(s.query, s.scope, s.cohort, sink), sink);
    })
    .addNode("synthesis", (s, config) => ({
      notes: noted([`synthesis:route=${s.route.vertical}`], sinkOf(config)),
    }))
    .addNode("scoring", (s) => ({
      score: scorer.score({ grounded: s.grounded, citations: s.citations.length }),
    }))
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", (s) => s.route.vertical, {
      courses: "courses",
      jobs: "jobs",
    })
    .addEdge("courses", "synthesis")
    .addEdge("jobs", "synthesis")
    .addEdge("synthesis", "scoring")
    .addEdge("scoring", END)
    .compile();
}
