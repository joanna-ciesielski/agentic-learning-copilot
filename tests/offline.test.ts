import { describe, it, expect } from "vitest";
import { z } from "zod";
import { offlineResponder } from "../src/agents/offline";
import { parseStructured } from "../src/core/structured";
import type { ChatMessage } from "../src/llm/chatModel";
import { RouteSchema } from "../src/agents/router";

const respond = offlineResponder();
const ROUTER_SYS = "You are the routing supervisor ...";

describe("offlineResponder — routing mode", () => {
  it("emits valid RouteSchema JSON favoring the keyword-dominant vertical", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: ROUTER_SYS },
      { role: "user", content: "apply for a data analyst job" },
    ];
    const route = parseStructured(RouteSchema, respond(msgs));
    expect(route.vertical).toBe("jobs");
    expect(route.confidence).toBeGreaterThan(0.5);
  });

  it("returns a low-confidence courses default when there is no keyword signal", () => {
    const route = parseStructured(RouteSchema, respond([
      { role: "system", content: ROUTER_SYS },
      { role: "user", content: "hello there" },
    ]));
    expect(route.vertical).toBe("courses");
    expect(route.confidence).toBeCloseTo(0.3, 5);
  });
});

describe("offlineResponder — answer mode", () => {
  it("produces an extractive answer from the first context passage", () => {
    const out = respond([
      { role: "system", content: "You are the courses specialist ..." },
      { role: "user", content: "Context:\n[1] Photosynthesis: light to sugar\n\nQuestion: how?" },
    ]);
    expect(out).toContain("Photosynthesis");
    expect(out).toContain("light to sugar");
    // Answer must not echo the raw question — it should contain only grounded claims.
    expect(out).not.toContain("how?");
  });

  it("declines when there is no context passage", () => {
    const out = respond([{ role: "user", content: "just a bare question, no passages" }]);
    expect(out.toLowerCase()).toContain("don't have material");
  });

  it("scans past a trailing non-user message to find the last user turn", () => {
    const out = respond([
      { role: "user", content: "Context:\n[1] Orbit: ellipse\n\nQuestion: shape?" },
      { role: "assistant", content: "(thinking)" },
    ]);
    expect(out).toContain("Orbit");
  });

  it("handles an empty message list", () => {
    expect(respond([]).toLowerCase()).toContain("don't have material");
  });
});

// Sanity: the offline routing output always satisfies the real schema.
it("offline routing output always parses against RouteSchema", () => {
  const schema = RouteSchema;
  for (const q of ["learn biology", "hiring engineers", "", "random words here"]) {
    expect(() =>
      parseStructured(schema as z.ZodType<z.infer<typeof RouteSchema>>, respond([
        { role: "system", content: ROUTER_SYS },
        { role: "user", content: q },
      ])),
    ).not.toThrow();
  }
});
