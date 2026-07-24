import { describe, it, expect } from "vitest";
import { ProfileStore } from "../src/memory/profile";
import { Scorer } from "../src/agents/scorer";

const scope = { orgId: "acme", userId: "u1" };

describe("ProfileStore", () => {
  it("returns no prior until there is enough signal", () => {
    const s = new ProfileStore();
    expect(s.preferredVertical(scope)).toBeNull(); // 0 turns
    s.record(scope, "jobs", true);
    expect(s.preferredVertical(scope)).toBeNull(); // 1 turn < minTurns
  });

  it("accumulates grounded outcomes and yields a preferred vertical", () => {
    const s = new ProfileStore();
    s.record(scope, "jobs", true);
    s.record(scope, "jobs", true);
    const p = s.get(scope);
    expect(p.turns).toBe(2);
    expect(p.grounded.jobs).toBe(2);
    expect(s.preferredVertical(scope)).toBe("jobs");
  });

  it("returns null when the two verticals are tied", () => {
    const s = new ProfileStore();
    s.record(scope, "jobs", true);
    s.record(scope, "courses", true);
    expect(s.preferredVertical(scope)).toBeNull();
  });

  it("counts turns but not grounded credit for an ungrounded turn", () => {
    const s = new ProfileStore();
    s.record(scope, "courses", false);
    s.record(scope, "courses", false);
    expect(s.get(scope).turns).toBe(2);
    expect(s.get(scope).grounded.courses).toBe(0);
    expect(s.preferredVertical(scope)).toBeNull();
  });

  it("get() is a pure read — it does not create or persist a profile", () => {
    const s = new ProfileStore();
    const p = s.get(scope); // read an unseen user
    p.turns = 99; // mutating the returned object must not touch the store
    expect(s.get(scope).turns).toBe(0);
    expect(s.preferredVertical(scope)).toBeNull();
  });

  it("isolates profiles per user", () => {
    const s = new ProfileStore();
    s.record(scope, "jobs", true);
    s.record(scope, "jobs", true);
    const other = { orgId: "acme", userId: "u2" };
    expect(s.get(other).turns).toBe(0);
    expect(s.preferredVertical(other)).toBeNull();
  });
});

describe("Scorer", () => {
  const scorer = new Scorer();
  it("scores grounded-with-citations highest, ungrounded zero", () => {
    expect(scorer.score({ grounded: true, citations: 3 }).quality).toBe(1);
    expect(scorer.score({ grounded: true, citations: 0 }).quality).toBe(0.6);
    expect(scorer.score({ grounded: false, citations: 0 }).quality).toBe(0);
  });
});
