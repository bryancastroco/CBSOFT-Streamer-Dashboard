import {
  EXPORT_DEFINITIONS,
  type CommentSummaryExportRow,
  type ExportDataset,
  type PostExportRow,
  type PostInsightExportRow,
  type StreamerExportRow,
  type SyncLogExportRow,
  type VideoExportRow,
  type VideoInsightExportRow,
} from "@/lib/google-sheets/export-contract";

/**
 * The Google Sheets layout — a PURE module.
 *
 * ## What this is, and why it is separate from the export contract
 *
 * `export-contract.ts` defines the **API**: snake_case field names, every
 * column the application is willing to publish, and the Zod schemas that police
 * it. This file defines the **spreadsheet**: which of those fields appear on
 * each tab, in what order, under what human-readable header.
 *
 * They are deliberately two things. A spreadsheet header is read by a person and
 * changing one is a cosmetic decision; an API field name is read by code and
 * changing one breaks a workflow. Fusing them would mean every header tweak was
 * a breaking API change, and every API addition silently widened the sheet.
 *
 * So a tab is a **projection** of a dataset: a subset, reordered and relabelled.
 * It can never contain a field the export does not already publish —
 * `sourceField` is typed against the dataset's own row type, and a test asserts
 * every one exists in the contract.
 *
 * ## Google Sheets is a mirror, never a source
 *
 * Nothing in this application ever reads a sheet. Architecture rule 2: the
 * database is the primary store and Sheets is a reporting destination. The
 * matching column exists so n8n can *upsert* rather than append — without it a
 * nightly run would add a duplicate row for every post, every night — not so
 * anything can be read back.
 *
 * ## Credentials
 *
 * There is no Google credential in this repository and no place to put one. n8n
 * owns it. This application produces rows; n8n moves them.
 */

/**
 * The types a sheet cell can hold, as far as a workflow needs to know.
 *
 * Deliberately coarse. This tells an operator how to format a column and tells a
 * workflow whether a value needs parsing — it is not a validation schema, which
 * is what the Zod contract is for.
 */
export type SheetColumnType =
  "uuid" | "string" | "text" | "integer" | "number" | "boolean" | "datetime" | "url";

export type SheetColumn<Row> = {
  /** The header cell. What a person reads. */
  header: string;
  /** The export field it comes from. Typed, so it cannot name a field that does not exist. */
  sourceField: keyof Row & string;
  type: SheetColumnType;
  /** One line for the schema endpoint and the docs. */
  description: string;
};

export type SheetTab<Row> = {
  /** The tab name, exactly as it must appear in the spreadsheet. */
  tab: string;
  dataset: ExportDataset;
  columns: readonly SheetColumn<Row>[];
  /**
   * The column n8n configures "Column to Match On" with.
   *
   * Stable for the life of the row, which no timestamp is. Get this wrong and
   * every Append-or-Update becomes an Append.
   */
  matchColumn: string;
  description: string;
};

// ---------------------------------------------------------------------------
// The seven tabs
// ---------------------------------------------------------------------------

/*
 * Column order is the order the spreadsheet's header row must use. Sheets is
 * positional once the header exists, so this list is part of the layout
 * contract, not a presentation detail.
 */

const streamersTab = {
  tab: "Streamers",
  dataset: "streamers",
  matchColumn: "Streamer ID",
  description: "One row per streamer. The roster, with Page connection health.",
  columns: [
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description:
        "Internal identifier. Stable for the life of the streamer, and the matching column.",
    },
    {
      header: "Streamer Code",
      sourceField: "streamer_code",
      type: "string",
      description: "Business key, e.g. CBS-014.",
    },
    {
      header: "Streamer Name",
      sourceField: "streamer_name",
      type: "string",
      description: "Display name.",
    },
    {
      header: "Page ID",
      sourceField: "facebook_page_id",
      type: "string",
      description: "Meta Page identifier. Public.",
    },
    {
      header: "Page Name",
      sourceField: "facebook_page_name",
      type: "string",
      description: "Meta Page name.",
    },
    {
      header: "Token Status",
      sourceField: "token_status",
      type: "string",
      description:
        "Health only — valid, expiring, expired, invalid, missing_permission, missing. Never the token.",
    },
    {
      header: "Active",
      sourceField: "active",
      type: "boolean",
      description: "Whether the streamer is being synchronised.",
    },
    {
      header: "Last Successful Sync",
      sourceField: "last_successful_sync_at",
      type: "datetime",
      description: "UTC. Blank if never.",
    },
    {
      header: "Last Sync Error",
      sourceField: "last_sync_error",
      type: "text",
      description: "Sanitised message. Blank when the last run was clean.",
    },
    {
      header: "Updated At",
      sourceField: "updated_at",
      type: "datetime",
      description: "UTC. The incremental watermark.",
    },
  ],
} as const satisfies SheetTab<StreamerExportRow>;

