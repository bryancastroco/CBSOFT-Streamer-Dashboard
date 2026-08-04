import "server-only";

import { getServerEnv } from "@/config/env";
import {
  COMMENT_ANALYSIS_JSON_SCHEMA,
  COMMENT_ANALYSIS_SYSTEM_PROMPT,
  commentAnalysisSchema,
  NO_READABLE_COMMENTS,
  NO_SIGNIFICANT_FINDINGS,
  type CommentAnalysis,
} from "@/lib/ai/contract";
import type { AiAnalysisResult, AiProvider, AnalyzeCommentsInput } from "@/lib/ai/provider";
import { childLogger } from "@/lib/observability/logger";

/**
 * Google Gemini, over the REST API.
 *
 * ## Why raw `fetch` rather than an SDK
 *
 * One endpoint, one POST, one JSON body. The Google SDK would add a dependency
 * and a layer of error types to re-map, in exchange for nothing this provider
 * needs — no streaming, no tools, no files. The cost of the SDK is a
 * translation step; the cost of `fetch` is writing the request out, which is
 * eleven lines and visible.
 *
 * ## Structured output
 *
 * `responseMimeType: application/json` with a `responseSchema` constrains
 * generation, exactly as the Anthropic provider does with its JSON Schema. The
 * schema is shared from `contract.ts` so both providers are held to one
 * contract, and Zod re-validates on arrival regardless — a constrained
 * generation is not a guaranteed one.
 *
 * ## The free tier
 *
 * Gemini's free tier is the reason this exists, and it comes with a request
 * rate limit rather than a balance. A 429 is therefore normal operation rather
 * than a fault, and is mapped to `rate_limited` so the caller retries or falls
 * back instead of recording a failure.
 */

const PROVIDER = "gemini" as const;
const REQUEST_TIMEOUT_MS = 120_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
};

/** The deterministic "nothing to read" outcome, produced without a request. */
function emptyAnalysis(): CommentAnalysis {
  return {
    summary: NO_READABLE_COMMENTS,
    sentiment: "no_comments",
    positive_points: [NO_SIGNIFICANT_FINDINGS],
    concerns: [NO_SIGNIFICANT_FINDINGS],
    suggestions: [NO_SIGNIFICANT_FINDINGS],
    questions: [NO_SIGNIFICANT_FINDINGS],
    urgent_issues: [NO_SIGNIFICANT_FINDINGS],
  };
}

export class GeminiProvider implements AiProvider {
  readonly name = PROVIDER;
  readonly model: string;

  private readonly apiKey: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    const env = getServerEnv();

    this.model = options?.model ?? env.GEMINI_MODEL;

    const apiKey = options?.apiKey ?? env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "The Gemini provider was constructed without a key. " +
          "Set GEMINI_API_KEY, or leave AI_SUMMARIZATION_ENABLED=false so summarisation is skipped.",
      );
    }

    this.apiKey = apiKey;
  }

  async analyzeComments(input: AnalyzeCommentsInput): Promise<AiAnalysisResult> {
    const log = childLogger({ component: "ai.gemini", model: this.model });
    const base = { ok: false as const, provider: PROVIDER, model: this.model };

    if (input.messages.length === 0) {
      return {
        ok: true,
        analysis: emptyAnalysis(),
        model: this.model,
        provider: PROVIDER,
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: { skipped: "no_comments" },
      };
    }

    const body = {
      systemInstruction: { parts: [{ text: COMMENT_ANALYSIS_SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: input.messages.map((message, index) => `${index + 1}. ${message}`).join("\n"),
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: COMMENT_ANALYSIS_JSON_SCHEMA,
        temperature: 0.2,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    let parsed: GeminiResponse;

    try {
      response = await fetch(`${ENDPOINT}/${this.model}:generateContent`, {
        method: "POST",
        // Header rather than a query parameter: a key in a URL ends up in
        // access logs, proxy logs and error messages that quote the URL.
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      parsed = (await response.json()) as GeminiResponse;
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";

      return {
        ...base,
        category: "unavailable",
        message: aborted
          ? `Gemini did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
          : "Could not reach the Gemini API.",
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok || parsed.error) {
      const status = response.status;
      const message = parsed.error?.message ?? `HTTP ${status}`;

      if (status === 401 || status === 403) {
        log.error("ai.auth_failed", {});
        return {
          ...base,
          category: "authentication",
          message: "The Gemini API key was rejected. Check GEMINI_API_KEY.",
          retryable: false,
        };
      }

      if (status === 429) {
        /*
         * Expected on the free tier rather than exceptional. Retryable so the
         * caller falls back rather than storing a failure.
         */
        return {
          ...base,
          category: "rate_limited",
          message: "Gemini is rate limiting this application. The free tier has a request ceiling.",
          retryable: true,
        };
      }

      if (status >= 500) {
        return { ...base, category: "unavailable", message: `Gemini: ${message}`, retryable: true };
      }

      return {
        ...base,
        category: "invalid_request",
        message: `Gemini rejected the request: ${message}`,
        retryable: false,
      };
    }

    const candidate = parsed.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

    if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
      return {
        ...base,
        category: "refused",
        message: "Gemini declined to analyse this comment set.",
        retryable: false,
      };
    }

    if (text.trim().length === 0) {
      return {
        ...base,
        category: "invalid_response",
        message: "Gemini returned an empty response.",
        retryable: true,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ...base,
        category: "invalid_response",
        message: "Gemini returned text that is not valid JSON.",
        retryable: true,
        raw: text.slice(0, 500),
      };
    }

    const validated = commentAnalysisSchema.safeParse(json);

    if (!validated.success) {
      /*
       * The schema constrains a *successful* generation; it does not guarantee
       * one. A truncated response satisfies the shape and fails Zod, which is
       * precisely why both layers exist.
       */
      return {
        ...base,
        category: "invalid_response",
        message: `Gemini returned JSON that does not satisfy the contract: ${validated.error.issues[0]?.message ?? "unknown"}`,
        retryable: true,
        raw: json,
      };
    }

    return {
      ok: true,
      analysis: validated.data,
      model: this.model,
      provider: PROVIDER,
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? null,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? null,
      },
      raw: parsed,
    };
  }
}
