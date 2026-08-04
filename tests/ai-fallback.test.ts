import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which provider failures fall back locally, and which must stay loud.
 *
 * The distinction is the whole design. A rate limit or an empty balance says
 * nothing about the comments, so producing a local analysis is strictly better
 * than storing a failure. A rejected key or a malformed request is a problem
 * somebody has to fix, and quietly succeeding offline would hide it — which is
 * exactly how a switched-off summariser went unnoticed for five days while a
 * key took the blame.
 */

const mocks = vi.hoisted(() => ({ analyzeComments: vi.fn() }));

vi.mock("@/lib/ai/anthropic", () => ({
  AnthropicProvider: class {
    readonly name = "anthropic";
    readonly model = "test-model";
    analyzeComments = mocks.analyzeComments;
  },
}));

vi.mock("@/lib/ai/gemini", () => ({
  GeminiProvider: class {
    readonly name = "gemini";
    readonly model = "test-model";
    analyzeComments = mocks.analyzeComments;
  },
}));

const { analyzeWithFallback } = await import("@/lib/ai/resolve");

const MESSAGES = ["this was great, thanks!", "the stream was laggy"];

function failure(category: string, retryable: boolean) {
  return {
    ok: false as const,
    category,
    message: `simulated ${category}`,
    retryable,
    provider: "anthropic" as const,
    model: "test-model",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("failures that fall back", () => {
  it.each([
    ["rate_limited", "a free-tier ceiling"],
    ["unavailable", "a provider outage"],
    ["invalid_response", "a truncated generation"],
  ])("%s — %s", async (category) => {
    mocks.analyzeComments.mockResolvedValue(failure(category, true));

    const result = await analyzeWithFallback({ messages: MESSAGES });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.provider).toBe("offline");
    // Marked, so the caller and the reader both know what produced this.
    expect(result.analysis.summary).toContain("without a language model");
  });

  it("still analyses when the provider cannot even be constructed", async () => {
    /*
     * A missing key throws in the constructor. The operator sees that on the
     * AI settings screen; the reader should not be left with nothing meanwhile.
     */
    mocks.analyzeComments.mockImplementation(() => {
      throw new Error("constructed without a key");
    });

    const result = await analyzeWithFallback({ messages: MESSAGES });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("offline");
  });
});

describe("failures that must stay loud", () => {
  it.each([
    ["authentication", "a rejected key"],
    ["invalid_request", "a malformed request"],
    ["refused", "the model declining"],
  ])("%s — %s", async (category) => {
    mocks.analyzeComments.mockResolvedValue(failure(category, false));

    const result = await analyzeWithFallback({ messages: MESSAGES });

    /*
     * `retryable: false` means a human has to act. Substituting a local
     * analysis would make the problem invisible while looking like success.
     */
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.category).toBe(category);
  });
});

describe("when the provider works", () => {
  it("passes the real analysis straight through", async () => {
    mocks.analyzeComments.mockResolvedValue({
      ok: true,
      analysis: {
        summary: "Written by a model.",
        sentiment: "positive",
        positive_points: ["good"],
        concerns: [],
        suggestions: [],
        questions: [],
        urgent_issues: [],
      },
      model: "test-model",
      provider: "anthropic",
      usage: { inputTokens: 10, outputTokens: 20 },
      raw: {},
    });

    const result = await analyzeWithFallback({ messages: MESSAGES });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.provider).toBe("anthropic");
    expect(result.analysis.summary).toBe("Written by a model.");
  });
});
