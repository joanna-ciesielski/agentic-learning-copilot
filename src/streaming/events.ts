import { z } from "zod";
import { VERTICALS } from "../core/types";
import type { Tier } from "../cost/pricing";

/**
 * The streaming event contract (docs/streaming-contract.md).
 *
 * This module is CONTRACT-AS-CODE: schemas, types and constants only, no
 * behaviour. It is the single source of truth for what may cross the wire —
 * the SSE server validates outbound events against it, the parity/sequencing
 * tests assert against it, and the demo client's expectations are derived from
 * it. Every schema is `.strict()` so an accidentally added field is a test
 * failure rather than a silent contract drift.
 *
 * Versioning: the contract version is advertised once per response as the
 * `X-Streaming-Contract-Version` header, NOT on every event — at the stress-mode
 * event rates (1–5k events/sec) a per-event version field is pure overhead.
 * Additive, backward-compatible changes bump the minor version; removing or
 * retyping a field bumps the major version.
 */
export const STREAMING_CONTRACT_VERSION = "1.0";

/** The eight named event types. Fixed by the build plan; adding one is a minor
 *  version bump, removing one is a major bump. */
export const STREAM_EVENT_TYPES = [
  "route",
  "token",
  "citation",
  "usage",
  "note",
  "done",
  "error",
  "heartbeat",
] as const;
export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

/** Exactly one of these closes a stream; nothing may follow it. */
export const TERMINAL_EVENT_TYPES = ["done", "error"] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * Error taxonomy. Every stream that does not end in `done` ends in an `error`
 * carrying one of these codes — there is no untyped failure exit.
 *  - BUDGET_EXCEEDED  — org token budget exhausted (pre-flight or between calls).
 *  - RATE_LIMITED     — per-user request cap reached.
 *  - IRRELEVANT_QUERY — relevance guard rejected the query.
 *  - UPSTREAM_ERROR   — model/provider or unexpected server failure.
 *  - RESUME_GAP       — `Last-Event-ID` is no longer in the ring buffer.
 */
export const STREAM_ERROR_CODES = [
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "IRRELEVANT_QUERY",
  "UPSTREAM_ERROR",
  "RESUME_GAP",
] as const;
export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number];

/**
 * A `threadId` is attacker-controllable input that becomes a ring-buffer key, so
 * it is constrained rather than accepted as an arbitrary string: unbounded or
 * high-cardinality keys are a memory-growth vector even with LRU eviction.
 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ThreadIdSchema = z
  .string()
  .regex(THREAD_ID_PATTERN, "threadId must be 1–128 characters of [A-Za-z0-9_-]");

/**
 * Envelope carried by EVERY event (fixed decision 3).
 *  - `seq` — strictly increasing from 1 within one logical stream. Contiguous in
 *    a live segment; NOT contiguous across a resume, because heartbeats consume a
 *    seq but are never replayed. Clients must guard on "strictly increasing",
 *    never on "previous + 1".
 *  - `threadId` — resume key; stable for the life of the logical stream.
 *  - `ts` — epoch milliseconds from an injectable clock (deterministic in tests).
 */
const ENVELOPE_SHAPE = {
  seq: z.number().int().positive(),
  threadId: ThreadIdSchema,
  ts: z.number().int().nonnegative(),
};

export const EnvelopeSchema = z.object(ENVELOPE_SHAPE).strict();
export type StreamEnvelope = z.infer<typeof EnvelopeSchema>;

/** Mirrors `Tier` from src/cost/pricing.ts, checked in BOTH directions at
 *  compile time: a literal here that is not a `Tier` fails the generic
 *  constraint, and a `Tier` member missing here collapses the type to `never`,
 *  failing the `satisfies`. Either drift is a red build, not a runtime surprise. */
type ExhaustiveTiers<T extends readonly Tier[]> = [Tier] extends [T[number]] ? T : never;
const TIER_VALUES = ["frontier", "mid", "cheap"] as const;
export const TierSchema = z.enum(TIER_VALUES satisfies ExhaustiveTiers<typeof TIER_VALUES>);

/** Mirrors `Citation` from src/retrieval/types.ts. */
export const CitationSchema = z
  .object({
    chunkId: z.string().min(1),
    docId: z.string().min(1),
    title: z.string(),
  })
  .strict();

/** Mirrors `TurnUsage` from src/graph/copilot.ts. */
export const TurnUsagePayloadSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    tiers: z.array(TierSchema),
  })
  .strict();

/** Mirrors `TurnScore` from src/agents/scorer.ts. */
export const TurnScorePayloadSchema = z
  .object({
    grounded: z.boolean(),
    citations: z.number().int().nonnegative(),
    quality: z.number().min(0).max(1),
  })
  .strict();

