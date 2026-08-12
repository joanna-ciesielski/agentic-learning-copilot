import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MockChatModel,
  isStreamingChatModel,
  streamOrFallback,
  type ChatMessage,
  type ChatModel,
  type TokenChunk,
} from "../src/llm/chatModel";
import { chunkByGraphemes, DEFAULT_CHUNK_SIZE } from "../src/streaming/chunking";
import { CORPUS } from "../src/fixtures/corpus";
import { MULTILINGUAL_CORPUS } from "../src/fixtures/multilingual";

/**
 * THE PARITY TEST. Fixed decision 5 of the build plan and P1 of
 * docs/streaming-contract.md: the concatenation of streamed chunks must be
 * byte-identical to the non-streamed answer, for every fixture, including the
 * Arabic ones. This file is written before the implementation it guards.
 *
 * "Byte-identical" is asserted on UTF-8 bytes, not on JS string equality, because
 * the failure mode this protects against — a chunker that normalizes, trims, or
 * splits a grapheme cluster — can produce strings that look equal in a diff.
 */

function expectByteEqual(actual: string, expected: string): void {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  expect(a.equals(b)).toBe(true);
}

async function collect(stream: AsyncIterable<TokenChunk>): Promise<TokenChunk[]> {
  const out: TokenChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function messagesFor(text: string): ChatMessage[] {
  return [{ role: "user", content: text }];
}

/** A model whose response is exactly the text under test, so parity is asserted
 *  against real fixture content rather than the mock's default marker. */
function echoModel(text: string, chunkSize?: number): MockChatModel {
  return new MockChatModel(
    () => text,
    chunkSize === undefined ? {} : { chunkSize },
  );
}

/** Unicode cases that break naive chunkers: a ZWJ emoji sequence is one grapheme
 *  across 11 UTF-16 code units; Arabic harakat are combining marks; a lone
 *  combining acute must stay attached to its base letter. */
const UNICODE_CASES: Record<string, string> = {
  empty: "",
  singleChar: "a",
  ascii: "The quick brown fox jumps over the lazy dog.",
  arabicPlain: "التمثيل الضوئي هو تحويل الطاقة الضوئية إلى طاقة كيميائية.",
  arabicDiacritics: "بِسْمِ ٱللَّٰهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
  combiningMark: "café résumé",
  zwjEmoji: "👩‍👩‍👧‍👦 family 👨‍💻 dev",
  surrogatePair: "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝕥𝕖𝕩𝕥",
  newlines: "line one\n\nline two\r\nline three",
  trailingSpace: "  padded  ",
  mixedRtlLtr: "Databases 101 — قواعد البيانات — SQL",
};

const FIXTURE_TEXTS: Record<string, string> = {
  ...Object.fromEntries(CORPUS.map((d) => [`corpus:${d.id}`, d.text])),
  ...Object.fromEntries(MULTILINGUAL_CORPUS.map((d) => [`multilingual:${d.id}`, d.text])),
  ...Object.fromEntries(Object.entries(UNICODE_CASES).map(([k, v]) => [`unicode:${k}`, v])),
};

const CHUNK_SIZES = [1, 2, 3, 4, 7, 64, 4096];

afterEach(() => {
  vi.useRealTimers();
});

describe("chunkByGraphemes — lossless by construction", () => {
  it.each(Object.keys(FIXTURE_TEXTS))("round-trips %s at every chunk size", (name) => {
    const text = FIXTURE_TEXTS[name] as string;
    for (const size of CHUNK_SIZES) {
      const chunks = chunkByGraphemes(text, size);
      expectByteEqual(chunks.join(""), text);
    }
  });

  it("never emits an empty chunk", () => {
    for (const text of Object.values(FIXTURE_TEXTS)) {
      for (const size of CHUNK_SIZES) {
        expect(chunkByGraphemes(text, size).every((c) => c.length > 0)).toBe(true);
      }
    }
  });

  it("never splits a grapheme cluster", () => {
    // Each chunk must contain a whole number of grapheme clusters: re-segmenting
    // a chunk and rejoining it must reproduce the chunk exactly, and no chunk may
    // contain an unpaired surrogate.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const text of Object.values(FIXTURE_TEXTS)) {
      for (const size of [1, 2, 3]) {
        for (const chunk of chunkByGraphemes(text, size)) {
          expect(lone.test(chunk)).toBe(false);
        }
      }
    }
  });

  it("keeps a ZWJ emoji sequence whole even at chunk size 1", () => {
    const family = "👩‍👩‍👧‍👦";
    expect(chunkByGraphemes(family, 1)).toEqual([family]);
  });

  it("keeps an Arabic base letter and its harakat together at chunk size 1", () => {
    const chunks = chunkByGraphemes("بِسْ", 1);
    expectByteEqual(chunks.join(""), "بِسْ");
    expect(chunks.every((c) => !/^[ً-ْ]/.test(c))).toBe(true);
  });

  it("does not normalize: NFD input stays NFD", () => {
    const nfd = "é";
    expectByteEqual(chunkByGraphemes(nfd, 1).join(""), nfd);
    expect(chunkByGraphemes(nfd, 1).join("")).not.toBe("é");
  });

  it("is deterministic across repeated calls", () => {
    const text = FIXTURE_TEXTS["multilingual:meydan-course-photosynthesis-ar"] as string;
    expect(chunkByGraphemes(text, 3)).toEqual(chunkByGraphemes(text, 3));
  });

  it("returns no chunks for empty text", () => {
    expect(chunkByGraphemes("", DEFAULT_CHUNK_SIZE)).toEqual([]);
  });

  it("rejects a non-positive chunk size rather than looping forever", () => {
    expect(() => chunkByGraphemes("abc", 0)).toThrow(RangeError);
    expect(() => chunkByGraphemes("abc", -1)).toThrow(RangeError);
  });
});

