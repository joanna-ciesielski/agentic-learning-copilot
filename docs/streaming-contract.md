# Streaming event contract — v1.0

**Status:** draft for review · **Date:** 2026-08 · **Schemas:** `src/streaming/events.ts` · **Rationale:** [ADR 0008](adr/0008-sse-streaming.md)

This is the interface between the copilot's streaming path and everything that
consumes it — the SSE endpoint, the demo client, and the parity tests. It is
versioned because other modules depend on it: additive changes bump the minor
version, removing or retyping a field bumps the major.

The contract is expressed twice: prose here, and executable zod schemas in
`src/streaming/events.ts`. The schemas are authoritative. Every outbound event is
validated against them in tests, and they are `.strict()`, so an accidental extra
field fails a test instead of silently becoming part of the contract.

---

## 1. Layering

Two layers, deliberately separable:

| Layer | Owns | Testable without |
| --- | --- | --- |
| **Event layer** — `Copilot.stream()` | Event catalog, sequencing, parity, guards | Any HTTP |
| **Transport layer** — SSE server | Framing, `id:`/`retry:`, heartbeats, ring buffer, backpressure | Any model |

The event layer emits a plain `AsyncIterable<CopilotEvent>`. Everything specific
to SSE — `Last-Event-ID`, ring buffers, `X-Accel-Buffering` — lives in the
transport layer. This is what makes a WebSocket or gRPC transport a swap rather
than a rewrite (ADR 0008), and it lets Phase 2 be fully tested before an HTTP
server exists.

## 2. Envelope

Every event carries `{seq, threadId, ts}` plus its discriminating `type`.

| Field | Type | Rule |
| --- | --- | --- |
| `seq` | positive int | Strictly increasing from `1` within one logical stream. |
| `threadId` | `^[A-Za-z0-9_-]{1,128}$` | Resume key; stable for the life of the stream. Client-supplied or server-generated (`randomUUID`). |
| `ts` | epoch ms int | From an injectable clock, so tests are deterministic and timer-free. |
| `type` | enum | One of the eight names in §3. |

**`seq` is strictly increasing, not contiguous.** Heartbeats consume a `seq` but
are never replayed on resume (§7), so a resumed client legitimately observes
gaps. Clients guard with `seq > lastSeq`, never `seq === lastSeq + 1`. For
gap detection on the answer itself, use `token.index`, which *is* contiguous.

**The contract version is not on the envelope.** It is advertised once per
response as `X-Streaming-Contract-Version: 1.0`. At stress-mode rates (1–5k
events/sec) a per-event version string is pure overhead.

## 3. Event catalog

| Type | Cardinality | Payload (beyond envelope) |
| --- | --- | --- |
| `route` | 0 or 1 | `vertical`, `confidence`, `viaFallback`, `prior` |
| `token` | 0..n | `index` (contiguous from 0), `text` (non-empty) |
| `citation` | 0 or 1 | `citations[]` of `{chunkId, docId, title}` |
| `usage` | 0 or 1 | `usage` mirroring `TurnUsage` |
| `note` | 0..n | `note` (one entry of `CopilotAnswer.notes`) |
| `done` | 0 or 1 | `tokenCount`, `answerBytes`, `answerSha256`, `score` |
| `error` | 0 or 1 | `code`, `message`, `retryable`, `partial` |
| `heartbeat` | 0..n | — |

`done` and `error` are **terminal** and mutually exclusive: exactly one of them
ends every stream, and nothing follows it.

### Why `done` carries parity witnesses

`tokenCount`, `answerBytes` and `answerSha256` let a client verify byte-equality
on its own rather than trusting the stream. The demo client asserts them and
turns the HUD red on mismatch — a visible demonstration of the invariant, not a
claim about it. `answerSha256` is lowercase hex SHA-256 over the answer's UTF-8
bytes, computed server-side with `node:crypto` (built in, no dependency).

## 4. Sequencing rules

1. **S1** — Exactly one terminal event (`done` | `error`) per stream. Nothing after it.
2. **S2** — `route` precedes every `token`, `citation`, `usage` and `done`.
3. **S3** — `citation` precedes the first `token`. Retrieval completes before the
   answer call, so citations are known first; showing sources while the answer
   streams is both honest and better UX.
