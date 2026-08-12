import { chunkByGraphemes, DEFAULT_CHUNK_SIZE } from "../streaming/chunking";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/**
 * One incremental piece of a completion. `index` is the 0-based ordinal and is
 * contiguous across a completion, so a consumer can detect a dropped chunk
 * without inspecting the transport. `text` is never empty and is never
 * normalized — see docs/streaming-contract.md §10.
 */
export interface TokenChunk {
  index: number;
  text: string;
}

/** Provider-agnostic chat interface. Phase 1 adds OpenAI/Anthropic adapters;
 *  the mock keeps the whole pipeline offline and deterministic in tests. */
export interface ChatModel {
  readonly id: string;
  complete(messages: ChatMessage[]): Promise<string>;
  /**
   * Optional incremental delivery. Optional on purpose: not every provider
   * streams, and a model that cannot stream must remain a valid `ChatModel`
   * rather than being excluded from the type. Callers should go through
   * `streamOrFallback`, which degrades to a single chunk from `complete()`.
   *
   * Implementations MUST satisfy parity (contract P1): the concatenation of the
   * yielded `text` values is byte-identical to what `complete()` returns for the
   * same messages.
   */
  streamComplete?(messages: ChatMessage[]): AsyncIterable<TokenChunk>;
}

/** A `ChatModel` that is known to support incremental delivery. */
export interface StreamingChatModel extends ChatModel {
  streamComplete(messages: ChatMessage[]): AsyncIterable<TokenChunk>;
}

/** Narrowing guard, mirroring the `isModelGateway` pattern used for gateways. */
export function isStreamingChatModel(model: ChatModel): model is StreamingChatModel {
  return typeof model.streamComplete === "function";
}

/**
 * Stream from `model` if it can, otherwise fall back to a single chunk carrying
 * the whole of `complete()`. Parity holds trivially in the fallback case, which
 * is the point: a non-streaming provider degrades to a worse experience, never
 * to a different answer.
 *
 * Returns the full accumulated text as the generator's return value, so a caller
 * that needs to settle token spend or populate a cache does not have to
 * re-concatenate the chunks itself.
 */
export async function* streamOrFallback(
  model: ChatModel,
  messages: ChatMessage[],
): AsyncGenerator<TokenChunk, string> {
  if (isStreamingChatModel(model)) {
    let text = "";
    for await (const chunk of model.streamComplete(messages)) {
      text += chunk.text;
      yield chunk;
    }
    return text;
  }

  const text = await model.complete(messages);
  if (text.length > 0) yield { index: 0, text };
  return text;
}

export type Responder = (messages: ChatMessage[]) => string;

export interface MockChatModelOptions {
  /** Grapheme clusters per streamed chunk. */
  chunkSize?: number;
  /**
   * Artificial pause between chunks, for demos that need to look like a real
   * provider. Defaults to 0, which uses NO timer at all — so the streaming path
   * under test is pure async iteration and cannot depend on the clock.
   */
  delayMs?: number;
}

/**
 * Deterministic mock chat model. By default it echoes a marker + the last user
 * message so tests can assert wiring; pass a custom `responder` to script exact
 * (e.g. JSON) outputs for structured-output and routing tests.
 *
 * Streaming is derived from the same `responder` output that `complete()`
 * returns, chunked on grapheme boundaries — so parity is structural here, not
 * something the mock has to be careful about.
 */
export class MockChatModel implements StreamingChatModel {
  readonly id = "mock";
  private readonly chunkSize: number;
  private readonly delayMs: number;

  constructor(
    private readonly responder: Responder = MockChatModel.defaultResponder,
    options: MockChatModelOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.delayMs = options.delayMs ?? 0;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.responder(messages);
  }

  async *streamComplete(messages: ChatMessage[]): AsyncGenerator<TokenChunk> {
    const text = await this.complete(messages);
    let index = 0;
    for (const piece of chunkByGraphemes(text, this.chunkSize)) {
      if (this.delayMs > 0) await sleep(this.delayMs);
      yield { index: index++, text: piece };
    }
  }

  static defaultResponder(messages: ChatMessage[]): string {
    const last = messages.at(-1)?.content ?? "";
    return `MOCK: ${last.slice(0, 60)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