/** Emitted once, immediately after the supervisor decides. Never on a declined
 *  turn (the decline happens before routing). */
export const RouteEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("route"),
    vertical: z.enum(VERTICALS),
    confidence: z.number().min(0).max(1),
    /** True when the model output was unusable and the keyword router decided. */
    viaFallback: z.boolean(),
    /** Zone-4 profile prior that was offered to the supervisor, if any. */
    prior: z.enum(VERTICALS).nullable(),
  })
  .strict();

/**
 * One answer chunk. `index` is the 0-based token ordinal and IS contiguous —
 * it is the client's gap detector, independent of `seq` (which counts all event
 * types). `text` is never empty and never normalized: see the Unicode rules in
 * the contract — byte-equality with the non-streamed answer depends on chunk
 * boundaries falling on grapheme-cluster boundaries and on no NFC/NFD rewriting.
 */
export const TokenEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("token"),
    index: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .strict();

/** Emitted at most once, after retrieval and BEFORE the first token, so a client
 *  can render sources while the answer is still arriving. Omitted entirely when
 *  retrieval was empty. */
export const CitationEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("citation"),
    citations: z.array(CitationSchema).min(1),
  })
  .strict();

/** Emitted exactly once, immediately before `done`. */
export const UsageEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("usage"),
    usage: TurnUsagePayloadSchema,
  })
  .strict();

/** Free-form observability note; mirrors one entry of `CopilotAnswer.notes`
 *  (e.g. `router:fallback(courses)`, `agent:empty-retrieval`). */
export const NoteEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("note"),
    note: z.string().min(1),
  })
  .strict();

/**
 * Terminal success. Carries the parity witnesses so a client can verify
 * byte-equality itself rather than trusting the stream:
 *  - `tokenCount`  — expected number of `token` events (0..tokenCount-1).
 *  - `answerBytes` — UTF-8 byte length of the full answer.
 *  - `answerSha256`— lowercase hex SHA-256 of the answer's UTF-8 bytes.
 */
export const DoneEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("done"),
    tokenCount: z.number().int().nonnegative(),
    answerBytes: z.number().int().nonnegative(),
    answerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    score: TurnScorePayloadSchema.nullable(),
  })
  .strict();

/**
 * Terminal failure or decline.
 *  - `message` — user-safe text. For a pre-flight decline it equals
 *    `CopilotAnswer.answer` verbatim, so the streamed and non-streamed paths
 *    show the user the same words (decline parity, P2 in the contract).
 *  - `retryable` — whether an immediate retry could succeed (RESUME_GAP and
 *    UPSTREAM_ERROR yes; RATE_LIMITED and BUDGET_EXCEEDED no, within the window).
 *  - `partial` — true when `token` events were already emitted, so the client
 *    knows the rendered text is incomplete and must not be treated as an answer.
 */
export const ErrorEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("error"),
    code: z.enum(STREAM_ERROR_CODES),
    message: z.string().min(1),
    retryable: z.boolean(),
    partial: z.boolean(),
  })
  .strict();

/**
 * Liveness only, every 15s of silence. It consumes a `seq` (fixed decision 3:
 * every event carries the envelope) but is written WITHOUT an SSE `id:` line and
 * is never stored in the ring buffer — the resume cursor must only ever point at
 * an event worth replaying.
 */
export const HeartbeatEventSchema = z
  .object({
    ...ENVELOPE_SHAPE,
    type: z.literal("heartbeat"),
  })
  .strict();

/** The wire union. Discriminated on `type` so a parse failure names the event. */
export const CopilotEventSchema = z.discriminatedUnion("type", [
  RouteEventSchema,
  TokenEventSchema,
  CitationEventSchema,
  UsageEventSchema,
  NoteEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
  HeartbeatEventSchema,
]);

export type RouteEvent = z.infer<typeof RouteEventSchema>;
export type TokenEvent = z.infer<typeof TokenEventSchema>;
export type CitationEvent = z.infer<typeof CitationEventSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type NoteEvent = z.infer<typeof NoteEventSchema>;
export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

/** Every event that may cross the wire. */
export type CopilotEvent = z.infer<typeof CopilotEventSchema>;

/** Heartbeat cadence, in milliseconds, after which liveness is asserted. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Ring-buffer capacity per thread, and thread count before LRU eviction. */
export const RING_BUFFER_EVENTS_PER_THREAD = 512;
export const RING_BUFFER_MAX_THREADS = 256;

/** SSE reconnect hint sent as the `retry:` field. */
export const SSE_RETRY_MS = 2_000;
