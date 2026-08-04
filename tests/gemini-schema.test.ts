import { describe, expect, it } from "vitest";

import { COMMENT_ANALYSIS_JSON_SCHEMA } from "@/lib/ai/contract";
import { toGeminiSchema } from "@/lib/ai/gemini";

/**
 * The shared contract schema, rewritten for Gemini.
 *
 * ## The bug this pins
 *
 * Gemini's `responseSchema` accepts a subset of OpenAPI 3.0 Schema, not JSON
 * Schema, and rejects the entire request rather than ignoring a keyword it does
 * not recognise:
 *
 *     Invalid JSON payload received. Unknown name "additionalProperties"
 *     at 'generation_config.response_schema': Cannot find field.
 *
 * `additionalProperties: false` is exactly what Anthropic's strict structured
 * output wants, so the shared schema carries it legitimately and reusing that
 * schema verbatim broke every Gemini request.
 *
 * The conversion has to keep working as the contract evolves, which is why
 * these assertions are made against the *real* schema rather than a fixture: a
 * keyword added for Anthropic's benefit should be caught here, not in
 * production.
 */

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, found);
    return found;
  }

  if (value === null || typeof value !== "object") return found;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    keysDeep(nested, found);
  }

  return found;
}

describe("converting the contract schema for Gemini", () => {
  const converted = toGeminiSchema(COMMENT_ANALYSIS_JSON_SCHEMA);

  it("removes the keyword Gemini rejected in production", () => {
    expect(keysDeep(COMMENT_ANALYSIS_JSON_SCHEMA).has("additionalProperties")).toBe(true);
    expect(keysDeep(converted).has("additionalProperties")).toBe(false);
  });

  it("keeps everything that makes the schema worth sending", () => {
    /*
     * Stripping too much would be the quieter failure: the request would
     * succeed and the model would be free to return any shape it liked, with
     * Zod rejecting it afterwards as an "invalid response".
     */
    const keys = keysDeep(converted);

    expect(keys.has("type")).toBe(true);
    expect(keys.has("properties")).toBe(true);
    expect(keys.has("required")).toBe(true);
    expect(keys.has("items")).toBe(true);
    expect(keys.has("enum")).toBe(true);
  });

  it("preserves the fields the contract requires", () => {
    const root = converted as { required?: string[]; properties?: Record<string, unknown> };

    expect(root.required).toEqual(
      expect.arrayContaining([
        "summary",
        "sentiment",
        "positive_points",
        "concerns",
        "suggestions",
        "questions",
        "urgent_issues",
      ]),
    );

    expect(Object.keys(root.properties ?? {})).toHaveLength(7);
  });

  it("does not mutate the shared schema", () => {
    /*
     * The contract module is shared with the Anthropic provider. Stripping in
     * place would quietly relax that provider's constraints too — and only on
     * deployments where a Gemini request happened to run first.
     */
    expect(keysDeep(COMMENT_ANALYSIS_JSON_SCHEMA).has("additionalProperties")).toBe(true);
  });

  it("is JSON-serialisable, since it goes out in a request body", () => {
    expect(() => JSON.stringify(converted)).not.toThrow();
  });
});

describe("the conversion itself", () => {
  it("recurses into nested objects and arrays", () => {
    const input = {
      type: "object",
      additionalProperties: false,
      properties: {
        nested: {
          type: "array",
          items: { type: "object", additionalProperties: false, properties: { a: { type: "string" } } },
        },
      },
    };

    expect(keysDeep(toGeminiSchema(input)).has("additionalProperties")).toBe(false);
    expect(keysDeep(toGeminiSchema(input)).has("properties")).toBe(true);
  });

  it("leaves primitives alone", () => {
    expect(toGeminiSchema("string")).toBe("string");
    expect(toGeminiSchema(42)).toBe(42);
    expect(toGeminiSchema(null)).toBeNull();
  });
});
