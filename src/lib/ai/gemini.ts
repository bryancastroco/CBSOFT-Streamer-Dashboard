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

/**
 * Keywords Gemini's `responseSchema` refuses.
 *
 * It accepts a subset of OpenAPI 3.0 Schema, not JSON Schema, and rejects the
 * whole request rather than ignoring a field it does not know:
 *
 *     Invalid JSON payload received. Unknown name "additionalProperties"
 *     at 'generation_config.response_schema': Cannot find field.
 *
 * `additionalProperties: false` is exactly what Anthropic's strict structured
 * output wants, so the shared schema legitimately carries it and this provider
 * has to strip it. Listed rather than allow-listed so a keyword added to the
 * contract for Anthropic's benefit keeps working here by default, and only a
 * known-rejected one is removed.
 */
const GEMINI_UNSUPPORTED_KEYWORDS = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "patternProperties",
  "default",
  "examples",
  "const",
  "oneOf",
  "allOf",
  "not",
]);

/**
 * The shared contract schema, rewritten into what Gemini will accept.
 *
 * Recursive and non-mutating: the contract module is shared with the Anthropic
 * provider, and stripping keywords in place would silently weaken that one's
 * constraints too.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  if (schema === null || typeof schema !== "object") return schema;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_KEYWORDS.has(key)) continue;
    result[key] = toGeminiSchema(value);
  }

  return result;
}

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

export type GeminiModelInfo = {
  /** Bare id, as `GEMINI_MODEL` wants it — `models/` prefix removed. */
  id: string;
  displayName: string;
  description: string;
  inputTokenLimit: number | null;
};

/**
 * Which models this key may actually use.
 *
 * Exists because guessing is not a strategy. Google retires model ids and
 * restricts others to existing users, so a name that is correct in one account
 * and month is a 400 in another:
 *
 *     This model models/gemini-2.5-flash is no longer available to new users.
 *
 * No amount of care in choosing a default survives that — but the key itself
 * knows the answer, so the product asks rather than shipping a guess that has
 * to be corrected by round trip.
 *
 * Filtered to models that support `generateContent`: an embedding model would
 * be a valid answer to "what can this key use" and a wrong one to put in
 * `GEMINI_MODEL`.
 */
export async function listGeminiModels(
  apiKey: string,
): Promise<{ ok: true; models: GeminiModelInfo[] } | { ok: false; message: string }> {
  type ListResponse = {
    models?: {
      name?: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }[];
    error?: { message?: string };
  };

  let parsed: ListResponse;

  try {
    const response = await fetch(`${ENDPOINT}?pageSize=200`, {
      headers: { "x-goog-api-key": apiKey },
    });

    parsed = (await response.json()) as ListResponse;

    if (!response.ok || parsed.error) {
      return { ok: false, message: parsed.error?.message ?? `HTTP ${response.status}` };
    }
  } catch {
    return { ok: false, message: "Could not reach the Gemini API." };
  }

  const models = (parsed.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => ({
      id: (model.name ?? "").replace(/^models\//, ""),
      displayName: model.displayName ?? model.name ?? "",
      description: model.description ?? "",
      inputTokenLimit: model.inputTokenLimit ?? null,
    }))
    .filter((model) => model.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));

  return { ok: true, models };
}

/**
 * Whether a rejection means "that model, not your request".
 *
 * Google expresses this several ways depending on why the id is unusable —
 * retired, restricted to existing accounts, or simply never valid — and all of
 * them are recoverable by choosing a different model rather than by a human
 * editing configuration.
 */
function isModelUnavailable(status: number, message: string): boolean {
  if (status === 404) return true;

  return /no longer available|not found|is not supported|does not exist|not available for/i.test(
    message,
  );
}

/**
 * Rank the models a key can use, best first for this workload.
 *
 * Comment analysis is short, high volume and needs structured JSON — a "lite"
 * flash tier is the right shape, and a pro/reasoning tier is money spent on
 * capability this task does not use. Within a tier, the higher version wins.
 *
 * Image, video, audio and embedding variants are excluded outright: they can
 * appear in the same list and none of them will return an analysis.
 */
