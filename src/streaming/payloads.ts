import type { Vertical } from "../core/types";
import type { Citation } from "../retrieval/types";
import type { TokenChunk } from "../llm/chatModel";

/**
 * Pre-envelope payloads emitted by graph nodes on the streaming path.
 *
 * Nodes are deliberately envelope-ignorant: they emit WHAT happened (a route
 * decision, an answer chunk, a citation batch, a note) and know nothing about
 * `seq`, `threadId` or `ts`. The envelope is applied in exactly one place —
 * `Copilot.stream()` — so monotonic sequencing needs no coordination between
 * nodes, and the contract's wire schema stays a single point of enforcement.
 */
export type TurnStreamPayload =
  | {
      kind: "route";
      vertical: Vertical;
      confidence: number;
      viaFallback: boolean;
      prior: Vertical | null;
    }
  | { kind: "citation"; citations: Citation[] }
  | { kind: "token"; chunk: TokenChunk }
  | { kind: "note"; note: string };

/** The sink a node writes payloads into. On the streaming path this is
 *  LangGraph's custom-mode `writer`; on the `ask()` path it is undefined and
 *  every emission is skipped. */
export type TurnStreamSink = (payload: TurnStreamPayload) => void;

/** Extract the custom-mode writer from a node's runtime config, if streaming.
 *  Structural on purpose: coupling to the shape (`writer?: fn`) rather than to
 *  LangGraph's config type keeps the graph code insulated from upstream type
 *  churn — the probe-verified behaviour is the dependency, not the type name. */
export function sinkOf(config: unknown): TurnStreamSink | undefined {
  const writer = (config as { writer?: unknown } | undefined)?.writer;
  return typeof writer === "function" ? (writer as TurnStreamSink) : undefined;
}