describe("P1 parity — MockChatModel.streamComplete vs complete", () => {
  it.each(Object.keys(FIXTURE_TEXTS))("concat(chunks) is byte-equal to complete() for %s", async (name) => {
    const text = FIXTURE_TEXTS[name] as string;
    const model = echoModel(text);
    const messages = messagesFor(name);

    const batch = await model.complete(messages);
    const chunks = await collect(model.streamComplete(messages));

    expectByteEqual(chunks.map((c) => c.text).join(""), batch);
  });

  it("holds at every chunk size for the Arabic fixtures", async () => {
    for (const doc of MULTILINGUAL_CORPUS) {
      for (const size of CHUNK_SIZES) {
        const model = echoModel(doc.text, size);
        const batch = await model.complete(messagesFor(doc.id));
        const chunks = await collect(model.streamComplete(messagesFor(doc.id)));
        expectByteEqual(chunks.map((c) => c.text).join(""), batch);
      }
    }
  });

  it("emits contiguous zero-based indices with no gaps or repeats", async () => {
    const model = echoModel(UNICODE_CASES.arabicDiacritics as string, 2);
    const chunks = await collect(model.streamComplete(messagesFor("q")));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("emits no chunks for an empty completion", async () => {
    const model = echoModel("");
    expect(await collect(model.streamComplete(messagesFor("q")))).toEqual([]);
  });

  it("leaves complete() behaviour untouched", async () => {
    const model = new MockChatModel();
    expect(await model.complete(messagesFor("hello"))).toBe("MOCK: hello");
    expect(model.id).toBe("mock");
  });

  it("uses no timers by default, so tests never depend on the clock", async () => {
    // With fake timers installed and never advanced, a setTimeout-based
    // implementation would hang here instead of resolving.
    vi.useFakeTimers();
    const model = echoModel("streaming without timers");
    const chunks = await collect(model.streamComplete(messagesFor("q")));
    expectByteEqual(chunks.map((c) => c.text).join(""), "streaming without timers");
  });

  it("honours an explicit inter-chunk delay for demo mode", async () => {
    const model = new MockChatModel(() => "abcdef", { chunkSize: 2, delayMs: 1 });
    const chunks = await collect(model.streamComplete(messagesFor("q")));
    expect(chunks.map((c) => c.text)).toEqual(["ab", "cd", "ef"]);
  });

  it("is recognised as a streaming model", () => {
    expect(isStreamingChatModel(new MockChatModel())).toBe(true);
  });
});

describe("streamOrFallback — graceful degradation for non-streaming providers", () => {
  const nonStreaming: ChatModel = {
    id: "non-streaming",
    complete: async (messages) => `echo:${messages.at(-1)?.content ?? ""}`,
  };

  it("does not report a plain ChatModel as streaming", () => {
    expect(isStreamingChatModel(nonStreaming)).toBe(false);
  });

  it("yields a single chunk that is byte-equal to complete()", async () => {
    const messages = messagesFor("قواعد البيانات");
    const batch = await nonStreaming.complete(messages);
    const chunks = await collect(streamOrFallback(nonStreaming, messages));

    expect(chunks).toHaveLength(1);
    expectByteEqual(chunks.map((c) => c.text).join(""), batch);
  });

  it("yields nothing when a non-streaming model returns empty text", async () => {
    const empty: ChatModel = { id: "empty", complete: async () => "" };
    expect(await collect(streamOrFallback(empty, messagesFor("q")))).toEqual([]);
  });

  it("delegates to streamComplete when the model supports it", async () => {
    const model = echoModel("delegated", 3);
    const chunks = await collect(streamOrFallback(model, messagesFor("q")));
    expect(chunks.map((c) => c.text)).toEqual(["del", "ega", "ted"]);
  });

  it("returns the full accumulated text as the generator return value", async () => {
    const it = streamOrFallback(echoModel("accumulate me", 4), messagesFor("q"));
    let next = await it.next();
    while (!next.done) next = await it.next();
    expectByteEqual(next.value, "accumulate me");
  });
});
