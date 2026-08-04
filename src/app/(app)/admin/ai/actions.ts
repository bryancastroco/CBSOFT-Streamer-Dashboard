"use server";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { AI_FAILURE_LABELS } from "@/lib/ai/provider";
import { getAiProvider } from "@/lib/ai/anthropic";
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
    provider = getAiProvider();
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
