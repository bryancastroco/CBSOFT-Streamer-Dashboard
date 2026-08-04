"use server";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { AI_FAILURE_LABELS } from "@/lib/ai/provider";
import { getConfiguredProvider } from "@/lib/ai/resolve";
import { listGeminiModels } from "@/lib/ai/gemini";
import { getServerEnvSafe } from "@/config/env";
import { childLogger } from "@/lib/observability/logger";

/**
 * Ask the provider whether the stored credential actually works.
 *
 * ## Why this exists
 *
 * "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY." is accurate
 * and unactionable. Before this, confirming a fix meant setting the key,
 * redeploying, finding a post with comments, pressing Regenerate summary, and
 * reading the result — a five-minute loop for a yes/no question, made worse by
 * the hash gate, which declines to re-run an analysis whose comments have not
 * changed.
 *
 * So this sends the smallest real request the provider accepts and reports
 * exactly what came back. It distinguishes the cases that look identical from
 * the outside: a rejected key, a rate limit, an unreachable API, and a model
 * name the account cannot use.
 *
 * ## What it does not do
 *
 * It never returns, logs or otherwise reveals the key. The provider's own
 * failure messages are already written to be operator-readable and free of
 * credential material — see `mapError` in `anthropic.ts` — and the success path
 * reports only the model name and token usage.
 */

export type GeminiModelsState = {
  status: "idle" | "success" | "error";
  message: string | null;
  models: { id: string; displayName: string; description: string; inputTokenLimit: number | null }[];
  /** What `GEMINI_MODEL` is set to now, so the list can mark it. */
  configured: string | null;
};

/**
 * Ask the key which models it may use.
 *
 * A model id that is valid in one Google account and month is a 400 in
 * another — Google retires ids and restricts others to existing users. No
 * default survives that, so rather than shipping a guess and correcting it by
 * round trip, this reads the answer from the key itself.
 *
 * The key is used and never returned: only model names and descriptions leave
 * this function.
 */
export async function listGeminiModelsAction(): Promise<GeminiModelsState> {
  try {
    await assertAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message, models: [], configured: null };
    }
    throw error;
  }

  const env = getServerEnvSafe();

  if (!env.ok) {
    return {
      status: "error",
      message: "Configuration is incomplete, so the key could not be read.",
      models: [],
      configured: null,
    };
  }

  const apiKey = env.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      status: "error",
      message: "No GEMINI_API_KEY is configured. Add one in Vercel and redeploy.",
      models: [],
      configured: env.env.GEMINI_MODEL,
    };
  }

  const outcome = await listGeminiModels(apiKey);

  if (!outcome.ok) {
    return { status: "error", message: outcome.message, models: [], configured: env.env.GEMINI_MODEL };
  }

  return {
    status: "success",
    message: `${outcome.models.length} model${outcome.models.length === 1 ? "" : "s"} available to this key.`,
    models: outcome.models,
    configured: env.env.GEMINI_MODEL,
  };
}

export type AiTestState = {
  status: "idle" | "success" | "error";
  message: string | null;
  /** The provider's own category, so the UI can distinguish a 401 from a 429. */
  category?: string;
};

export async function testAiConnectionAction(): Promise<AiTestState> {
  try {
    await assertAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }

  const log = childLogger({ component: "admin.ai_test" });

  let provider;
  try {
    // The configured provider, deliberately not the fallback wrapper: a test
    // that quietly succeeds offline tests nothing.
    provider = getConfiguredProvider();
  } catch (cause) {
    /*
     * Construction fails when the key is absent entirely — a different problem
     * from one that is present and refused, and worth saying so.
     */
    return {
      status: "error",
      category: "authentication",
      message:
        cause instanceof Error && /ANTHROPIC_API_KEY/i.test(cause.message)
          ? "No API key is configured. Set ANTHROPIC_API_KEY in Vercel and redeploy."
          : "The AI provider could not be initialised.",
    };
  }

  /*
   * One short comment. A real analysis request rather than a synthetic ping,
   * because the thing worth testing is the path production actually uses —
   * including the model name, which a bare credential check would not exercise.
   */
  const result = await provider.analyzeComments({ messages: ["This is a connection test."] });

  if (result.ok) {
    log.info("ai.test.succeeded", { model: result.model });

    return {
      status: "success",
      message: `Connected. ${result.model} answered${
        result.usage.inputTokens !== null
          ? ` (${result.usage.inputTokens} in, ${result.usage.outputTokens ?? 0} out)`
          : ""
      }.`,
    };
  }

  log.warn("ai.test.failed", { category: result.category });

  return {
    status: "error",
    category: result.category,
    message: `${AI_FAILURE_LABELS[result.category]}: ${result.message}`,
  };
}
