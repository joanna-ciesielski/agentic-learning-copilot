# ADR 0007 — Multilingual (Arabic + English) retrieval

**Status:** accepted · **Date:** 2026-07

## Context

The target platform serves Arabic and English learners, so retrieval must work in
both — a stated preferred requirement. The original tokenizer split on `[^a-z0-9]`,
which silently strips any non-Latin script: Arabic text tokenized to nothing, so
BM25 (and thus hybrid retrieval) could never match it.

## Decision

- **Unicode-aware tokenizer.** `tokenize` now splits on `[^\p{L}\p{N}]+` with the
  `u` flag, keeping letters/numbers from any script. This one change makes the
  lexical (BM25) path language-agnostic; the hashing embedder already tokenized on
  whitespace, so the dense path handled non-Latin text.
- **Bilingual fixture.** `MULTILINGUAL_CORPUS` gives one tenant parallel Arabic and
  English documents per vertical, with probes asserting a query in either language
  retrieves the same-language document.

## Consequences

- **+** Bilingual retrieval passes end to end offline, with no new dependency.
- **+** The fix generalizes beyond Arabic to any Unicode script.
- **−** Retrieval quality here is **lexical** on a toy hashing embedder — it
  separates languages because their tokens don't overlap, not because it understands
  them. Production uses an Arabic-capable embedding model (e.g. multilingual
  `text-embedding-3` or multilingual-e5) behind the same `Embedder` interface.
- **−** Spoken-content pipelines should report transcript **WER** (word error rate)
  per language; that belongs with the ingestion layer, noted but not built here.
- **−** No RTL/normalization handling (diacritics, tatweel, Arabic-Indic digits);
  a production tokenizer would normalize these.
