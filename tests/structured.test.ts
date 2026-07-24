import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseStructured, extractJson, StructuredOutputError } from "../src/core/structured";

const RouteSchema = z.object({
  agent: z.enum(["courses", "jobs"]),
  confidence: z.number().min(0).max(1),
});

describe("parseStructured", () => {
  it("parses and validates well-formed JSON", () => {
    const out = parseStructured(RouteSchema, '{"agent":"jobs","confidence":0.8}');
    expect(out).toEqual({ agent: "jobs", confidence: 0.8 });
  });

  it("tolerates a ```json fenced code block", () => {
    const raw = '```json\n{"agent":"courses","confidence":0.9}\n```';
    expect(parseStructured(RouteSchema, raw)).toEqual({ agent: "courses", confidence: 0.9 });
  });

  it("tolerates a bare ``` fence", () => {
    const raw = '```\n{"agent":"jobs","confidence":0.5}\n```';
    expect(parseStructured(RouteSchema, raw)).toEqual({ agent: "jobs", confidence: 0.5 });
  });

  it("tolerates leading/trailing prose around the object", () => {
    const raw = 'Sure! Here is the routing decision:\n{"agent":"courses","confidence":0.7} — hope that helps.';
    expect(parseStructured(RouteSchema, raw)).toEqual({ agent: "courses", confidence: 0.7 });
  });

  it("does not get confused by braces inside string values", () => {
    const Schema = z.object({ note: z.string() });
    const raw = 'prefix {"note":"a } brace { in a string"} suffix';
    expect(parseStructured(Schema, raw)).toEqual({ note: "a } brace { in a string" });
  });

  it("throws StructuredOutputError when no JSON is present", () => {
    expect(() => parseStructured(RouteSchema, "not json at all")).toThrow(StructuredOutputError);
  });

  it("throws StructuredOutputError on malformed JSON", () => {
    expect(() => parseStructured(RouteSchema, '{"agent":"jobs", oops}')).toThrow(
      StructuredOutputError,
    );
  });

  it("throws StructuredOutputError on schema mismatch", () => {
    // 'events' is not an allowed agent; confidence out of range
    expect(() => parseStructured(RouteSchema, '{"agent":"events","confidence":2}')).toThrow(
      StructuredOutputError,
    );
  });
});

describe("extractJson", () => {
  it("returns null when there is no JSON block", () => {
    expect(extractJson("just some words")).toBeNull();
  });

  it("extracts the first balanced array", () => {
    expect(extractJson("here: [1, 2, 3] done")).toBe("[1, 2, 3]");
  });

  it("returns null when an opened block never closes", () => {
    expect(extractJson("prefix { never closes")).toBeNull();
  });
});