const postsTab = {
  tab: "Facebook Posts",
  dataset: "posts",
  matchColumn: "Post ID",
  description: "One row per published Page post.",
  columns: [
    {
      header: "Post ID",
      sourceField: "facebook_post_id",
      type: "string",
      description: "Meta's {page-id}_{post-id}. Globally unique, and the matching column.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Joins to the Streamers tab.",
    },
    {
      header: "Streamer Name",
      sourceField: "streamer_name",
      type: "string",
      description: "Display name, denormalised so the tab reads without a lookup.",
    },
    {
      header: "Page ID",
      sourceField: "facebook_page_id",
      type: "string",
      description: "Meta Page identifier.",
    },
    {
      header: "Message",
      sourceField: "message",
      type: "text",
      description: "Post text. Blank when the post had none.",
    },
    {
      header: "Created Time",
      sourceField: "created_time",
      type: "datetime",
      description: "UTC. When the post was published.",
    },
    {
      header: "Reactions",
      sourceField: "reactions",
      type: "integer",
      description: "Blank means Meta did not report it — NOT zero.",
    },
    {
      header: "Comments",
      sourceField: "comments",
      type: "integer",
      description: "Blank means Meta did not report it — NOT zero.",
    },
    {
      header: "Shares",
      sourceField: "shares",
      type: "integer",
      description:
        "Blank means Meta did not report it. Meta omits shares entirely on a post with none.",
    },
    {
      header: "Permalink",
      sourceField: "permalink_url",
      type: "url",
      description: "Link to the post on Facebook.",
    },
    {
      header: "Last Synced At",
      sourceField: "last_synced_at",
      type: "datetime",
      description: "UTC. When this row was last refreshed from Meta.",
    },
  ],
} as const satisfies SheetTab<PostExportRow>;

const postInsightsTab = {
  tab: "Post Insights",
  dataset: "post_insights",
  matchColumn: "Insight Key",
  description:
    "One row per stored post metric. As wide as whatever Meta returned — no metric name is hard-coded.",
  columns: [
    {
      header: "Insight Key",
      sourceField: "insight_key",
      type: "string",
      description:
        "Composite of post, metric, period and end time. Mirrors the database's uniqueness rule, and the matching column.",
    },
    {
      header: "Post ID",
      sourceField: "facebook_post_id",
      type: "string",
      description: "Joins to the Facebook Posts tab.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Joins to the Streamers tab.",
    },
    {
      header: "Metric Name",
      sourceField: "metric_name",
      type: "string",
      description: "Whatever Meta called it.",
    },
    {
      header: "Period",
      sourceField: "period",
      type: "string",
      description: "lifetime, day, week, days_28… Blank when Meta sent none.",
    },
    {
      header: "Value",
      sourceField: "value_display",
      type: "string",
      description:
        "Readable rendering. Blank means the metric was not reported — NOT zero. The exact value is in value_json on the API.",
    },
    {
      header: "End Time",
      sourceField: "end_time",
      type: "datetime",
      description: "UTC. Set for periodic metrics only.",
    },
    {
      header: "Collected At",
      sourceField: "collected_at",
      type: "datetime",
      description: "UTC. The incremental watermark.",
    },
  ],
} as const satisfies SheetTab<PostInsightExportRow>;