4. **S4** — `token.index` runs `0..tokenCount-1` with no gaps and no repeats.
5. **S5** — `usage` is emitted exactly once, immediately before `done`.
6. **S6** — `note` may appear anywhere before the terminal event.
7. **S7** — `heartbeat` may appear anywhere before the terminal event and carries
   no semantic content.
8. **S8** — A declined turn emits no `route`, no `token`, no `citation`, no
   `usage`, and terminates with `error` (§6).

## 5. Parity invariants

Fixed decision 5: streamed output must equal non-streamed output. Stated
precisely, because the non-streamed path has a decline branch that emits no
answer text.

> **P1 — token parity.** For any request where `ask()` returns `declined === false`:
> `concat(token.text, in ascending index) === ask().answer`, byte for byte in UTF-8.
> Equivalently `answerSha256 === sha256(ask().answer)`.

> **P2 — decline parity.** For any request where `ask()` returns `declined === true`:
> the stream emits zero `token` events and terminates with a single `error` whose
> `message` equals `ask().answer` verbatim and whose `code` maps 1:1 to the decline
> reason. The user sees identical words on both paths.

> **P3 — partial termination.** If a stream fails after tokens have been emitted,
> it terminates with `error` and `partial: true`. Parity is *not* asserted for
> these streams; the client must not treat the accumulated text as an answer.

### A note on "mid-stream budget kill"

Budget is **reserved pre-flight** inside `DefaultModelGateway.complete()` — the
estimated prompt + `maxCompletionTokens` is added to the ledger *before* the
`await`, which is what closes the check-then-act race. A consequence for
streaming: with pre-flight reservation, the budget cannot run out *between two
tokens of the same answer*, because the whole answer was already reserved.

The realistic budget-kill window is **between the router call and the answer
call**. That is what the Phase 2 test must target — a test that tries to exhaust
the budget mid-token would be asserting a state the architecture cannot reach,
and would pass for the wrong reason. If incremental settlement is added later
(charging per chunk), P3 becomes reachable mid-answer and the test moves.

## 6. Error taxonomy

| Code | Raised when | `retryable` | Maps from |
| --- | --- | --- | --- |
| `RATE_LIMITED` | Per-user request cap reached | `false` | `RateLimiter.tryConsume` false |
| `IRRELEVANT_QUERY` | Relevance guard rejected the query | `false` | `RelevanceGuard.isRelevant` false |
| `BUDGET_EXCEEDED` | Org token budget exhausted | `false` | `remaining <= 0` pre-flight, or `BudgetExceededError` |
| `UPSTREAM_ERROR` | Model/provider or unexpected server failure | `true` | Any other thrown error |
| `RESUME_GAP` | `Last-Event-ID` no longer buffered | `true` | Transport layer only |

`message` is user-safe text. Internal detail (stack traces, provider messages,
org identifiers) never crosses the wire; it goes to the `Tracer` instead.

## 7. Resume semantics

Fixed decision 4: a bounded per-thread ring buffer, no persistence.

1. **R1** — The transport buffers the last `512` replayable events per thread,
   across at most `256` threads with LRU eviction of whole threads.
2. **R2** — Replayable = every event type **except `heartbeat`**. Heartbeats are
   written without an SSE `id:` line, so the client's resume cursor never points
   at one.
3. **R3** — On reconnect with `Last-Event-ID: <seq>`, the server replays buffered
   events with `seq > <seq>` in order, then continues live.
4. **R4** — If `<seq>` is older than the oldest buffered event, the server emits
   `error` with `code: RESUME_GAP`, `retryable: true`, and closes. The client
   discards its partial state and starts a **new** stream without
   `Last-Event-ID`. "Restarts cleanly" means client-driven restart: `seq` never
   rewinds within one logical stream.
5. **R5** — A malformed or non-integer `Last-Event-ID` is treated as absent.
6. **R6** — Buffers are in-memory and single-process. Multi-node resume requires
   sticky sessions or a shared log (Redis/Postgres) — documented as the
   production swap, explicitly out of scope.

