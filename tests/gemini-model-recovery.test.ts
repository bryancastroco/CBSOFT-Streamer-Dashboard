import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiProvider, resetResolvedGeminiModelForTests } from "@/lib/ai/gemini";

/**
 * Recovering from a model id that this key cannot use.
 *
 * ## Why this exists
 *
 * A pinned Gemini model name is a default with an expiry date. Google retires
 * ids and restricts others to existing accounts, so the same string is valid
 * for one key and a 400 for another:
 *
 *     This model models/gemini-2.5-flash is no longer available to new users.
 *
 * That cost three deploy cycles of guessing. The provider now asks the key what
 * it can use and retries, so the failure resolves itself instead of becoming a
 * support round trip.
 */

const ANALYSIS = {
  summary: "Commenters were positive about the stream.",
  sentiment: "positive",
  positive_points: ["Good quality"],
  concerns: [],
  suggestions: [],
  questions: [],
  urgent_issues: [],
};

function generateOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(ANALYSIS) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
}

function modelRetired(model: string) {
  return {
    ok: false,
    status: 400,
    json: async () => ({
      error: {
        code: 400,
        message: `This model models/${model} is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.`,
      },
    }),
  };
}

function modelList(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      models: ids.map((id) => ({
        name: `models/${id}`,
        displayName: id,
        description: "",
        inputTokenLimit: 1_000_000,
        supportedGenerationMethods: ["generateContent"],
      })),
    }),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetResolvedGeminiModelForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider() {
  return new GeminiProvider({ apiKey: "test-key", model: "gemini-2.5-flash" });
}

describe("a retired model id", () => {
  it("is replaced by one the key can actually use", async () => {
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList(["gemini-3.5-flash-lite", "gemini-3.5-pro"]))
      .mockResolvedValueOnce(generateOk());

    const result = await provider().analyzeComments({ messages: ["great stream"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The result reports the model that answered, not the one that was asked for.
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(result.analysis.summary).toContain("positive");
  });

  it("prefers a maintained alias over any pinned id", async () => {
    /*
     * An alias cannot go stale, which is the whole problem being solved. If one
     * is on offer it should win regardless of version numbers.
     */
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList(["gemini-3.6-flash", "gemini-flash-latest"]))
      .mockResolvedValueOnce(generateOk());

    const result = await provider().analyzeComments({ messages: ["nice"] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe("gemini-flash-latest");
  });

  it("never picks a model that cannot return an analysis", async () => {
    /*
     * Image, video, speech and embedding models appear in the same list and
     * would each fail differently and confusingly.
     */
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(
        modelList([
          "gemini-3.1-flash-image",
          "veo-3.1-generate-preview",
          "gemini-3.1-flash-tts-preview",
          "gemini-3.5-flash-lite",
        ]),
      )
      .mockResolvedValueOnce(generateOk());

    const result = await provider().analyzeComments({ messages: ["hello"] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe("gemini-3.5-flash-lite");
  });

  it("remembers the working model, so the next call skips discovery", async () => {
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList(["gemini-3.5-flash-lite"]))
      .mockResolvedValueOnce(generateOk())
      .mockResolvedValueOnce(generateOk());

    await provider().analyzeComments({ messages: ["one"] });
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await provider().analyzeComments({ messages: ["two"] });

    // One request, not three: no retirement error and no model listing.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.model).toBe("gemini-3.5-flash-lite");
  });
});

describe("when recovery is not possible", () => {
  it("reports the problem and points at the model list", async () => {
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList([]));

    const result = await provider().analyzeComments({ messages: ["hello"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Never leaks the internal marker category outward.
    expect(result.category).toBe("invalid_request");
    expect(result.message).toContain("List available models");
  });

  it("does not cache a model that failed on the retry", async () => {
    fetchMock
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList(["gemini-3.5-flash-lite"]))
      .mockResolvedValueOnce(modelRetired("gemini-3.5-flash-lite"))
      // A second call must start over rather than reuse the broken choice.
      .mockResolvedValueOnce(modelRetired("gemini-2.5-flash"))
      .mockResolvedValueOnce(modelList(["gemini-3.6-flash"]))
      .mockResolvedValueOnce(generateOk());

    const first = await provider().analyzeComments({ messages: ["a"] });
    expect(first.ok).toBe(false);

    const second = await provider().analyzeComments({ messages: ["b"] });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.model).toBe("gemini-3.6-flash");
  });
});

describe("failures that are not about the model", () => {
  it("does not go hunting for a different model on a rate limit", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 429, message: "Quota exceeded" } }),
    });

    const result = await provider().analyzeComments({ messages: ["hello"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.category).toBe("rate_limited");
    // One request. Listing models would waste a call against the same ceiling.
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("does not retry a rejected key", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 403, message: "API key not valid" } }),
    });

    const result = await provider().analyzeComments({ messages: ["hello"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.category).toBe("authentication");
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});

describe("a model that will not switch thinking off", () => {
  /** Gemini's answer when `thinkingBudget` is not supported. */
  function invalidArgument() {
    return {
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 400, message: "Request contains an invalid argument." },
      }),
    };
  }

  it("retries without the option instead of failing", async () => {
    /*
     * `thinkingBudget: 0` is worth roughly four fifths of the cost of an
     * analysis — thinking tokens bill at the output rate and outnumber the
     * answer six to one. But it is not universally accepted, and which model a
     * `-latest` alias resolves to is a property of the caller's key.
     *
     * Asserting it was "safely ignored" was wrong, and swapping in a key from
     * another account proved it within one request. Paying more beats a panel
     * that cannot render.
     */
    fetchMock.mockResolvedValueOnce(invalidArgument()).mockResolvedValueOnce(generateOk());

    const result = await provider().analyzeComments({ messages: ["ano po?"] });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(2);

    const sent = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      generationConfig: Record<string, unknown>;
    };
    expect(sent.generationConfig["thinkingConfig"]).toBeUndefined();
  });

  it("asks for it on the first attempt, because it is the cheaper path", async () => {
    fetchMock.mockResolvedValueOnce(generateOk());

    await provider().analyzeComments({ messages: ["ano po?"] });

    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      generationConfig: { thinkingConfig?: { thinkingBudget?: number } };
    };
    expect(sent.generationConfig.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it("remembers the refusal, so the next call does not waste a request", async () => {
    fetchMock
      .mockResolvedValueOnce(invalidArgument())
      .mockResolvedValueOnce(generateOk())
      .mockResolvedValueOnce(generateOk());

    await provider().analyzeComments({ messages: ["one"] });
    const after = fetchMock.mock.calls.length;

    await provider().analyzeComments({ messages: ["two"] });

    // One request, not two: the option is already known to be unusable here.
    expect(fetchMock.mock.calls.length).toBe(after + 1);
  });

  it("does not strip the option for an unrelated bad request", async () => {
    // A malformed schema is a real fault and must stay loud rather than being
    // retried into a differently-shaped failure.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 400, message: 'Unknown name "additionalProperties" at schema.' },
      }),
    });

    const result = await provider().analyzeComments({ messages: ["hello"] });

    expect(result.ok).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});