const videosTab = {
  tab: "Facebook Videos",
  dataset: "videos",
  matchColumn: "Video ID",
  description: "One row per Page video. Ended live broadcasts appear here as VODs.",
  columns: [
    {
      header: "Video ID",
      sourceField: "facebook_video_id",
      type: "string",
      description: "Meta's video identifier. Globally unique, and the matching column.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Joins to the Streamers tab.",
    },
    {
      header: "Streamer Name",
      sourceField: "streamer_name",
      type: "string",
      description: "Display name, denormalised so the tab reads without a lookup.",
    },
    {
      header: "Page ID",
      sourceField: "facebook_page_id",
      type: "string",
      description: "Meta Page identifier.",
    },
    {
      header: "Title",
      sourceField: "title",
      type: "string",
      description: "Blank when Meta reported none.",
    },
    {
      header: "Description",
      sourceField: "description",
      type: "text",
      description: "Blank when Meta reported none.",
    },
    {
      header: "Length Seconds",
      sourceField: "length_seconds",
      type: "number",
      description:
        "Fractional — Meta reports it that way. Blank means no length was reported, NOT a zero-length video.",
    },
    {
      header: "Created Time",
      sourceField: "created_time",
      type: "datetime",
      description: "UTC. When the video was published.",
    },
    {
      header: "Permalink",
      sourceField: "permalink_url",
      type: "url",
      description: "Link to the video on Facebook.",
    },
    {
      header: "Last Synced At",
      sourceField: "last_synced_at",
      type: "datetime",
      description: "UTC. When this row was last refreshed from Meta.",
    },
  ],
} as const satisfies SheetTab<VideoExportRow>;

const videoInsightsTab = {
  tab: "Video Insights",
  dataset: "video_insights",
  matchColumn: "Insight Key",
  description: "One row per stored video metric.",
  columns: [
    {
      header: "Insight Key",
      sourceField: "insight_key",
      type: "string",
      description:
        "Composite of video, metric, period and end time. Mirrors the database's uniqueness rule, and the matching column.",
    },
    {
      header: "Video ID",
      sourceField: "facebook_video_id",
      type: "string",
      description: "Joins to the Facebook Videos tab.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Joins to the Streamers tab.",
    },
    {
      header: "Metric Name",
      sourceField: "metric_name",
      type: "string",
      description: "Whatever Meta called it.",
    },
    {
      header: "Period",
      sourceField: "period",
      type: "string",
      description: "Blank when Meta sent none.",
    },
    {
      header: "Value",
      sourceField: "value_display",
      type: "string",
      description:
        "Readable rendering. A retention curve shows as '5 entries'; the exact array is in value_json on the API.",
    },
    {
      header: "End Time",
      sourceField: "end_time",
      type: "datetime",
      description: "UTC. Set for periodic metrics only.",
    },
    {
      header: "Collected At",
      sourceField: "collected_at",
      type: "datetime",
      description: "UTC. The incremental watermark.",
    },
  ],
} as const satisfies SheetTab<VideoInsightExportRow>;

