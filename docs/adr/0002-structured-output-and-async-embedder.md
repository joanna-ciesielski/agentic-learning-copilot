# ADR 0002 — Async embedder interface & tolerant structured-output parsing

**Status:** accepted · **Date:** 2026-07

## Context

Two seams sit between our code and real LLM providers, and both are easy to get
subtly wrong in a way that only bites once a live provider replaces the mock:

1. **Embedding interface shape.** The offline hashing embedder is pure and
   synchronous, but every real embedding provider (OpenAI, multilingual models)
   is network-bound and asynchronous.
2. **Model output parsing.** Models — even in "JSON mode" — routinely wrap JSON
   in ```` ```json ```` fences or a sentence of prose. A bare `JSON.parse` throws
   on all of that.

## Decision

- **`Embedder.embed` returns `Promise<number[][]>`** even though the only current
  implementation is synchronous. Committing to the async contract now means the
  real provider drops in behind the interface with no breaking change to callers
  or the retriever.
- **`parseStructured` extracts before it validates.** `extractJson` strips a
  surrounding code fence, then scans for the first balanced `{…}`/`[…]` block
  (respecting strings and escapes) before `JSON.parse` + zod. Genuinely
  unparseable or off-schema output throws `StructuredOutputError` so the caller
  can retry or fall back.

## Consequences

- **+** The interfaces survive contact with real providers; Phase 1 built on them
  without churn.
- **+** The supervisor can trust `parseStructured` to reject invalid output
  cleanly, which is what lets it guarantee a valid route via fallback.
- **−** `embed` is `async` for a synchronous impl, so tests must `await` it — a
  trivial cost paid once.
