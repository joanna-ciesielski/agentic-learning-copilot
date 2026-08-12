# ADR 0008 — SSE streaming for agent output

**Status:** accepted · **Date:** 2026-08

## Context

The copilot answers in one shot: `Copilot.ask()` runs the graph to completion and
returns a `CopilotAnswer`. For a multi-agent turn — supervisor call, retrieval,
answer call — the user waits with no signal, and the perceived latency is the
whole turn rather than the time to the first useful byte. Incremental delivery is
the single largest perceived-quality change available to this system.

Incremental delivery raises four separable decisions: what transport carries the
events, what runs the server, how a dropped connection recovers, and what
guarantees the streamed output has to keep. The fourth is the one that matters
most here: a streaming path that quietly produces *different* output from the
batch path is worse than no streaming path, because nothing downstream can trust
it. See [`docs/streaming-contract.md`](../streaming-contract.md) for the contract
this ADR justifies.

## Decision

### 1. Server-Sent Events, not WebSockets or long-polling

The data flow is unidirectional: the client posts a query and then only listens.
SSE matches that shape exactly and gives, for free, the two things a hand-rolled
streaming response would otherwise need: automatic reconnection and a
`Last-Event-ID` resume cursor. It is plain HTTP, so proxies, load balancers, and
corporate middleboxes treat it as an ordinary response.

- *WebSockets* buy bidirectionality this system does not use, and cost a protocol
  upgrade that some intermediaries block, a hand-written framing and reconnect
  layer, and a second code path for health checks and tracing. The swap is
  documented: if client→server messaging arrives (mid-turn steering, interactive
  tool approval), the event layer is transport-agnostic and moves unchanged.
- *HTTP long-polling* re-establishes a request per chunk. At token granularity
  the overhead dominates the payload, and ordering guarantees become the
  application's problem.

### 2. Native `node:http`, zero new runtime dependencies

The repo has three runtime dependencies. That discipline is itself part of what
the codebase demonstrates, and SSE framing is roughly fifty lines: set the
headers, write `event:`/`id:`/`data:` lines, end each frame with a blank line,
respect `write()` backpressure. A framework would add a dependency to save code
that is worth reading.

- Fastify or Hono are the documented production swaps — for routing, validation
  middleware, and HTTP/2 they earn their weight; for one endpoint they do not.
- The cost is honest: no router, no body-size limits beyond what is written by
  hand, no automatic content negotiation. Those are listed as out of scope in the
  contract rather than half-implemented.

### 3. Event layer separated from transport layer

`Copilot.stream()` yields `AsyncIterable<CopilotEvent>` and knows nothing about
HTTP. The SSE server adapts that iterable to the wire. This is what makes the
transport swap in decision 1 real rather than aspirational, and it means the
sequencing, parity, and guard behaviour are all testable with no socket open —
the same mock-first, offline-first posture as the rest of the repo (ADR 0002).

### 4. Bounded in-memory ring buffer for resume, not a persistent log

Each thread keeps its last 512 replayable events, with LRU eviction across at
most 256 threads. On reconnect, `Last-Event-ID` replays what is still buffered;
if the cursor has been evicted, the stream ends with a typed `RESUME_GAP` error
and the client starts fresh.

- A *persistent log* (Postgres, Redis Streams) would survive process restarts and
  work across nodes. It is the documented production swap. It also adds a
  service, a schema, a retention policy, and a dependency — for a demonstration
  that runs offline on one process, that trade is wrong.
- The bound is the point: an unbounded buffer keyed by a client-supplied
  `threadId` is a memory-exhaustion vector. The `threadId` is pattern-constrained
  for the same reason.

### 5. Parity is an invariant, enforced in CI

`concat(token.text) === ask().answer`, byte for byte, for every fixture including
the Arabic ones. The `done` event carries a SHA-256 of the answer so a client can
verify it independently. Chunk boundaries are taken at grapheme-cluster
boundaries and no normalization is applied — ADR 0007 fixed a tokenizer that
silently dropped non-Latin script, and chunking is the same bug class one layer
up.

The invariant is stated with its exceptions rather than as a slogan: a declined
turn streams no tokens and instead carries the decline text on the terminal
`error` event, so the words the user sees are identical on both paths. A stream
that fails after tokens have flowed is marked `partial` and asserts nothing.

### 6. Existing guards run on the streaming path unchanged

Rate limiter, relevance guard, budget ledger, and tenant scoping are enforced by
the same objects, in the same order, before the same spend. Streaming adds a
delivery mechanism; it does not add a second policy path. A turn that would be
declined by `ask()` is declined by `stream()`, with the same reason.

## Consequences

- **+** Time-to-first-token replaces time-to-answer as the latency the user feels.
- **+** The transport is swappable: the event layer has no HTTP in it.
- **+** Parity and guard behaviour are CI-gated, so the streaming path cannot
  drift away from the batch path without a red build.
- **+** Still zero new runtime dependencies; still fully offline in tests.
- **−** Resume is single-process and lossy past 512 events. Multi-node deployment
  needs sticky sessions or a shared log; that is stated, not solved.
- **−** No authentication on the endpoint. It is a demonstration server, and
  auth is the deployment layer's job — but it means the endpoint must not be
  exposed as-is.
- **−** Intermediaries can still buffer SSE despite `X-Accel-Buffering: no`.
  Heartbeats mitigate; behaviour behind a real proxy is untested and documented
  as such.
- **−** Two ways to invoke the copilot means two surfaces to keep in step. The
  parity test is what makes that maintainable rather than a standing risk.

## Addendum — to be recorded in Phase 2

Whether token events are sourced from LangGraph's own streaming API at v1.4.8 or
from the existing `Tracer` seam is decided by a spike at the start of Phase 2 and
appended here with the evidence that decided it.
