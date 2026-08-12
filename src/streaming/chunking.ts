/**
 * Grapheme-safe chunking for the streaming path.
 *
 * This is the load-bearing piece of the parity invariant (contract §10, U1–U4):
 * `chunkByGraphemes(text, n).join("") === text`, byte for byte, for any input and
 * any chunk size.
 *
 * Deliberately NOT built on `tokenize()` from src/retrieval/text.ts. That
 * tokenizer splits on `[^\p{L}\p{N}]+` and DISCARDS the separators — correct for
 * BM25, fatal here, because rejoining its output loses every space, newline and
 * punctuation mark. Chunking on a lossy tokenizer is the same bug class ADR 0007
 * fixed one layer down, so the chunker segments text without ever consulting it.
 */

/** Chunk size used when a caller does not specify one. Small enough that a demo
 *  visibly streams, large enough not to drown the client in events. */
export const DEFAULT_CHUNK_SIZE = 4;

/**
 * An explicit locale is passed rather than the runtime default: grapheme
 * segmentation is locale-invariant under UAX #29, but pinning it removes any
 * possibility of a CI machine's default locale changing chunk boundaries, which
 * would make streamed output non-reproducible across environments.
 */
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Split `text` into chunks of at most `size` grapheme clusters.
 *
 * Guarantees:
 *  - lossless — the chunks concatenate back to exactly `text`, with no
 *    normalization, trimming or whitespace collapsing;
 *  - no chunk is empty;
 *  - no chunk splits a grapheme cluster, so surrogate pairs, combining marks,
 *    Arabic harakat and ZWJ emoji sequences all stay intact;
 *  - deterministic — the same input always yields the same chunks.
 *
 * @throws RangeError if `size` is not a positive integer.
 */
export function chunkByGraphemes(text: string, size: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, received ${size}`);
  }
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let buffer = "";
  let held = 0;

  for (const { segment } of SEGMENTER.segment(text)) {
    buffer += segment;
    held += 1;
    if (held === size) {
      chunks.push(buffer);
      buffer = "";
      held = 0;
    }
  }
  if (buffer.length > 0) chunks.push(buffer);

  return chunks;
}
