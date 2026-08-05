import "server-only";

import { getServerEnv } from "@/config/env";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { GeminiProvider } from "@/lib/ai/gemini";
import { analyseOffline } from "@/lib/ai/offline";
import type { AiAnalysisResult, AiProvider, AnalyzeCommentsInput } from "@/lib/ai/provider";
import { childLogger } from "@/lib/observability/logger";

/**
 * Which provider runs, and what happens when it cannot.
 *
 * ## The fallback, and why it is not a silent substitution
 *
 * A hosted provider says no for reasons that have nothing to do with the
 * comments: an empty balance, a free-tier ceiling, a regional outage. Recording
 * `failed` in those moments throws away an analysis that could have been
 * produced locally — the comments were collected successfully, and tone, themes
 * and questions are all countable without a model.
 *
 * So a *retryable* failure falls through to `analyseOffline`. The result is
 * marked `provider: "offline"` and its summary says outright that it was
 * counted rather than written, so nobody mistakes a tally for an interpretation.
 *
 * ## What does not fall back
 *
 * A rejected key, a malformed request, a refusal. Those are configuration or
 * content problems that a local analysis would paper over — the operator needs
 * to see them, and `retryable: false` is exactly that signal. Falling back on
 * everything would make a broken key invisible, which is the failure mode this
 * whole area has already suffered once.
 */

export function getConfiguredProvider(): AiProvider {
  const { AI_PROVIDER } = getServerEnv();

  switch (AI_PROVIDER) {
    case "anthropic":
      return new AnthropicProvider();
    case "gemini":
      return new GeminiProvider();
    case "offline":
      return new OfflineProvider();
  }
}

/** The deterministic analyser, wearing the provider interface. */
export class OfflineProvider implements AiProvider {
  readonly name = "offline" as const;
  readonly model = "lexicon";

  async analyzeComments(input: AnalyzeCommentsInput): Promise<AiAnalysisResult> {
    return {
      ok: true,
      analysis: analyseOffline(input.messages),
      model: this.model,
      provider: "offline",
      usage: { inputTokens: null, outputTokens: null },
      raw: { method: "offline_lexicon", comments: input.messages.length },
    };
  }
}

/**
 * Analyse with the configured provider, falling back locally when allowed.
 *
 * The single entry point the summarisation service should use. Callers that
 * genuinely want the raw provider — the connection test, for one — construct it
 * directly, because a test that silently succeeds offline tests nothing.
 */
export async function analyzeWithFallback(
  input: AnalyzeCommentsInput,
  options: {
    /**
     * Whether this caller accepts a local tally in place of a model answer.
     *
     * True for anything a person is waiting on. False for unattended work: the
     * fallback result is stored against the current comment hash, which closes
     * the gate that would otherwise bring the real model back to that item. A
     * spell of rate limiting would then leave a permanent tally behind on
     * everything it touched, and nothing in the data would say so.
     */
    allowOffline?: boolean;
  } = {},
): Promise<AiAnalysisResult & { fellBack?: boolean }> {
  const env = getServerEnv();
  const log = childLogger({ component: "ai.resolve" });

  let primary: AiAnalysisResult;

  try {
    primary = await getConfiguredProvider().analyzeComments(input);
  } catch (cause) {
    /*
     * Construction threw — a missing key, most likely. Treated as retryable so
     * the fallback applies: the operator still sees the misconfiguration on the
     * AI settings screen, and readers still get an analysis in the meantime.
     */
    primary = {
      ok: false,
      category: "authentication",
      message: cause instanceof Error ? cause.message : "The AI provider could not be constructed.",
      retryable: true,
      provider: env.AI_PROVIDER,
      model: "unknown",
    };
  }

  if (primary.ok) return primary;

  const offlineAllowed = options.allowOffline ?? true;

  if (!offlineAllowed || !env.AI_OFFLINE_FALLBACK || !primary.retryable) return primary;

  log.warn("ai.fell_back_offline", { category: primary.category, provider: primary.provider });

  const offline = await new OfflineProvider().analyzeComments(input);

  return offline.ok ? { ...offline, fellBack: true } : primary;
}
