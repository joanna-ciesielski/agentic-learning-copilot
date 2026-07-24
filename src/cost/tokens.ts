import type { ChatMessage } from "../llm/chatModel";

/**
 * Coarse token estimator (~4 chars/token). Deterministic and offline — good
 * enough for budgets, cost projection, and pre-flight checks. A production build
 * swaps in the provider's real tokenizer behind this same function.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
