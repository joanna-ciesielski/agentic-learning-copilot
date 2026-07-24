import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as api from "../src/index";

/** Smoke test: guards the public package surface so an accidental removal or
 *  rename of a barrel export fails CI rather than surfacing at a call site. */
describe("public API surface", () => {
  it("re-exports the expected runtime members", () => {
    expect(typeof api.HashingEmbedder).toBe("function");
    expect(typeof api.MockChatModel).toBe("function");
    expect(typeof api.parseStructured).toBe("function");
    expect(typeof api.extractJson).toBe("function");
    expect(typeof api.StructuredOutputError).toBe("function");
  });

  it("wires the primitives together end to end (offline)", async () => {
    const embedder = new api.HashingEmbedder(32);
    const [vec] = await embedder.embed(["hello world"]);
    expect(vec).toHaveLength(32);

    const model = new api.MockChatModel(() => '```json\n{"ok":true}\n```');
    const raw = await model.complete([{ role: "user", content: "ping" }]);
    const parsed = api.parseStructured(z.object({ ok: z.boolean() }), raw);
    expect(parsed).toEqual({ ok: true });
  });
});
