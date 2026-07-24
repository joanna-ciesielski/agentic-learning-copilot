import { describe, it, expect, beforeAll } from "vitest";
import { createCopilot, type Copilot } from "../src/graph/copilot";
import { MockChatModel } from "../src/llm/chatModel";
import { offlineResponder } from "../src/agents/offline";
import { isVertical } from "../src/core/types";
import { CORPUS, TENANT_MARKERS } from "../src/fixtures/corpus";
import { ROUTING_SET } from "../src/fixtures/routing";

describe("Copilot end-to-end graph", () => {
  let copilot: Copilot;
  beforeAll(async () => {
    copilot = await createCopilot({ model: new MockChatModel(offlineResponder()), docs: CORPUS });
  });

  it("runs the full START→supervisor→agent→synthesis→END path", async () => {
    const res = await copilot.ask({ query: "explain photosynthesis", scope: { orgId: "acme", userId: "u1" } });
    expect(res.route?.vertical).toBe("courses");
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.notes.some((n) => n.startsWith("synthesis:"))).toBe(true);
  });

  it("routes a jobs query through the jobs agent", async () => {
    const res = await copilot.ask({ query: "show me open ML engineer jobs", scope: { orgId: "acme", userId: "u1" } });
    expect(res.route?.vertical).toBe("jobs");
    expect(res.citations.every((c) => c.docId.startsWith("acme-"))).toBe(true);
  });

  // DoD: 100% of the routing set routes to a valid agent through the whole graph.
  it("routes 100% of the routing set to a valid agent end-to-end", async () => {
    const answers = await Promise.all(
      ROUTING_SET.map((c) => copilot.ask({ query: c.query, scope: { orgId: "acme", userId: "u1" } })),
    );
    expect(answers.every((a) => a.route !== null && isVertical(a.route.vertical))).toBe(true);
  });

  // DoD: cross-tenant leakage = 0. Query each tenant's scope with the OTHER
  // tenant's unique markers/content; no citation or answer may reference the
  // foreign tenant.
  it("never leaks another tenant's content (marker probes)", async () => {
    // The queries lure toward the FOREIGN tenant's content semantically, but do
    // NOT paste the marker tokens themselves — so a foreign marker can only show
    // up in a citation or answer if tenant isolation actually broke.
    const probes = [
      { scope: { orgId: "acme", userId: "u1" }, query: "orbital mechanics kepler elliptical orbits", foreign: TENANT_MARKERS.globex },
      { scope: { orgId: "acme", userId: "u1" }, query: "frontend developer react design systems", foreign: TENANT_MARKERS.globex },
      { scope: { orgId: "globex", userId: "u2" }, query: "photosynthesis chlorophyll calvin cycle", foreign: TENANT_MARKERS.acme },
      { scope: { orgId: "globex", userId: "u2" }, query: "junior data analyst sql dashboards", foreign: TENANT_MARKERS.acme },
    ];

    for (const p of probes) {
      const res = await copilot.ask({ query: p.query, scope: p.scope });
      // No citation may belong to the foreign tenant.
      expect(res.citations.every((c) => c.docId.startsWith(`${p.scope.orgId}-`))).toBe(true);
      // The answer text must not contain a foreign marker token.
      for (const marker of p.foreign) {
        expect(res.answer).not.toContain(marker);
      }
    }
  });

  it("declines end-to-end (no citations, empty-retrieval note) when the org has no material", async () => {
    const res = await copilot.ask({ query: "explain anything at all", scope: { orgId: "ghost-org", userId: "x" } });
    expect(res.citations).toEqual([]);
    expect(res.notes).toContain("agent:empty-retrieval");
    expect(res.answer.toLowerCase()).toContain("don't have material");
  });

  it("degrades safely when a globex query has no matching material in that vertical", async () => {
    // Globex has no 'neural networks' course; agent should decline, not invent.
    const res = await copilot.ask({ query: "teach me backpropagation in neural networks", scope: { orgId: "globex", userId: "u2" } });
    expect(res.route?.vertical).toBe("courses");
    // Globex has exactly one course doc (orbital); retrieval still returns it, but
    // it must remain a globex citation — never an acme one.
    expect(res.citations.every((c) => c.docId.startsWith("globex-"))).toBe(true);
  });
});
