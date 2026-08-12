import { describe, it, expect } from "vitest";
import {
  CopilotEventSchema,
  EnvelopeSchema,
  ThreadIdSchema,
  STREAM_EVENT_TYPES,
  STREAM_ERROR_CODES,
  STREAMING_CONTRACT_VERSION,
  TokenEventSchema,
  DoneEventSchema,
  type CopilotEvent,
  type StreamEventType,
} from "../src/streaming/events";

/**
 * Contract test for docs/streaming-contract.md v1.0. Phase 0 ships the contract
 * only, so this asserts the SHAPE of the wire format — that a canonical example
 * of each of the eight event types validates, that the schemas are strict enough
 * to catch drift, and that the constants match the documented contract. The
 * behavioural invariants (parity, sequencing, resume) are tested against the
 * implementation in Phases 1–3.
 */

const ENVELOPE = { seq: 1, threadId: "t-abc_123", ts: 1_700_000_000_000 };

/** One canonical example per event type, keyed by type so the coverage of the
 *  catalog is checked rather than assumed. */
const SAMPLES: Record<StreamEventType, Record<string, unknown>> = {
  route: { ...ENVELOPE, type: "route", vertical: "courses", confidence: 0.91, viaFallback: false, prior: null },
  token: { ...ENVELOPE, type: "token", index: 0, text: "Photo" },
  citation: {
    ...ENVELOPE,
    type: "citation",
    citations: [{ chunkId: "doc-1#0", docId: "doc-1", title: "Databases 101" }],
  },
  usage: {
    ...ENVELOPE,
    type: "usage",
    usage: {
      calls: 2,
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      costUsd: 0.0004,
      latencyMs: 12,
      cacheHits: 0,
      tiers: ["cheap", "mid"],
    },
  },
  note: { ...ENVELOPE, type: "note", note: "router:fallback(courses)" },
  done: {
    ...ENVELOPE,
    type: "done",
    tokenCount: 3,
    answerBytes: 17,
    answerSha256: "a".repeat(64),
    score: { grounded: true, citations: 2, quality: 0.8 },
  },
  error: {
    ...ENVELOPE,
    type: "error",
    code: "RATE_LIMITED",
    message: "Request declined — rate-limit: per-user request cap reached.",
    retryable: false,
    partial: false,
  },
  heartbeat: { ...ENVELOPE, type: "heartbeat" },
};

describe("streaming contract v1.0 — event catalog", () => {
  it("declares exactly the eight documented event types", () => {
    expect([...STREAM_EVENT_TYPES]).toEqual([
      "route",
      "token",
      "citation",
      "usage",
      "note",
      "done",
      "error",
      "heartbeat",
    ]);
    expect(Object.keys(SAMPLES).sort()).toEqual([...STREAM_EVENT_TYPES].sort());
  });

  it.each([...STREAM_EVENT_TYPES])("validates a canonical %s event", (type) => {
    const parsed = CopilotEventSchema.parse(SAMPLES[type]) as CopilotEvent;
    expect(parsed.type).toBe(type);
    expect(parsed.seq).toBe(1);
    expect(parsed.threadId).toBe("t-abc_123");
  });

  it("declares the documented error taxonomy", () => {
    expect([...STREAM_ERROR_CODES]).toEqual([
      "BUDGET_EXCEEDED",
      "RATE_LIMITED",
      "IRRELEVANT_QUERY",
      "UPSTREAM_ERROR",
      "RESUME_GAP",
    ]);
    expect(STREAMING_CONTRACT_VERSION).toBe("1.0");
  });
});

describe("streaming contract v1.0 — drift guards", () => {
  it("rejects an unknown field on any event (strict schemas catch contract drift)", () => {
    const drifted = { ...SAMPLES.token, latencyMs: 3 };
    expect(CopilotEventSchema.safeParse(drifted).success).toBe(false);
  });

  it("requires the full envelope on every event", () => {
    const noSeq = { threadId: ENVELOPE.threadId, ts: ENVELOPE.ts };
    expect(EnvelopeSchema.safeParse(noSeq).success).toBe(false);
    expect(CopilotEventSchema.safeParse({ ...noSeq, type: "heartbeat" }).success).toBe(false);
  });

  it("requires seq to start at 1 and be a positive integer", () => {
    expect(CopilotEventSchema.safeParse({ ...SAMPLES.heartbeat, seq: 0 }).success).toBe(false);
    expect(CopilotEventSchema.safeParse({ ...SAMPLES.heartbeat, seq: 1.5 }).success).toBe(false);
  });

  it("constrains threadId so an attacker cannot use it as an unbounded buffer key", () => {
    expect(ThreadIdSchema.safeParse("ok-thread_1").success).toBe(true);
    expect(ThreadIdSchema.safeParse("").success).toBe(false);
    expect(ThreadIdSchema.safeParse("../etc/passwd").success).toBe(false);
    expect(ThreadIdSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("rejects an empty token chunk (a token event must carry text)", () => {
    expect(TokenEventSchema.safeParse({ ...SAMPLES.token, text: "" }).success).toBe(false);
  });

  it("requires a well-formed sha-256 parity witness on done", () => {
    expect(DoneEventSchema.safeParse({ ...SAMPLES.done, answerSha256: "not-a-hash" }).success).toBe(false);
  });

  it("accepts multi-byte token text unchanged (Arabic parity precondition)", () => {
    const arabic = "التمثيل";
    const parsed = TokenEventSchema.parse({ ...SAMPLES.token, text: arabic });
    expect(parsed.text).toBe(arabic);
    expect(Buffer.from(parsed.text, "utf8").equals(Buffer.from(arabic, "utf8"))).toBe(true);
  });
});
