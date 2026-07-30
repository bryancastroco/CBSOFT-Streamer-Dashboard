import "server-only";

/**
 * Anthropic-backed comment summarisation — PLACEHOLDER (Phase 7).
 *
 * Planned shape:
 *   - Comments are fetched server-side via the Graph API and stored in
 *     Postgres, redacted of author PII beyond what is needed.
 *   - A batched job asks Claude for a sentiment + themes summary per stream.
 *   - Summaries are cached in `comment_summaries` and keyed by content hash so
 *     the same comment set is never billed twice.
 *
 * Nothing calls the Anthropic API in Phase 1. `ANTHROPIC_API_KEY` is validated
 * at startup so a misconfiguration surfaces before Phase 7, not during it.
 */

export const AI_INTEGRATION_STATUS = {
  phase: 7,
  provider: "anthropic",
  implemented: false,
  note: "No Anthropic calls are made in Phase 1.",
} as const;
