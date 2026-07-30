import "server-only";

import { z } from "zod";

/**
 * The contract between this application and n8n / Google Sheets.
 *
 * Google Sheets is a REPORTING DESTINATION, never a source of truth
 * (architecture rule 2). The application owns the shape of exported rows; n8n is
 * a dumb transport that upserts what it receives.
 *
 * ## The rule this file exists to enforce
 *
 * Every field below is safe to leave the server. There is deliberately no token,
 * no ciphertext, no four-character suffix, no internal user id and no commenter
 * identity in any schema here — that is the mechanism behind architecture rule
 * 5, and `tests/automation-exports.test.ts` asserts the exact column list of
 * every dataset so a field cannot be added without a deliberate edit in two
 * places.
 *
 * Rows are built by `src/lib/repositories/automation-exports.ts` and validated
 * against these schemas before they are sent. A row that does not match is a
 * `500`, not a silently reshaped payload: Sheets is append/upsert-oriented and a
 * column that changes shape mid-run corrupts the destination sheet.
 *
 * ## Why `snake_case`
 *
 * These names become spreadsheet header cells and n8n expression paths. They are
 * a published interface: renaming one breaks a sheet and a workflow that this
 * repository cannot see, so they change only with a version bump.
 */

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------

/** Timestamps cross the wire as ISO 8601 in UTC, always. */
const timestamp = z.iso.datetime();
const nullableTimestamp = z.iso.datetime().nullable();

/**
 * A metric value of any JSON shape.
 *
 * Meta returns scalars, strings, arrays, breakdown objects and nested trees.
 * Sheets can only hold a scalar per cell, so the value is carried twice: a
 * compact `value_display` for the cell a human reads, and `value_json` — the
 * exact value, JSON-encoded — for a workflow that needs to compute on it.
 * Flattening to one would either lose the structure or fill the sheet with
 * `[object Object]`.
 */
const insightValue = {
  value_display: z.string(),
  value_json: z.string(),
  value_type: z.enum(["number", "string", "boolean", "array", "object", "null"]),
};

// ---------------------------------------------------------------------------
// Dataset rows
// ---------------------------------------------------------------------------

/**
 * One streamer.
 *
 * `token_status` is included and is **not** token material: it is a health enum
 * (`valid`, `expiring`, `missing`…) that says whether a Page can be synced. An
 * operations workflow alerting on "this Page needs reauthorising" needs it, and
 * it reveals nothing about the credential itself. The ciphertext, the masked
 * form and the four-character suffix are all absent, and no schema in this file
 * has a field capable of holding them.
 */