const commentSummariesTab = {
  tab: "Comment Summaries",
  dataset: "comment_summaries",
  matchColumn: "Summary ID",
  description:
    "One row per AI comment analysis, across posts and videos. The analysis only — never the comments, and never a commenter, because none is collected.",
  columns: [
    {
      header: "Summary ID",
      sourceField: "summary_id",
      type: "uuid",
      description:
        "Stable for the life of the analysis, and the matching column. Regenerating updates this row in place.",
    },
    {
      header: "Content Type",
      sourceField: "content_type",
      type: "string",
      description: "post or video.",
    },
    {
      header: "Content ID",
      sourceField: "facebook_content_id",
      type: "string",
      description: "Meta's post or video id. Joins to the Posts or Videos tab.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Joins to the Streamers tab.",
    },
    {
      header: "Streamer Name",
      sourceField: "streamer_name",
      type: "string",
      description: "Display name.",
    },
    {
      header: "Content Title",
      sourceField: "content_title",
      type: "text",
      description: "A post's message or a video's title.",
    },
    {
      header: "Comment Count",
      sourceField: "comments_analyzed",
      type: "integer",
      description: "How many comments the analysis covered.",
    },
    {
      header: "Sentiment",
      sourceField: "sentiment",
      type: "string",
      description: "positive, mixed, negative, neutral or no_comments.",
    },
    {
      header: "Summary",
      sourceField: "summary",
      type: "text",
      description: "The narrative summary.",
    },
    {
      header: "Positive Points",
      sourceField: "positive_points",
      type: "text",
      description: "Pipe-separated. Blank when there were no real findings.",
    },
    {
      header: "Concerns",
      sourceField: "concerns",
      type: "text",
      description: "Pipe-separated. Blank when there were no real findings.",
    },
    {
      header: "Suggestions",
      sourceField: "suggestions",
      type: "text",
      description: "Pipe-separated. Blank when there were no real findings.",
    },
    {
      header: "Questions",
      sourceField: "questions",
      type: "text",
      description: "Pipe-separated. Blank when there were no real findings.",
    },
    {
      header: "Urgent Issues",
      sourceField: "urgent_issues",
      type: "text",
      description:
        "Pipe-separated. Blank when there were no real findings — the model's 'No significant findings' placeholder is never written out as text.",
    },
    {
      header: "Generated At",
      sourceField: "generated_at",
      type: "datetime",
      description: "UTC. When the analysis was produced.",
    },
  ],
} as const satisfies SheetTab<CommentSummaryExportRow>;

const syncLogsTab = {
  tab: "Sync Logs",
  dataset: "sync_logs",
  matchColumn: "Sync Run ID",
  description:
    "One row per synchronisation run, so the automation's own history sits beside the data it moved.",
  columns: [
    {
      header: "Sync Run ID",
      sourceField: "sync_run_id",
      type: "uuid",
      description: "The matching column. A run is written once and updated when it closes.",
    },
    {
      header: "Streamer ID",
      sourceField: "streamer_id",
      type: "uuid",
      description: "Blank for a roster-wide automation sweep, which belongs to no single streamer.",
    },
    {
      header: "Sync Type",
      sourceField: "sync_type",
      type: "string",
      description: "automation, manual, full, incremental, backfill or token_check.",
    },
    {
      header: "Status",
      sourceField: "status",
      type: "string",
      description: "pending, running, succeeded, partial or failed.",
    },
    {
      header: "Posts Processed",
      sourceField: "posts_processed",
      type: "integer",
      description: "Posts written by this run.",
    },
    {
      header: "Videos Processed",
      sourceField: "videos_processed",
      type: "integer",
      description: "Videos written by this run.",
    },
    {
      header: "Comments Processed",
      sourceField: "comments_processed",
      type: "integer",
      description: "Comments stored by this run.",
    },
    {
      header: "Summaries Generated",
      sourceField: "summaries_generated",
      type: "integer",
      description: "AI analyses produced by this run.",
    },
    {
      header: "Started At",
      sourceField: "started_at",
      type: "datetime",
      description: "UTC. The incremental watermark.",
    },
    {
      header: "Completed At",
      sourceField: "completed_at",
      type: "datetime",
      description: "UTC. Blank while the run is still in flight.",
    },
    {
      header: "Error Message",
      sourceField: "error_message",
      type: "text",
      description: "Sanitised. Blank on a clean run.",
    },
  ],
} as const satisfies SheetTab<SyncLogExportRow>;

/** Every tab, in the order they should appear in the spreadsheet. */
export const SHEET_TABS = [
  streamersTab,
  postsTab,
  postInsightsTab,
  videosTab,
  videoInsightsTab,
  commentSummariesTab,
  syncLogsTab,
] as const satisfies readonly SheetTab<Record<string, unknown>>[];

export type SheetTabDefinition = (typeof SHEET_TABS)[number];

/** The n8n branch letters, in the order the documentation lists them. */
export const BRANCH_LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const;

export function branchLetterFor(dataset: ExportDataset): string | null {
  const index = SHEET_TABS.findIndex((tab) => tab.dataset === dataset);
  return index === -1 ? null : (BRANCH_LETTERS[index] ?? null);
}

