import type { ChatMessage, Responder } from "../llm/chatModel";
import { scoreVerticals } from "./keywords";

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

function systemText(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === "system")?.content ?? "";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A single deterministic Responder that stands in for a real LLM so the whole
 * graph runs offline with no keys. It inspects the system prompt to decide mode:
 *
 *  - Routing prompt  → emits a valid RouteSchema JSON object (keyword-derived
 *    vertical + a confidence that reflects how decisive the keywords were).
 *  - Answer prompt   → emits a short extractive answer from the first context
 *    passage, so demo output is grounded rather than an echo.
 *
 * This is explicitly a stand-in: Phase 2's eval swaps in a real provider behind
 * the same ChatModel interface and measures true routing/answer quality.
 */
export function offlineResponder(): Responder {
  return (messages) => {
    const system = systemText(messages);
    const user = lastUser(messages);

    if (system.includes("routing supervisor")) {
      const { courses, jobs } = scoreVerticals(user);
      const total = courses + jobs;
      const vertical = jobs > courses ? "jobs" : "courses";
      const confidence =
        total === 0 ? 0.3 : round2(Math.min(0.99, 0.55 + (Math.abs(courses - jobs) / total) * 0.44));
      return JSON.stringify({ vertical, confidence, reason: `kw courses=${courses} jobs=${jobs}` });
    }

    // Answer mode: extractive answer from the first "[1] Title: text" passage.
    // Deliberately does NOT echo the question — the answer contains only claims
    // grounded in retrieved context, so the eval harness scores groundedness
    // without needing to know anything about this responder's formatting.
    const firstPassage = user.match(/\[1\]\s*([^\n]+)/)?.[1]?.trim();
    if (firstPassage) {
      return `Based on the retrieved material — ${firstPassage}`;
    }
    return "I don't have material on that.";
  };
}
