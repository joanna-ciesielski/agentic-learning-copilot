export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Provider-agnostic chat interface. Phase 1 adds OpenAI/Anthropic adapters;
 *  the mock keeps the whole pipeline offline and deterministic in tests. */
export interface ChatModel {
  readonly id: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export type Responder = (messages: ChatMessage[]) => string;

/**
 * Deterministic mock chat model. By default it echoes a marker + the last user
 * message so tests can assert wiring; pass a custom `responder` to script exact
 * (e.g. JSON) outputs for structured-output and routing tests.
 */
export class MockChatModel implements ChatModel {
  readonly id = "mock";

  constructor(private readonly responder: Responder = MockChatModel.defaultResponder) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.responder(messages);
  }

  static defaultResponder(messages: ChatMessage[]): string {
    const last = messages.at(-1)?.content ?? "";
    return `MOCK: ${last.slice(0, 60)}`;
  }
}
