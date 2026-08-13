import type { ChatModel, ChatMessage } from "../llm/chatModel";
import {
  asGateway,
  isStreamingGateway,
  type ModelGateway,
  type CallUsage,
  type CompletionResult,
} from "../llm/modelGateway";
import type { Cohort } from "../cost/modelRouter";
import type { Vertical, TenantScope } from "../core/types";
import type { Citation, Retriever } from "../retrieval/types";
import { indexedChunks } from "../streaming/chunking";
import type { TurnStreamSink } from "../streaming/payloads";

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

  /**
   * @param sink Streaming-path emitter. When present the agent emits its
   * citation batch BEFORE the answer call (contract S3 — sources render while
   * the answer arrives) and its answer as token chunks. When absent, behaviour
   * is byte-identical to the pre-streaming implementation.
   */
  async run(
    query: string,
    scope: TenantScope,
    cohort: Cohort = "general",
    sink?: TurnStreamSink,
  ): Promise<AgentResult> {
    const hits = await this.retriever.retrieve(query, { orgId: scope.orgId, vertical: this.vertical }, this.k);

    if (hits.length === 0) {
      const answer = `I don't have material on that in the ${this.vertical} library for your organization.`;
      // Parity P1 covers this branch too: ask() returns this text with
      // declined=false, so the stream must carry it as token events even though
      // no model call happens. No citation event — there is nothing to cite.
      if (sink) {
        for (const chunk of indexedChunks(answer)) sink({ kind: "token", chunk });
      }
      return { answer, citations: [], grounded: false, usage: null };
    }

    const context = hits
      .map((h, i) => `[${i + 1}] ${h.chunk.title}: ${h.chunk.text}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: answerSystem(this.vertical) },
      { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
    ];

    const citations: Citation[] = hits.map((h) => ({
      chunkId: h.chunk.id,
      docId: h.chunk.docId,
      title: h.chunk.title,
    }));
    if (sink) sink({ kind: "citation", citations });

    const res = await this.completeMaybeStreaming(messages, scope, cohort, sink);

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

  /** One answer call, streamed when both the sink and the gateway allow it.
   *  All three branches settle through the same gateway accounting; the only
   *  variable is delivery. */
  private async completeMaybeStreaming(
    messages: ChatMessage[],
    scope: TenantScope,
    cohort: Cohort,
    sink: TurnStreamSink | undefined,
  ): Promise<CompletionResult> {
    const ctx = { scope, task: "answer" as const, cohort };

    if (!sink) return this.gateway.complete(messages, ctx);

    if (isStreamingGateway(this.gateway)) {
      // Drive .next() manually: `for await` would discard the generator's
      // return value, which carries the settled usage.
      const stream = this.gateway.streamComplete(messages, ctx);
      let next = await stream.next();
      while (!next.done) {
        sink({ kind: "token", chunk: next.value });
        next = await stream.next();
      }
      return next.value;
    }

    // Non-streaming gateway injected by a caller: parity degrades to a replay
    // of the complete answer as chunks, never to a different answer.
    const res = await this.gateway.complete(messages, ctx);
    for (const chunk of indexedChunks(res.text)) sink({ kind: "token", chunk });
    return res;
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
