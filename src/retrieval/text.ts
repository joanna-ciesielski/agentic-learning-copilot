import type { SourceDoc, Chunk } from "./types";

/** Language-agnostic tokenizer shared by BM25 and any lexical logic: lowercase,
 *  split on any non-letter/non-number. Uses Unicode property classes (\p{L}\p{N})
 *  so non-Latin scripts (e.g. Arabic) tokenize correctly instead of being stripped
 *  to nothing — required for the multilingual corpus. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Structure-aware chunking: split on blank lines (paragraph / heading
 * boundaries), then greedily pack paragraphs up to `maxChars` so a chunk stays
 * topically coherent without exploding the chunk count. A document that yields
 * no paragraphs falls back to a single whole-text chunk.
 */
export function chunkDoc(doc: SourceDoc, maxChars = 400): Chunk[] {
  const paras = doc.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const packed: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 1 > maxChars) {
      packed.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
  }
  if (buf) packed.push(buf);
  if (packed.length === 0) packed.push(doc.text.trim());

  return packed.map((text, i) => ({
    id: `${doc.id}#${i}`,
    docId: doc.id,
    orgId: doc.orgId,
    vertical: doc.vertical,
    title: doc.title,
    text,
  }));
}