function rankForAnalysis(models: readonly GeminiModelInfo[]): GeminiModelInfo[] {
  const usable = models.filter(
    (model) => !/image|video|tts|live|embedding|veo|imagen|aqa/i.test(model.id),
  );

  const versionOf = (id: string): number => {
    const match = id.match(/gemini-(\d+(?:\.\d+)?)/);
    return match ? Number.parseFloat(match[1]!) : 0;
  };

  return usable.sort((a, b) => {
    // A maintained alias outranks any pinned id — it cannot go stale.
    const aliasA = /latest/.test(a.id) ? 1 : 0;
    const aliasB = /latest/.test(b.id) ? 1 : 0;
    if (aliasA !== aliasB) return aliasB - aliasA;

    const liteA = /flash-lite/.test(a.id) ? 1 : 0;
    const liteB = /flash-lite/.test(b.id) ? 1 : 0;
    if (liteA !== liteB) return liteB - liteA;

    const flashA = /flash/.test(a.id) ? 1 : 0;
    const flashB = /flash/.test(b.id) ? 1 : 0;
    if (flashA !== flashB) return flashB - flashA;

    return versionOf(b.id) - versionOf(a.id);
  });
}

/**
 * A model this key can actually use, remembered for the life of the process.
 *
 * Module-level so one discovery serves every later request on a warm instance.
 * A serverless process is short-lived, so this is a cache rather than state
 * anything depends on — a cold start simply rediscovers.
 */
let resolvedModel: string | null = null;

/**
 * Whether this key's model accepts `thinkingConfig`.
 *
 * Assumed true and demoted on the first rejection, module-level for the same
 * reason as `resolvedModel`: one discovery per warm instance rather than a
 * wasted round trip on every request.
 *
 * Optimistic by default because disabling thinking is worth roughly four fifths
 * of the cost of an analysis, and the models that reject it are the exception.
 */
let thinkingSupported = true;

/**
 * Does this rejection mean the *option* was unacceptable, not the request?
 *
 * Google answers an unsupported `thinkingBudget` with a bare
 * `Request contains an invalid argument`, which says nothing about which
 * argument. Matching it is therefore broad by necessity — but it only ever
 * triggers one retry with a smaller body, so a false positive costs a request
 * and a false negative costs the feature.
 */
function isConfigRejected(result: { ok: false; category: string; message: string }): boolean {
  if (result.category !== "invalid_request") return false;

  return /invalid argument|thinking|thinking_budget|thinkingBudget|not supported/i.test(
    result.message,
  );
}

/** Exposed so a test can start from a known state. */
export function resetResolvedGeminiModelForTests(): void {
  resolvedModel = null;
  thinkingSupported = true;
}

/**
 * A result that may carry one extra category the rest of the system never sees.
 *
 * `model_unavailable` exists only between `request` and `analyzeComments`, to
 * mark the single failure another model can fix. Leaking it outward would force
 * every consumer of `AiFailureCategory` to handle a case that is already
 * handled here.
 */
type InternalResult =
  | AiAnalysisResult
  | {
      ok: false;
      category: "model_unavailable";
      message: string;
      retryable: false;
      provider: typeof PROVIDER;
      model: string;
    };

