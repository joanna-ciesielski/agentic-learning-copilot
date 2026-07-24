import { describe, it, expect } from "vitest";
import { MockChatModel, type ChatMessage } from "../src/llm/chatModel";

const msgs: ChatMessage[] = [
  { role: "system", content: "route this" },
  { role: "user", content: "which courses cover cell biology?" },
];

describe("MockChatModel", () => {
  it("defaults to a deterministic echo of the last message", async () => {
    const m = new MockChatModel();
    const out = await m.complete(msgs);
    expect(out).toContain("which courses cover cell biology?");
    expect(await m.complete(msgs)).toEqual(out); // deterministic
  });

  it("accepts a custom responder for scripted (e.g. JSON) outputs", async () => {
    const m = new MockChatModel(() => JSON.stringify({ agent: "courses" }));
    expect(await m.complete(msgs)).toBe('{"agent":"courses"}');
  });

  it("exposes a stable id", () => {
    expect(new MockChatModel().id).toBe("mock");
  });

  it("handles an empty message list without throwing", async () => {
    expect(await new MockChatModel().complete([])).toBe("MOCK: ");
  });
});
