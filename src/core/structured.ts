import type { ZodType } from "zod";

/** Raised when model output isn't valid JSON or fails schema validation. */
export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Pull a JSON payload out of a raw model response.
 *
 * Real LLM output — even in "JSON mode" — routinely wraps the object in a
 * ```json … ``` code fence or a sentence of prose ("Sure, here's the result:").
 * A bare JSON.parse throws on all of that, so we (1) strip a surrounding
 * markdown fence, then (2) fall back to scanning for the first balanced JSON
 * object or array, respecting strings and escapes so braces inside string
 * values don't confuse the matcher. Returns the candidate JSON string, or null
 * if nothing parseable is present.
 */
export function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Strip a surrounding markdown code fence (``` or ```json).
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const body = (fence?.[1] ?? trimmed).trim();

  // 2. Fast path: the body already is JSON.
  if (body.startsWith("{") || body.startsWith("[")) return body;

  // 3. Otherwise scan for the first balanced {...} or [...] block.
  const start = body.search(/[{[]/);
  if (start === -1) return null;
  const open = body[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null; // unbalanced — no complete block found
}

/**
 * Parse + validate a model's raw string output against a zod schema — the TS
 * analog of the Python pipeline's pydantic layer. Tolerant of code fences and
 * surrounding prose (see extractJson); a schema mismatch or genuinely
 * unparseable output throws a clean StructuredOutputError so the caller can
 * retry or skip.
 */
export function parseStructured<T>(schema: ZodType<T>, raw: string): T {
  const candidate = extractJson(raw);
  if (candidate === null) {
    throw new StructuredOutputError("no JSON object or array found in output");
  }
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    throw new StructuredOutputError(`invalid JSON: ${(err as Error).message}`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new StructuredOutputError(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}