## 8. Heartbeats

Cadence `15_000` ms of silence. A heartbeat is a named `heartbeat` event (fixed
decision 3) carrying the full envelope, written **without an `id:` line** and
**not stored in the ring buffer**. Rationale: `seq` is the stream's observability
counter, while `id:` is the resume cursor — conflating them would let an idle
connection advance the cursor past nothing, and would let 512 heartbeats evict a
turn's replayable events.

## 9. Transport binding (SSE)

Response headers:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
X-Streaming-Contract-Version: 1.0
```

Frame shape — one JSON object per `data:` line:

```
retry: 2000

event: token
id: 7
data: {"seq":7,"threadId":"t-1","ts":1700000000000,"type":"token","index":3,"text":"…"}

```

- The entire event object is JSON-encoded onto a **single** `data:` line, so
  literal newlines in `token.text` cannot break framing.
- `id:` is written for every replayable event, omitted for heartbeats (§8).
- `retry:` is sent once, first.
- Each frame ends with a blank line.

## 10. Unicode rules (parity preconditions)

The Arabic fixtures are the regression surface for the tokenizer bug class that
ADR 0007 fixed. Byte-equality is only preserved if chunking respects these:

1. **U1** — Chunk boundaries fall on **grapheme-cluster** boundaries
   (`Intl.Segmenter`, built in). Never split a surrogate pair, a combining mark,
   an Arabic diacritic, or a ZWJ sequence.
2. **U2** — No normalization. The server must not apply NFC/NFD; any rewrite
   breaks byte-equality with the non-streamed answer.
3. **U3** — No trimming, no whitespace collapsing, no BOM insertion. Leading and
   trailing whitespace in a chunk is content.
4. **U4** — `answerBytes` counts UTF-8 bytes, not UTF-16 code units, and not
   grapheme clusters. It is a byte-level witness on purpose.

## 11. Backpressure and slow clients

`res.write()` returning `false` means the socket buffer is full. The transport
pauses the producing iterator and resumes on `drain`. If a client stays behind
for more than a bounded number of queued events, the stream terminates with
`UPSTREAM_ERROR` and `partial: true` rather than growing memory without limit.
The bound is a server option; the default and the measured behaviour are recorded
in `docs/streaming-perf.md` in Phase 5.

## 12. Lifecycle

Client disconnect aborts the run: the transport signals an `AbortSignal`, the
event layer stops iterating, and no further model calls are made. Phase 3 asserts
this by mock call count, not by timing — an orphaned provider call is a real
cost leak, so it is a test, not a hope.

## 13. Out of scope for v1.0

Authentication and authorization on the endpoint; multi-node resume; persistence
of the event log; bidirectional client→server messaging (that is the WebSocket
swap in ADR 0008); per-event contract versioning.

## 14. Open questions for review

Listed rather than silently decided; each has a recommendation.

1. **Method naming.** The plan says `Copilot.run()` and `ChatModel.chat()`; the
   repo has `Copilot.ask()` and `ChatModel.complete()`. This contract targets the
   real names. Recommendation: `Copilot.stream()` beside `ask()`, and
   `ChatModel.streamComplete()` beside `complete()` — symmetry with the existing
   verb beats the plan's placeholder name.
2. **`answerSha256` on `done`.** An addition beyond the plan. It costs one hash
   over text already in memory and turns the parity invariant into something the
   client can check. Recommendation: keep.
3. **`score` on `done`.** `CopilotAnswer` carries a `TurnScore`; the plan's event
   list has nowhere to put it. Recommendation: nest it in `done` rather than add
   a ninth event type.
4. **Heartbeat without `id:`.** Reconciles fixed decision 3 (every event carries
   the envelope) with fixed decision 4 (the resume cursor must point at
   replayable events). Recommendation: as specified in §8.
5. **`RESUME_GAP` as a terminal `error`.** The plan says "emits `resume_gap` and
   restarts cleanly", but the fixed event catalog has no `resume_gap` type and
   `error` is terminal. Recommendation: terminal `error` + client-driven restart
   (§7 R4), so `seq` never rewinds.
