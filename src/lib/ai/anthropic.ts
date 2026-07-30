import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { getServerEnv } from "@/config/env";
import {
  COMMENT_ANALYSIS_JSON_SCHEMA,
  COMMENT_ANALYSIS_SYSTEM_PROMPT,
  applyPlaceholders,
  buildCommentAnalysisPrompt,
  commentAnalysisSchema,
  emptyAnalysis,
} from "@/lib/ai/contract";
import type {
  AiAnalysisResult,
  AiProvider,
  AiProviderName,
  AnalyzeCommentsInput,
} from "@/lib/ai/provider";
import { childLogger } from "@/lib/observability/logger";

/**
 * Anthropic implementation of `AiProvider`.
 *
 * The only file in the codebase that imports the Anthropic SDK. Everything
 * upstream depends on the `AiProvider` interface, so a second provider is a new
 * file rather than a refactor.
 *
 * ## Why the request looks the way it does
 *
 * - **Structured outputs** (`output_config.format`) constrain generation to the
 *   analysis schema, so a well-formed response is the normal case rather than
 *   something to parse defensively. The result is still validated with Zod —
 *   the schema constrains a *successful* generation and says nothing about a
 *   refusal or a truncation.
 * - **`stop_reason === "refusal"` is checked before `content` is read.** Comment
 *   text is arbitrary user content and can trip a safety classifier; indexing
 *   `content[0]` unconditionally would throw on exactly the inputs most worth
 *   handling gracefully.
 * - **Server-side fallbacks** re-run a declined request on Anthropic's
 *   recommended substitute model rather than surfacing the refusal, which keeps
 *   one hostile comment thread from blocking a whole report.
 */

const PROVIDER: AiProviderName = "anthropic";

/** Beta flag gating the `fallbacks: "default"` form. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Bounded: the analysis is a small fixed-shape object. `max_tokens` caps
 * thinking plus output together, so this leaves room for both.
 */
const MAX_TOKENS = 8_000;

/**
 * Comment analysis is judgement work, but over a bounded input with a fixed
 * output shape — `medium` is the balance point. Raise it if summaries read as
 * shallow; lower it if cost matters more than nuance.
 */
const EFFORT = "medium";

const REQUEST_TIMEOUT_MS = 120_000;

type AnthropicTextBlock = { type: string; text?: string };

/**
 * The subset of the response this provider reads.
 *
 * `beta.messages.create` is typed as a union of "message" and "stream" because
 * the same method serves both; we never stream, so the result is narrowed to
 * the message shape rather than carrying a stream branch that cannot occur.
 */
type AnthropicMessageResponse = {
  stop_reason?: string | null;
  content?: AnthropicTextBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
};

export class AnthropicProvider implements AiProvider {
  readonly name = PROVIDER;
  readonly model: string;

  private readonly client: Anthropic;

