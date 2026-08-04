import type { CommentAnalysis } from "@/lib/ai/contract";

/**
 * The AI provider abstraction — a PURE module (types and result shapes only).
 *
 * The application depends on this interface, never on an SDK. Swapping or
 * adding a provider means adding a file that satisfies `AiProvider`; nothing in
 * the service layer changes.
 *
 * Failures are returned, not thrown: a summarisation failure is an outcome to
 * record on the row (`status = failed`, `error_message`), not an exception that
 * aborts a sync run.
 */

export type AiProviderName = "anthropic" | "gemini" | "offline";

export type AiFailureCategory =
  /** Provider rejected the request as malformed or unsupported. */
  | "invalid_request"
  /** Credentials missing, wrong, or lacking access. */
  | "authentication"
  /** Throttled. Retryable. */
  | "rate_limited"
  /** Provider outage or transport failure. Retryable. */
  | "unavailable"
  /** The model declined to answer. */
  | "refused"
  /** A response arrived but did not satisfy the contract. */
  | "invalid_response"
  /** Anything else. */
  | "unknown";

export type AiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type AiAnalysisSuccess = {
  ok: true;
  analysis: CommentAnalysis;
  model: string;
  provider: AiProviderName;
  usage: AiUsage;
  /** The unmodified provider response, stored for debugging a bad summary. */
  raw: unknown;
};

export type AiAnalysisFailure = {
  ok: false;
  category: AiFailureCategory;
  /** Operator-readable. Never contains credentials. */
  message: string;
  retryable: boolean;
  provider: AiProviderName;
  model: string;
  raw?: unknown;
};

export type AiAnalysisResult = AiAnalysisSuccess | AiAnalysisFailure;

export type AnalyzeCommentsInput = {
  /** Comment text only. Callers must not pass identities — none are stored. */
  messages: readonly string[];
};

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  analyzeComments(input: AnalyzeCommentsInput): Promise<AiAnalysisResult>;
}

export const AI_FAILURE_LABELS: Record<AiFailureCategory, string> = {
  invalid_request: "Invalid request",
  authentication: "Authentication failed",
  rate_limited: "Rate limited",
  unavailable: "Provider unavailable",
  refused: "Model declined",
  invalid_response: "Invalid response",
  unknown: "Unknown error",
};
