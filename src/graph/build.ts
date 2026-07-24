import { StateGraph, START, END } from "@langchain/langgraph";
import { CopilotState } from "./state";
import type { Supervisor } from "../agents/router";
import type { VerticalAgent, AgentResult } from "../agents/verticalAgent";
import { Scorer } from "../agents/scorer";

export interface GraphDeps {
  supervisor: Supervisor;
  courses: VerticalAgent;
  jobs: VerticalAgent;
  /** Zone-4 scoring agent; a default is used if omitted. */
  scorer?: Scorer;
}

function agentUpdate(result: AgentResult) {
  return {
    answer: result.answer,
    citations: result.citations,
    grounded: result.grounded,
    usage: result.usage ? [result.usage] : [],
    notes: result.grounded ? [] : [`agent:empty-retrieval`],
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
    .addNode("supervisor", async (s) => {
      const route = await deps.supervisor.route(s.query, s.scope, s.cohort, s.routingPrior ?? undefined);
      return {
        route,
        usage: [route.usage],
        notes: route.viaFallback ? [`router:fallback(${route.vertical})`] : [],
      };
    })
    .addNode("courses", async (s) => agentUpdate(await deps.courses.run(s.query, s.scope, s.cohort)))
    .addNode("jobs", async (s) => agentUpdate(await deps.jobs.run(s.query, s.scope, s.cohort)))
    .addNode("synthesis", (s) => ({ notes: [`synthesis:route=${s.route.vertical}`] }))
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