export function sheetTabFor(dataset: ExportDataset): SheetTabDefinition | null {
  return SHEET_TABS.find((tab) => tab.dataset === dataset) ?? null;
}

/** The header row, in order. */
export function sheetHeadersFor(dataset: ExportDataset): readonly string[] {
  return sheetTabFor(dataset)?.columns.map((column) => column.header) ?? [];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Re-key one export row into its sheet shape.
 *
 * n8n's Google Sheets node maps a field to a column by *name*. Doing the
 * renaming here means a branch needs no Set node between the HTTP Request and
 * the Sheets node — which matters because seven branches × one hand-maintained
 * mapping node each is seven places for a column to be quietly dropped.
 *
 * Strictly a projection: it can only read fields the export already published,
 * so this cannot widen what leaves the server.
 *
 * `null` and `undefined` both become `""`. A Sheets cell has no null, and an
 * empty cell is the honest rendering of "not reported" — writing `0` or `"null"`
 * would turn an absence into a value.
 */
export function projectRowToSheet(
  dataset: ExportDataset,
  row: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const tab = sheetTabFor(dataset);
  if (!tab) return {};

  const projected: Record<string, string | number | boolean> = {};

  for (const column of tab.columns) {
    const value = row[column.sourceField];

    if (value === null || value === undefined) {
      projected[column.header] = "";
      continue;
    }

    // Numbers and booleans are passed through so the sheet can hold them as
    // real values rather than as text that has to be coerced in a formula.
    projected[column.header] =
      typeof value === "number" || typeof value === "boolean" ? value : String(value);
  }

  return projected;
}

export function projectRowsToSheet(
  dataset: ExportDataset,
  rows: readonly Record<string, unknown>[],
): Record<string, string | number | boolean>[] {
  return rows.map((row) => projectRowToSheet(dataset, row));
}

// ---------------------------------------------------------------------------
// The schema document
// ---------------------------------------------------------------------------

/**
 * The machine-readable layout served by
 * `GET /api/automation/google-sheets/schema`.
 *
 * Built from the definitions above rather than written out again, so the
 * endpoint cannot describe a spreadsheet the exports do not produce.
 */
export function buildSheetSchemaDocument() {
  return {
    contract_version: 2,
    generated_at: new Date().toISOString(),
    spreadsheet: {
      /** The application never reads a sheet. See the module note. */
      direction: "write-only mirror",
      owner_of_google_credential: "n8n",
      timezone: "UTC",
    },
    tabs: SHEET_TABS.map((tab, index) => ({
      tab: tab.tab,
      branch: BRANCH_LETTERS[index] ?? null,
      dataset: tab.dataset,
      description: tab.description,
      export_endpoint: `/api/automation/exports/${tab.dataset.replace(/_/g, "-")}`,
      /** Add `?format=sheets` and the field names arrive already renamed. */
      sheets_format_endpoint: `/api/automation/exports/${tab.dataset.replace(/_/g, "-")}?format=sheets`,
      csv_fallback_endpoint: `/api/export/sheets/${tab.dataset.replace(/_/g, "-")}`,
      match_column: tab.matchColumn,
      watermark_column_api: EXPORT_DEFINITIONS[tab.dataset].watermarkColumn,
      required_columns: tab.columns.map((column) => column.header),
      columns: tab.columns.map((column) => ({
        header: column.header,
        type: column.type,
        api_field: column.sourceField,
        is_match_column: column.header === tab.matchColumn,
        description: column.description,
      })),
    })),
    notes: [
      "Google Sheets is a reporting mirror. Nothing in this application ever reads it back.",
      "n8n owns the Google credential. This application has no place to store one and never asks for one.",
      "No Facebook Page token, ciphertext or token suffix appears on any tab. Token Status is a health enum.",
      "An empty cell means the value was not reported. It never means zero.",
      "Use Append or Update Row keyed on match_column. A plain Append duplicates every row on every run.",
    ],
  };
}

export type SheetSchemaDocument = ReturnType<typeof buildSheetSchemaDocument>;
