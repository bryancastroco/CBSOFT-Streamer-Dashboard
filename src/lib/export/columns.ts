import { realFindings, sentimentLabel, summaryStatusLabel } from "@/lib/ai/presentation";
import type { CsvColumn } from "@/lib/export/csv";
import { formatDuration } from "@/lib/meta/videos";
import type { AnalysisListItem } from "@/lib/repositories/analysis";
import type { PostTableItem } from "@/lib/repositories/posts";
import type { VideoTableItem } from "@/lib/repositories/videos";

/**
 * CSV column definitions — a PURE module.
 *
 * ## Why the columns are declared here and nowhere else
 *
 * Every export route reads its columns from this file, and every column names
 * exactly one field. There is no spread, no `Object.keys(row)`, no "everything
 * except" — which means a new column on `posts` or `streamers` cannot appear in
 * a download by being added to a table. Adding an exported field is a deliberate
 * edit to this file.
 *
 * That matters most for `streamers`: the row types below carry a streamer's code
 * and name, and nothing else about them. No column here reads the stored token
 * ciphertext, its four-character suffix, the masked form or the health status —
 * and none can, because the repository shapes these are built from do not carry
 * those fields at all. A CSV is the easiest artefact in the system to forward to
 * someone outside it, so it gets the narrowest column set.
 *
 * `TOKEN_FORBIDDEN_HEADERS` in `tests/csv-export.test.ts` asserts this from the
 * outside, so the rule survives someone adding a column in a hurry.
 */

/** A dash in the UI is an empty cell here — never a zero. */
function countOrBlank(value: number | null | undefined): number | null {
  return value ?? null;
}

export const POST_EXPORT_COLUMNS: readonly CsvColumn<PostTableItem>[] = [
  { header: "Streamer code", value: (row) => row.streamerCode },
  { header: "Streamer name", value: (row) => row.streamerName },
  { header: "Facebook post id", value: (row) => row.facebookPostId },
  { header: "Created time (UTC)", value: (row) => row.createdTime },
  { header: "Message", value: (row) => row.message },
  { header: "Reactions", value: (row) => countOrBlank(row.reactionCount) },
  { header: "Comments", value: (row) => countOrBlank(row.commentCount) },
  { header: "Shares", value: (row) => countOrBlank(row.shareCount) },
  { header: "Insight metrics available", value: (row) => row.metricCount },
  { header: "Sentiment", value: (row) => (row.sentiment ? sentimentLabel(row.sentiment) : null) },
  {
    header: "Summary status",
    value: (row) => (row.summaryStatus ? summaryStatusLabel(row.summaryStatus) : null),
  },
  { header: "Comments analysed", value: (row) => countOrBlank(row.storedCommentCount) },
  { header: "Permalink", value: (row) => row.permalinkUrl },
  { header: "Last synced (UTC)", value: (row) => row.lastSyncedAt },
];

export const VIDEO_EXPORT_COLUMNS: readonly CsvColumn<VideoTableItem>[] = [
  { header: "Streamer code", value: (row) => row.streamerCode },
  { header: "Streamer name", value: (row) => row.streamerName },
  { header: "Facebook video id", value: (row) => row.facebookVideoId },
  { header: "Created time (UTC)", value: (row) => row.createdTime },
  { header: "Title", value: (row) => row.title },
  { header: "Description", value: (row) => row.description },
  // Both forms: the seconds are what a spreadsheet can compute with, the
  // formatted duration is what a person reads.
  { header: "Length (seconds)", value: (row) => row.lengthSeconds },
  { header: "Length", value: (row) => formatDuration(row.lengthSeconds) },
  { header: "Insight metrics available", value: (row) => row.metricCount },
  { header: "Comments analysed", value: (row) => countOrBlank(row.storedCommentCount) },
  { header: "Sentiment", value: (row) => (row.sentiment ? sentimentLabel(row.sentiment) : null) },
  {
    header: "Summary status",
    value: (row) => (row.summaryStatus ? summaryStatusLabel(row.summaryStatus) : null),
  },
  { header: "Permalink", value: (row) => row.permalinkUrl },
  { header: "Last synced (UTC)", value: (row) => row.lastSyncedAt },
];

/** Finding lists are joined with a pipe: a comma would fight the format. */
function joinFindings(value: unknown): string | null {
  const items = realFindings(value);
  return items.length === 0 ? null : items.join(" | ");
}

export const ANALYSIS_EXPORT_COLUMNS: readonly CsvColumn<AnalysisListItem>[] = [
  { header: "Streamer code", value: (row) => row.streamerCode },
  { header: "Streamer name", value: (row) => row.streamerName },
  { header: "Content type", value: (row) => (row.contentType === "video" ? "Video" : "Post") },
  { header: "Content title", value: (row) => row.contentTitle },
  { header: "Content published (UTC)", value: (row) => row.contentCreatedAt },
  { header: "Comments analysed", value: (row) => row.commentCount },
  { header: "Sentiment", value: (row) => sentimentLabel(row.sentiment) },
  { header: "Summary status", value: (row) => summaryStatusLabel(row.status) },
  { header: "Summary", value: (row) => row.summary },
  { header: "Positive points", value: (row) => joinFindings(row.positivePoints) },
  { header: "Concerns", value: (row) => joinFindings(row.concerns) },
  { header: "Suggestions", value: (row) => joinFindings(row.suggestions) },
  { header: "Questions", value: (row) => joinFindings(row.questions) },
  { header: "Urgent issues", value: (row) => joinFindings(row.urgentIssues) },
  { header: "Urgent issue count", value: (row) => row.urgentCount },
  { header: "Generated (UTC)", value: (row) => row.generatedAt },
  { header: "Permalink", value: (row) => row.permalinkUrl },
];

/**
 * Ceiling on an export.
 *
 * A download is a single request holding every row in memory before the first
 * byte is written, so it needs a bound that a paginated screen does not. The cap
 * applies after sorting, so "the first 5,000 by urgency" is a meaningful subset
 * rather than an arbitrary one.
 */
export const EXPORT_ROW_LIMIT = 5000;