/** Convert the internal marker into a category the contract recognises. */
function stripInternalCategory(result: InternalResult): AiAnalysisResult {
  if (result.ok || result.category !== "model_unavailable") return result as AiAnalysisResult;

  return {
    ok: false,
    /*
     * Surfaced as a configuration problem, because by this point the retry has
     * already been tried and failed — a human does need to look.
     */
    category: "invalid_request",
    message: `${result.message} Open Admin → AI settings and press "List available models" to see what this key can use.`,
    retryable: false,
    provider: PROVIDER,
    model: result.model,
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

    // A model discovered earlier in this process wins: the configured one is
    // already known not to work here.
    const model = resolvedModel ?? this.model;

    let first = await this.request(input, model, log, thinkingSupported);

    /*
     * ---- The request was fine; the *option* was not ----------------------
     *
     * `thinkingConfig: { thinkingBudget: 0 }` cuts the cost of an analysis by
     * roughly four fifths, because thinking tokens bill at the output rate and
     * outnumber the answer six to one. But it is not universally accepted — a
     * model that cannot disable thinking rejects the whole request with
     * `Request contains an invalid argument`, and which model a `-latest`
     * alias resolves to is a property of the caller's key.
     *
     * I asserted this field was safely ignored by models that do not support
     * it. It is not, and swapping in a key from a different account proved it
     * within one request.
     *
     * So: retry once without it, and remember for the rest of the process.
     * Paying more is a far better outcome than a panel that cannot render.
     */
    if (!first.ok && thinkingSupported && isConfigRejected(first)) {
      log.warn("ai.gemini.thinking_unsupported", { model });
      thinkingSupported = false;
      first = await this.request(input, model, log, false);
    }

    if (first.ok || first.category !== "model_unavailable") {
      return stripInternalCategory(first);
    }

    /*
     * The configured model cannot be used by this key. Rather than surfacing a
     * failure that needs a human to edit an environment variable and redeploy,
     * ask the key what it *can* use and retry once.
     *
     * Google retires ids and restricts others to existing accounts, so this is
     * not an exotic case — it is the normal way a pinned model name ends. The
     * substitution is logged, and the result reports the model that actually
     * answered rather than the one that was asked for.
     */
    const available = await listGeminiModels(this.apiKey);

    if (!available.ok || available.models.length === 0) {
      return stripInternalCategory(first);
    }

    const candidate = rankForAnalysis(available.models)[0];

    if (!candidate || candidate.id === (resolvedModel ?? this.model)) {
      return stripInternalCategory(first);
    }

    log.warn("ai.gemini.model_substituted", { configured: this.model, using: candidate.id });

    const second = await this.request(input, candidate.id, log, thinkingSupported);

    // Only remember a model that actually worked. Caching a second failure
    // would make every later request repeat it.
    if (second.ok) resolvedModel = candidate.id;

    return stripInternalCategory(second);
  }

  /** One attempt against one model. */
  private async request(
    input: AnalyzeCommentsInput,
    model: string,
    log: ReturnType<typeof childLogger>,
    /**
     * Whether to ask for thinking to be switched off.
     *
     * Optional because not every model accepts the field. See the retry in
     * `analyzeComments`.
     */
    disableThinking = true,
  ): Promise<InternalResult> {
    const base = { ok: false as const, provider: PROVIDER, model };

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
        responseSchema: toGeminiSchema(COMMENT_ANALYSIS_JSON_SCHEMA),
        temperature: 0.2,
        /*
         * ---- Thinking off, and this is where the money was --------------
         *
         * Measured over 738 real analyses: 1,596 input tokens, 256 tokens of
         * answer — and 1,683 tokens of *thinking*, billed at the output rate.
         * Six and a half times the answer, for 87% of the output charge.
         *
         * That made each analysis cost $0.0198 rather than the $0.0055 a
         * naive read of `candidatesTokenCount` suggests, which is how an
         * estimate of $8 turned into a bill of nearly $12 — the thinking
         * tokens are reported in a separate field and are easy to miss.
         *
         * Nothing here needs reasoning. The model is reading comments and
         * filling in a fixed schema: tone, themes, questions, complaints.
         * That is extraction and synthesis, not a problem to work through,
         * and the constrained `responseSchema` already does the structural
         * work a chain of thought would otherwise be doing.
         *
         * NOT universally accepted, which I asserted and was wrong about.
         * Some models reject an unsupported `thinkingBudget` outright with
         * `Request contains an invalid argument`, and because the `-latest`
         * alias resolves differently per key, whether it works is a property
         * of the caller's account. `analyzeComments` retries without it.
         */
        ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    let parsed: GeminiResponse;

    try {
      response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
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
         * Routine rather than exceptional, on any tier. Retryable so the caller
         * falls back or comes back later rather than storing a failure.
         *
         * Google's own text is passed through instead of a fixed sentence. This
         * used to assert "the free tier has a request ceiling", which stopped
         * being true the moment billing was enabled — and it read as the
         * explanation while a paid account was hitting a per-minute limit,
         * pointing at the wrong remedy at exactly the moment one was needed.
         * The quota that was exceeded is the actionable detail and only Google
         * knows which one it was.
         */
        return {
          ...base,
          category: "rate_limited",
          message: `Gemini is rate limiting this application: ${message}`,
          retryable: true,
        };
      }

      if (status >= 500) {
        return { ...base, category: "unavailable", message: `Gemini: ${message}`, retryable: true };
      }

      if (isModelUnavailable(status, message)) {
        /*
         * Internal only, never returned to a caller. It marks the one failure
         * another model can fix, so `analyzeComments` retries rather than
         * asking a human to edit configuration and redeploy.
         */
        return {
          ...base,
          category: "model_unavailable",
          message: `Gemini cannot use the model ${model}: ${message}`,
          retryable: false,
        };
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
      model,
      provider: PROVIDER,
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? null,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? null,
      },
      raw: parsed,
    };
  }
}
