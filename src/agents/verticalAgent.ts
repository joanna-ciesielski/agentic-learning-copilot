import type { ChatModel, ChatMessage } from "../llm/chatModel";
import { asGateway, type ModelGateway, type CallUsage } from "../llm/modelGateway";
import type { Cohort } from "../cost/modelRouter";
import type { Vertical, TenantScope } from "../core/types";
import type { Citation, Retriever } from "../retrieval/types";

export interface AgentResult {
  answer: string;
  citations: Citation[];
  /** False when retrieval returned nothing — the agent declines instead of
   *  hallucinating, and this is surfaced so the graph can note it. */
  grounded: boolean;
  /** Cost/usage of the answer model call; null when retrieval was empty (no call). */
  usage: CallUsage | null;
}

function answerSystem(vertical: Vertical): string {
  return `You are the ${vertical} specialist for a learning & career copilot.
Answer the user's question using ONLY the numbered context passages provided.
If the context does not contain the answer, say you don't have material on it.
Be concise and do not invent sources.`;
}

/**
 * A vertical RAG agent (Courses or Jobs). It retrieves tenant+vertical-scoped
 * context, then asks the model (via the ModelGateway — tiered, budgeted, cached,
 * metered) to answer grounded in that context. Citations are taken from what was
 * actually retrieved, never from the model's output, so they cannot be
 * hallucinated. Empty retrieval short-circuits to a safe decline with no spend.
 */
export class VerticalAgent {
  private readonly gateway: ModelGateway;

  constructor(
    readonly vertical: Vertical,
    private readonly retriever: Retriever,
    model: ChatModel | ModelGateway,
    private readonly k = 4,
  ) {
    this.gateway = asGateway(model);
  }

  async run(query: string, scope: TenantScope, cohort: Cohort = "general"): Promise<AgentResult> {
    const hits = await this.retriever.retrieve(query, { orgId: scope.orgId, vertical: this.vertical }, this.k);

    if (hits.length === 0) {
      return {
        answer: `I don't have material on that in the ${this.vertical} library for your organization.`,
        citations: [],
        grounded: false,
        usage: null,
      };
    }

    const context = hits
      .map((h, i) => `[${i + 1}] ${h.chunk.title}: ${h.chunk.text}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: answerSystem(this.vertical) },
      { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
    ];

    const res = await this.gateway.complete(messages, { scope, task: "answer", cohort });
    const citations: Citation[] = hits.map((h) => ({
      chunkId: h.chunk.id,
      docId: h.chunk.docId,
      title: h.chunk.title,
    }));

    return {
      answer: res.text,
      citations,
      grounded: true,
      usage: {
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        totalTokens: res.totalTokens,
        costUsd: res.costUsd,
        tier: res.tier,
        cached: res.cached,
        latencyMs: res.latencyMs,
      },
    };
  }
}

export function makeVerticalAgent(
  vertical: Vertical,
  retriever: Retriever,
  model: ChatModel | ModelGateway,
  k = 4,
): VerticalAgent {
  return new VerticalAgent(vertical, retriever, model, k);
}
