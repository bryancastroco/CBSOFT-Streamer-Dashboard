import { NO_SIGNIFICANT_FINDINGS, type CommentSentiment } from "@/lib/ai/contract";

/**
 * Presentation of a stored analysis — a PURE module, safe on the client.
 *
 * Extracted so the post detail card, the videos table, the comment-analysis list
 * and the CSV export all label a sentiment the same way. Three screens each
 * mapping `mixed` to their own wording is how a report and a dashboard end up
 * appearing to disagree about the same row.
 */

export const SENTIMENT_LABELS: Record<string, string> = {
  positive: "Positive",
  mixed: "Mixed",
  negative: "Negative",
  neutral: "Neutral",
  no_comments: "No comments",
};

export const SUMMARY_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Analysing…",
  completed: "Completed",
  no_comments: "No comments",
  failed: "Failed",
};

/** Shown where a summary has never been generated at all. */
export const NOT_ANALYSED = "Not analysed";

export type BadgeTone = "default" | "secondary" | "destructive" | "outline";

export function sentimentLabel(sentiment: string | null | undefined): string {
  if (!sentiment) return NOT_ANALYSED;
  return SENTIMENT_LABELS[sentiment] ?? sentiment;
}

export function sentimentTone(sentiment: string | null | undefined): BadgeTone {
  switch (sentiment as CommentSentiment | null | undefined) {
    case "positive":
      return "default";
    case "negative":
      return "destructive";
    case "mixed":
      return "outline";
    default:
      return "secondary";
  }
}

export function summaryStatusLabel(status: string | null | undefined): string {
  if (!status) return NOT_ANALYSED;
  return SUMMARY_STATUS_LABELS[status] ?? status;
}

export function summaryStatusTone(status: string | null | undefined): BadgeTone {
  if (status === "failed") return "destructive";
  if (status === "completed") return "secondary";
  return "outline";
}

/**
 * Coerce a stored JSONB column into a string list, tolerating anything else.
 *
 * The column is `jsonb` and therefore capable of holding any shape. A row
 * written by an older version — or by a hand-run SQL fix — must render as an
 * empty list rather than crash the page.
 */
export function toFindingList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Are there real findings here?
 *
 * The model writes `No significant findings` into an otherwise empty list, so a
 * non-empty array is not the same as having something to report. Treating length
 * as the signal would mark every analysed item as having concerns.
 */
export function hasRealFindings(value: unknown): boolean {
  const items = toFindingList(value);
  if (items.length === 0) return false;
  return items.some((item) => item.trim() !== "" && item.trim() !== NO_SIGNIFICANT_FINDINGS);
}

/** Real findings only, with the placeholder removed. */
export function realFindings(value: unknown): string[] {
  return toFindingList(value).filter(
    (item) => item.trim() !== "" && item.trim() !== NO_SIGNIFICANT_FINDINGS,
  );
}

/** A one-line rendering of a finding list for a table cell or a CSV field. */
export function summariseFindings(value: unknown, limit = 2): string {
  const items = realFindings(value);
  if (items.length === 0) return NO_SIGNIFICANT_FINDINGS;
  if (items.length <= limit) return items.join(" · ");
  return `${items.slice(0, limit).join(" · ")} (+${items.length - limit} more)`;
}