export const streamerExportRowSchema = z.object({
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  streamer_name: z.string(),
  facebook_page_id: z.string(),
  facebook_page_name: z.string(),
  active: z.boolean(),
  token_status: z.string(),
  token_expires_at: nullableTimestamp,
  last_successful_sync_at: nullableTimestamp,
  last_sync_error: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const postExportRowSchema = z.object({
  post_id: z.uuid(),
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  streamer_name: z.string(),
  facebook_page_id: z.string(),
  facebook_post_id: z.string(),
  message: z.string().nullable(),
  created_time: timestamp,
  permalink_url: z.url().nullable(),
  // Nullable throughout: Meta omits `shares` entirely on a post with none, and
  // a blank cell is the honest rendering. Never coerced to 0.
  reactions: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  shares: z.number().int().nullable(),
  insight_metric_count: z.number().int().nonnegative(),
  last_synced_at: timestamp,
  updated_at: timestamp,
});

/**
 * A deterministic key for one insight row.
 *
 * Mirrors the database's uniqueness expression —
 * `(content, metric_name, coalesce(period,''), coalesce(end_time,'epoch'))` — so
 * the key a spreadsheet upserts on is the same identity the database enforces.
 *
 * Why not just the UUID? The UUID is stable across re-syncs, because the upsert
 * updates in place. But it is opaque: an operator looking at a sheet row cannot
 * tell which metric it is, and if a row is ever deleted and re-collected the
 * UUID changes while the composite key does not. The UUID is exported too — this
 * is the one the sheet matches on.
 */
export function buildInsightKey(params: {
  facebookContentId: string;
  metricName: string;
  period: string | null;
  endTime: string | null;
}): string {
  return [
    params.facebookContentId,
    params.metricName,
    params.period ?? "",
    params.endTime ?? "",
  ].join("::");
}

export const postInsightExportRowSchema = z.object({
  /** Composite, deterministic. The Sheets matching column. */
  insight_key: z.string(),
  post_insight_id: z.uuid(),
  post_id: z.uuid(),
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  facebook_post_id: z.string(),
  metric_name: z.string(),
  period: z.string().nullable(),
  ...insightValue,
  end_time: nullableTimestamp,
  collected_at: timestamp,
});

export const videoExportRowSchema = z.object({
  video_id: z.uuid(),
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  streamer_name: z.string(),
  facebook_page_id: z.string(),
  facebook_video_id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  length_seconds: z.number().nullable(),
  created_time: timestamp,
  permalink_url: z.url().nullable(),
  insight_metric_count: z.number().int().nonnegative(),
  last_synced_at: timestamp,
  updated_at: timestamp,
});

export const videoInsightExportRowSchema = z.object({
  /** Composite, deterministic. The Sheets matching column. */
  insight_key: z.string(),
  video_insight_id: z.uuid(),
  video_id: z.uuid(),
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  facebook_video_id: z.string(),
  metric_name: z.string(),
  period: z.string().nullable(),
  ...insightValue,
  end_time: nullableTimestamp,
  collected_at: timestamp,
});

/**
 * One AI comment analysis.
 *
 * Note what is not here: the comments. This carries the analysis, which is the
 * deliverable, and there is no commenter field because none is ever collected —
 * the Graph request does not ask for `from`. Finding lists are pipe-joined,
 * because a comma would fight both CSV and a spreadsheet cell.
 */
export const commentSummaryExportRowSchema = z.object({
  summary_id: z.uuid(),
  streamer_id: z.uuid(),
  streamer_code: z.string(),
  streamer_name: z.string(),
  content_type: z.enum(["post", "video"]),
  content_id: z.uuid(),
  facebook_content_id: z.string(),
  content_title: z.string().nullable(),
  content_created_time: timestamp,
  permalink_url: z.url().nullable(),
  comments_analyzed: z.number().int().nonnegative(),
  sentiment: z.string().nullable(),
  summary: z.string().nullable(),
  positive_points: z.string().nullable(),
  concerns: z.string().nullable(),
  suggestions: z.string().nullable(),
  questions: z.string().nullable(),
  urgent_issues: z.string().nullable(),
  urgent_issue_count: z.number().int().nonnegative(),
  status: z.string(),
  ai_provider: z.string().nullable(),
  model: z.string().nullable(),
  generated_at: nullableTimestamp,
  updated_at: timestamp,
});

export const syncLogExportRowSchema = z.object({
  sync_run_id: z.uuid(),
  parent_sync_run_id: z.uuid().nullable(),
  streamer_id: z.uuid().nullable(),
  streamer_code: z.string().nullable(),
  sync_type: z.string(),
  status: z.string(),
  posts_processed: z.number().int().nonnegative(),
  videos_processed: z.number().int().nonnegative(),
  comments_processed: z.number().int().nonnegative(),
  summaries_generated: z.number().int().nonnegative(),
  started_at: timestamp,
  completed_at: nullableTimestamp,
  duration_seconds: z.number().nullable(),
  // Already sanitised where it was written; sanitised again on the way out.
  error_message: z.string().nullable(),
});

export type StreamerExportRow = z.infer<typeof streamerExportRowSchema>;
export type PostExportRow = z.infer<typeof postExportRowSchema>;
export type PostInsightExportRow = z.infer<typeof postInsightExportRowSchema>;
export type VideoExportRow = z.infer<typeof videoExportRowSchema>;
export type VideoInsightExportRow = z.infer<typeof videoInsightExportRowSchema>;
export type CommentSummaryExportRow = z.infer<typeof commentSummaryExportRowSchema>;
export type SyncLogExportRow = z.infer<typeof syncLogExportRowSchema>;

// ---------------------------------------------------------------------------
// The dataset registry
// ---------------------------------------------------------------------------

export const EXPORT_DATASETS = [
  "streamers",
  "posts",
  "post_insights",
  "videos",
  "video_insights",
  "comment_summaries",
  "sync_logs",
] as const;

export type ExportDataset = (typeof EXPORT_DATASETS)[number];

type DatasetDefinition = {
  schema: z.ZodObject;
  /**
   * The column the destination sheet should key its upsert on. Stable for the
   * life of a row, which `updated_at`-style columns are not.
   */
  keyColumn: string;
  /**
   * The column `updated_after` filters on, and the column rows are ordered by.
   * Named in the envelope so a workflow can checkpoint on the right field
   * without hard-coding one per dataset.
   */
  watermarkColumn: string;
};

export const EXPORT_DEFINITIONS: Record<ExportDataset, DatasetDefinition> = {
  streamers: {
    schema: streamerExportRowSchema,
    keyColumn: "streamer_id",
    watermarkColumn: "updated_at",
  },
  posts: {
    schema: postExportRowSchema,
    keyColumn: "facebook_post_id",
    watermarkColumn: "updated_at",
  },
  post_insights: {
    schema: postInsightExportRowSchema,
    keyColumn: "insight_key",
    watermarkColumn: "collected_at",
  },
  videos: {
    schema: videoExportRowSchema,
    keyColumn: "facebook_video_id",
    watermarkColumn: "updated_at",
  },
  video_insights: {
    schema: videoInsightExportRowSchema,
    keyColumn: "insight_key",
    watermarkColumn: "collected_at",
  },
  comment_summaries: {
    schema: commentSummaryExportRowSchema,
    keyColumn: "summary_id",
    watermarkColumn: "updated_at",
  },
  sync_logs: {
    schema: syncLogExportRowSchema,
    keyColumn: "sync_run_id",
    watermarkColumn: "started_at",
  },
};

/**
 * The column order for a dataset.
 *
 * Taken from the Zod shape, so the declaration above is the single source of
 * truth: there is no second list to forget to update. Sheets is positional —
 * the header row is written once and rows are appended under it — so this order
 * is part of the contract, not a presentation detail.
 */
export function columnsFor(dataset: ExportDataset): readonly string[] {
  return Object.keys(EXPORT_DEFINITIONS[dataset].schema.shape);
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * What every export endpoint returns.
 *
 * The metadata exists so an n8n workflow can be written once and pointed at any
 * dataset: it reads `columns` to build the header, `key_column` to configure the
 * upsert, `watermark_column` plus `max_watermark` to checkpoint for the next
 * incremental run, and `has_more`/`next_offset` to drive its pagination loop.
 */
export const exportEnvelopeSchema = z.object({
  ok: z.literal(true),
  dataset: z.enum(EXPORT_DATASETS),
  /**
   * Bumped when a column set changes.
   *
   * v2 (Phase 9) added `insight_key` to both insight datasets and moved their
   * `key_column` onto it. Additive for anything reading by name, but the
   * matching column changed, so a consumer configured against v1 must be
   * re-pointed.
   */
  contract_version: z.literal(2),
  generated_at: timestamp,
  columns: z.array(z.string()),
  key_column: z.string(),
  watermark_column: z.string(),
  /**
   * The highest watermark in this page, or null when the page is empty. Feed it
   * back as `updated_after` next run to fetch only what has changed since.
   */
  max_watermark: nullableTimestamp,
  filters: z.object({
    updated_after: nullableTimestamp,
    from: nullableTimestamp,
    to: nullableTimestamp,
    streamer_id: z.uuid().nullable(),
  }),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
  }),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export type ExportEnvelope = z.infer<typeof exportEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Phase 1 period-report schemas (unchanged, still unpopulated)
// ---------------------------------------------------------------------------

/**
 * The two period-report sheets sketched in Phase 1.
 *
 * They describe *aggregates over a period*, which needs the
 * `streamer_period_metrics` materialisation that is still to come. The datasets
 * above export the underlying rows and are what the Phase 8 endpoints serve;
 * these remain the target shape for the reporting phase.
 */
export const streamerPerformanceRowSchema = z.object({
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  streamer_name: z.string(),
  facebook_page_name: z.string(),
  facebook_page_id: z.string(),
  streams_count: z.number().int().nonnegative(),
  total_minutes_streamed: z.number().int().nonnegative(),
  total_views: z.number().int().nonnegative(),
  peak_concurrent_viewers: z.number().int().nonnegative(),
  average_watch_time_seconds: z.number().nonnegative(),
  new_followers: z.number().int(),
  reactions: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  engagement_rate: z.number(),
  synced_at: timestamp,
});

export type StreamerPerformanceRow = z.infer<typeof streamerPerformanceRowSchema>;

export const streamLogRowSchema = z.object({
  stream_id: z.string(),
  streamer_name: z.string(),
  facebook_page_name: z.string(),
  title: z.string(),
  started_at: timestamp,
  ended_at: nullableTimestamp,
  duration_seconds: z.number().int().nonnegative(),
  peak_concurrent_viewers: z.number().int().nonnegative(),
  total_views: z.number().int().nonnegative(),
  reactions: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  permalink: z.url().nullable(),
});

export type StreamLogRow = z.infer<typeof streamLogRowSchema>;

export const STREAMER_PERFORMANCE_COLUMNS = Object.keys(
  streamerPerformanceRowSchema.shape,
) as readonly string[];

export const STREAM_LOG_COLUMNS = Object.keys(streamLogRowSchema.shape) as readonly string[];