  constructor(options?: { apiKey?: string; model?: string }) {
    const env = getServerEnv();

    this.model = options?.model ?? env.ANTHROPIC_MODEL;

    const apiKey = options?.apiKey ?? env.ANTHROPIC_API_KEY;

    /*
     * `ANTHROPIC_API_KEY` is only required when `AI_SUMMARIZATION_ENABLED` is
     * true, so it can legitimately be absent — but then nothing should be
     * constructing this provider. Failing here with a sentence an operator can
     * act on beats letting the SDK throw about a missing key three frames deep,
     * or worse, sending an unauthenticated request.
     */
    if (!apiKey) {
      throw new Error(
        "The Anthropic provider was constructed without a key. " +
          "Set ANTHROPIC_API_KEY, or leave AI_SUMMARIZATION_ENABLED=false so summarisation is skipped.",
      );
    }

    this.client = new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
    });
  }

  async analyzeComments(input: AnalyzeCommentsInput): Promise<AiAnalysisResult> {
    const log = childLogger({ component: "ai.anthropic", model: this.model });

    // Nothing to analyse costs nothing to analyse. The specification's
    // "No readable comments found" outcome is deterministic, so it is produced
    // locally rather than billed to the model.
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

    /*
     * Assembled as a plain object and cast at the call site. `fallbacks` and
     * `output_config` move faster than the SDK's published types; building the
     * body this way keeps the request correct without pinning the build to a
     * particular typings release.
     */
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: COMMENT_ANALYSIS_JSON_SCHEMA },
      },
      system: COMMENT_ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildCommentAnalysisPrompt(input.messages) }],
    };

    let response: AnthropicMessageResponse;

    try {
      response = (await this.client.beta.messages.create(
        body as unknown as Parameters<typeof this.client.beta.messages.create>[0],
      )) as AnthropicMessageResponse;
    } catch (cause) {
      return this.mapError(cause, log);
    }

    // --- Refusal, checked before any content access -----------------------
    if (response.stop_reason === "refusal") {
      log.warn("ai.refused", { commentCount: input.messages.length });

      return {
        ok: false,
        category: "refused",
        message:
          "The model declined to analyse these comments. This can happen when a thread contains abusive or unsafe content.",
        retryable: false,
        provider: PROVIDER,
        model: this.model,
      };
    }

    if (response.stop_reason === "max_tokens") {
      return {
        ok: false,
        category: "invalid_response",
        message: "The analysis was cut short by the token limit. Try again with fewer comments.",
        retryable: true,
        provider: PROVIDER,
        model: this.model,
      };
    }

    // --- Extract and validate --------------------------------------------
    const blocks = (response.content ?? []) as AnthropicTextBlock[];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    if (text.length === 0) {
      return {
        ok: false,
        category: "invalid_response",
        message: "The model returned no analysis text.",
        retryable: true,
        provider: PROVIDER,
        model: this.model,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        category: "invalid_response",
        message: "The model's response was not valid JSON.",
        retryable: true,
        provider: PROVIDER,
        model: this.model,
      };
    }

    // Zod is the final authority — structured outputs shape a successful
    // generation, but only this confirms what actually arrived.
    const validated = commentAnalysisSchema.safeParse(parsed);

    if (!validated.success) {
      const issue = validated.error.issues[0];
      log.warn("ai.invalid_response", {
        path: issue?.path.join("."),
        message: issue?.message,
      });

      return {
        ok: false,
        category: "invalid_response",
        message: `The model's response did not match the expected shape: ${issue?.path.join(".") || "root"} — ${issue?.message ?? "unknown issue"}.`,
        retryable: true,
        provider: PROVIDER,
        model: this.model,
      };
    }

    const usage = (response.usage ?? {}) as { input_tokens?: number; output_tokens?: number };

    log.info("ai.analysis.completed", {
      commentCount: input.messages.length,
      sentiment: validated.data.sentiment,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
    });

    return {
      ok: true,
      analysis: applyPlaceholders(validated.data),
      // The response reports which model actually served it, which differs from
      // the requested one when a fallback ran.
      model: response.model ?? this.model,
      provider: PROVIDER,
      usage: {
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
      },
      raw: parsed,
    };
  }

  /** Map SDK exceptions onto the provider-neutral failure categories. */
  private mapError(cause: unknown, log: ReturnType<typeof childLogger>): AiAnalysisResult {
    const base = { ok: false as const, provider: PROVIDER, model: this.model };

    if (cause instanceof Anthropic.AuthenticationError) {
      log.error("ai.auth_failed", {});
      return {
        ...base,
        category: "authentication",
        message: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.",
        retryable: false,
      };
    }

    if (cause instanceof Anthropic.RateLimitError) {
      return {
        ...base,
        category: "rate_limited",
        message: "Anthropic is rate limiting this application. Try again shortly.",
        retryable: true,
      };
    }

    if (cause instanceof Anthropic.BadRequestError) {
      // Usually a schema or parameter problem — our bug, not a transient one.
      return {
        ...base,
        category: "invalid_request",
        message: `Anthropic rejected the request: ${cause.message}`,
        retryable: false,
      };
    }

    if (cause instanceof Anthropic.APIConnectionError) {
      return {
        ...base,
        category: "unavailable",
        message: "Could not reach Anthropic.",
        retryable: true,
      };
    }

    if (cause instanceof Anthropic.APIError) {
      const status = cause.status ?? 0;
      return {
        ...base,
        category: status >= 500 ? "unavailable" : "unknown",
        message: `Anthropic returned an error (HTTP ${status}): ${cause.message}`,
        retryable: status >= 500,
      };
    }

    log.error("ai.unexpected_error", {
      error: cause instanceof Error ? cause.message : "unknown",
    });

    return {
      ...base,
      category: "unknown",
      message:
        cause instanceof Error ? `Unexpected failure: ${cause.message}` : "Unexpected failure.",
      retryable: false,
    };
  }
}

/**
 * Resolve the configured provider.
 *
 * `AI_PROVIDER` is an enum of one today. The switch exists so adding a provider
 * is an added case rather than a rewrite of every call site.
 */
export function getAiProvider(): AiProvider {
  const { AI_PROVIDER } = getServerEnv();

  switch (AI_PROVIDER) {
    case "anthropic":
      return new AnthropicProvider();
  }
}
