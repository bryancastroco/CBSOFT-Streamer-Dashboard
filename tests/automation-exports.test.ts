import { describe, expect, it } from "vitest";

import {
  describeFilters,
  parseExportQuery,
  EXPORT_MAX_LIMIT,
  EXPORT_DEFAULT_LIMIT,
} from "@/lib/automation/query";
import {
  columnsFor,
  EXPORT_DATASETS,
  EXPORT_DEFINITIONS,
  exportEnvelopeSchema,
  type ExportDataset,
} from "@/lib/google-sheets/export-contract";

const url = (query: string) => new URL(`https://example.test/api/automation/exports/posts${query}`);

// ---------------------------------------------------------------------------
// The query contract
// ---------------------------------------------------------------------------

describe("export query parsing", () => {
  it("defaults to a bounded first page", () => {
    const parsed = parseExportQuery(url(""));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.query.limit).toBe(EXPORT_DEFAULT_LIMIT);
    expect(parsed.query.offset).toBe(0);
    expect(parsed.query.updated_after).toBeUndefined();
  });

  it("reads every supported filter", () => {
    const parsed = parseExportQuery(
      url(
        "?updated_after=2026-07-01T10:00:00Z&from=2026-06-01&to=2026-06-30" +
          "&streamer_id=3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c&limit=100&offset=200",
      ),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Kept as text, not a Date — see the microsecond note in `query.ts`.
    expect(parsed.query.updated_after).toBe("2026-07-01T10:00:00Z");
    expect(parsed.query.from?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(parsed.query.streamer_id).toBe("3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c");
    expect(parsed.query.limit).toBe(100);
    expect(parsed.query.offset).toBe(200);
  });

  it("reads a bare date as midnight UTC", () => {
    const parsed = parseExportQuery(url("?from=2026-06-01"));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.from?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  /*
   * Regression. `updated_after` used to be parsed into a `Date`, which holds
   * only milliseconds — while Postgres stores `timestamptz` at microsecond
   * precision. Binding the truncated value made `stored .921456 > sent .921000`
   * true, so the boundary rows came back on every incremental run. And because
   * a bulk upsert stamps every row it writes with one transaction timestamp,
   * "the boundary rows" meant the entire previous batch: the filter did almost
   * nothing.
   *
   * The checkpoint is now kept as text and cast by Postgres, so the comparison
   * happens at the precision the value was stored with.
   */
  it("preserves microsecond precision in the checkpoint", () => {
    const parsed = parseExportQuery(url("?updated_after=2026-07-30T01:12:50.921456Z"));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.query.updated_after).toBe("2026-07-30T01:12:50.921456Z");
    // The precision a Date would have silently discarded.
    expect(parsed.query.updated_after).toContain("456");
    expect(typeof parsed.query.updated_after).toBe("string");
  });

  it("echoes the checkpoint back exactly as applied", () => {
    const parsed = parseExportQuery(url("?updated_after=2026-07-30T01:12:50.921456Z"));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // A caller comparing what it sent against what came back must see a match,
    // or it cannot tell whether its checkpoint was honoured.
    expect(describeFilters(parsed.query).updated_after).toBe("2026-07-30T01:12:50.921456Z");
  });

  /*
   * The behaviour that separates this from the browser-facing filters: a
   * machine caller is told it was wrong rather than quietly given a different
   * window. A workflow silently receiving the wrong range would write wrong
   * rows into a spreadsheet every night and nobody would notice.
   */
  it.each([
    ["?updated_after=last%20tuesday", "updated_after"],
    ["?from=not-a-date", "from"],
    ["?streamer_id=not-a-uuid", "streamer_id"],
    ["?limit=0", "limit"],
    ["?limit=-5", "limit"],
    ["?offset=-1", "offset"],
  ])("rejects %s rather than falling back", (query, field) => {
    const parsed = parseExportQuery(url(query));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.some((issue) => issue.field === field)).toBe(true);
  });

  it("refuses a limit above the ceiling", () => {
    const parsed = parseExportQuery(url(`?limit=${EXPORT_MAX_LIMIT + 1}`));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain(String(EXPORT_MAX_LIMIT));
  });

  it("refuses a range that ends before it starts", () => {
    const parsed = parseExportQuery(url("?from=2026-07-10&to=2026-07-01"));

    expect(parsed.ok).toBe(false);
  });

  it("ignores an unknown parameter rather than failing", () => {
    // n8n appends its own on occasion; a workflow should not break for that.
    expect(parseExportQuery(url("?limit=10&n8nRunIndex=3")).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Column stability
// ---------------------------------------------------------------------------

/**
 * The exact published column set of every dataset.
 *
 * These names become spreadsheet headers and n8n expression paths — a published
 * interface this repository cannot see the consumers of. The literals below are
 * duplicated on purpose: changing a column now requires editing the schema *and*
 * this list, which is the point. A silent rename breaks somebody's sheet.
 */
const EXPECTED_COLUMNS: Record<ExportDataset, string[]> = {
  streamers: [
    "streamer_id",
    "streamer_code",
    "streamer_name",
    "facebook_page_id",
    "facebook_page_name",
    "active",
    "token_status",
    "token_expires_at",
    "last_successful_sync_at",
    "last_sync_error",
    "created_at",
    "updated_at",
  ],
  posts: [
    "post_id",
    "streamer_id",
    "streamer_code",
    "streamer_name",
    "facebook_page_id",
    "facebook_post_id",
    "message",
    "created_time",
    "permalink_url",
    "reactions",
    "comments",
    "shares",
    "insight_metric_count",
    "last_synced_at",
    "updated_at",
    /*
     * Appended, never inserted. Every column above holds its position, so a
     * sheet or workflow reading by index is unaffected — which is the whole
     * reason a broadcast's feed story is marked here rather than dropped from
     * the tab.
     */
    "video_id",
  ],
  post_insights: [
    // Phase 9. The composite key the Sheets upsert matches on.
    "insight_key",
    "post_insight_id",
    "post_id",
    "streamer_id",
    "streamer_code",
    "facebook_post_id",
    "metric_name",
    "period",
    "value_display",
    "value_json",
    "value_type",
    "end_time",
    "collected_at",
  ],
  videos: [
    "video_id",
    "streamer_id",
    "streamer_code",
    "streamer_name",
    "facebook_page_id",
    "facebook_video_id",
    "title",
    "description",
    "length_seconds",
    "created_time",
    "permalink_url",
    "insight_metric_count",
    "last_synced_at",
    "updated_at",
  ],
  video_insights: [
    "insight_key",
    "video_insight_id",
    "video_id",
    "streamer_id",
    "streamer_code",
    "facebook_video_id",
    "metric_name",
    "period",
    "value_display",
    "value_json",
    "value_type",
    "end_time",
    "collected_at",
  ],
  comment_summaries: [
    "summary_id",
    "streamer_id",
    "streamer_code",
    "streamer_name",
    "content_type",
    "content_id",
    "facebook_content_id",
    "content_title",
    "content_created_time",
    "permalink_url",
    "comments_analyzed",
    "sentiment",
    "summary",
    "positive_points",
    "concerns",
    "suggestions",
    "questions",
    "urgent_issues",
    "urgent_issue_count",
    "status",
    "ai_provider",
    "model",
    "generated_at",
    "updated_at",
  ],
  sync_logs: [
    "sync_run_id",
    "parent_sync_run_id",
    "streamer_id",
    "streamer_code",
    "sync_type",
    "status",
    "posts_processed",
    "videos_processed",
    "comments_processed",
    "summaries_generated",
    "started_at",
    "completed_at",
    "duration_seconds",
    "error_message",
  ],
};

describe("export column contracts", () => {
  it("declares the seven datasets the specification names", () => {
    expect([...EXPORT_DATASETS]).toEqual([
      "streamers",
      "posts",
      "post_insights",
      "videos",
      "video_insights",
      "comment_summaries",
      "sync_logs",
    ]);
  });

  it.each(EXPORT_DATASETS)("%s has exactly its published columns, in order", (dataset) => {
    expect(columnsFor(dataset)).toEqual(EXPECTED_COLUMNS[dataset]);
  });

  it.each(EXPORT_DATASETS)("%s names a key column that exists in the row", (dataset) => {
    // n8n configures its Sheets upsert on this column; one that does not exist
    // would turn every upsert into an append and duplicate the sheet.
    expect(columnsFor(dataset)).toContain(EXPORT_DEFINITIONS[dataset].keyColumn);
  });

  it.each(EXPORT_DATASETS)("%s names a watermark column that exists in the row", (dataset) => {
    expect(columnsFor(dataset)).toContain(EXPORT_DEFINITIONS[dataset].watermarkColumn);
  });

  it.each(EXPORT_DATASETS)("%s uses snake_case throughout", (dataset) => {
    for (const column of columnsFor(dataset)) {
      expect(column, `${dataset}.${column}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule that matters most
// ---------------------------------------------------------------------------

/**
 * Substrings that must never appear in an exported column name.
 *
 * n8n is the least privileged actor in the system: it triggers work and receives
 * scrubbed rows, and holds no database, Meta or Supabase credential. These
 * payloads land in n8n execution logs and a Google Sheet, so they get the
 * narrowest column set in the codebase.
 */
const FORBIDDEN_FRAGMENTS = [
  "access_token",
  "page_token",
  "encrypted",
  "ciphertext",
  "last_four",
  "lastfour",
  "masked",
  "secret",
  "credential",
  "password",
  "bearer",
  "authorization",
  "api_key",
];

describe("exports never carry credential material", () => {
  it.each(EXPORT_DATASETS)("%s has no credential-shaped column", (dataset) => {
    for (const column of columnsFor(dataset)) {
      for (const fragment of FORBIDDEN_FRAGMENTS) {
        expect(column, `"${column}" in ${dataset} looks like credential material`).not.toContain(
          fragment,
        );
      }
    }
  });

  it("exports token health but never the token", () => {
    const columns = columnsFor("streamers");

    // A health enum is what lets a workflow alert on a Page needing reauth.
    expect(columns).toContain("token_status");
    // The credential itself, in any of its three stored forms, is absent.
    expect(columns).not.toContain("encrypted_page_token");
    expect(columns).not.toContain("page_token_last_four");
    expect(columns).not.toContain("masked_token");
  });

  it("exports no commenter field, because none is ever collected", () => {
    for (const dataset of EXPORT_DATASETS) {
      for (const column of columnsFor(dataset)) {
        expect(column).not.toContain("commenter");
        expect(column).not.toContain("author");
        expect(column).not.toMatch(/^from$/);
      }
    }
  });

  it("exports no internal user id", () => {
    for (const dataset of EXPORT_DATASETS) {
      // `streamer_id` is fine — a streamer is a business entity. `user_id`
      // would be a Supabase Auth account.
      expect(columnsFor(dataset)).not.toContain("user_id");
    }
  });

  it("does not export the structured failure detail column", () => {
    // `error_details_json` is for an operator reading the database. An
    // automation payload is the wrong place for it.
    expect(columnsFor("sync_logs")).not.toContain("error_details_json");
    expect(columnsFor("sync_logs")).toContain("error_message");
  });
});

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

describe("the export envelope", () => {
  const envelope = {
    ok: true as const,
    dataset: "posts" as const,
    contract_version: 2 as const,
    generated_at: "2026-07-30T09:00:00.000Z",
    columns: [...EXPECTED_COLUMNS.posts],
    key_column: "facebook_post_id",
    watermark_column: "updated_at",
    max_watermark: "2026-07-29T18:00:00.000Z",
    filters: {
      updated_after: "2026-07-01T00:00:00.000Z",
      from: null,
      to: null,
      streamer_id: null,
    },
    pagination: {
      limit: 500,
      offset: 0,
      returned: 2,
      total: 2,
      has_more: false,
      next_offset: null,
    },
    rows: [{ post_id: "a" }, { post_id: "b" }],
  };

  it("accepts a well-formed envelope", () => {
    expect(exportEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("carries everything a generic workflow needs to page and checkpoint", () => {
    // One n8n workflow serves all seven datasets by reading these fields.
    for (const field of ["columns", "key_column", "watermark_column", "max_watermark"]) {
      expect(envelope).toHaveProperty(field);
    }
    for (const field of ["has_more", "next_offset", "total", "returned"]) {
      expect(envelope.pagination).toHaveProperty(field);
    }
  });

  it("reports an empty page with a null watermark rather than a fabricated one", () => {
    const empty = {
      ...envelope,
      max_watermark: null,
      pagination: { ...envelope.pagination, returned: 0, total: 0 },
      rows: [],
    };

    expect(exportEnvelopeSchema.safeParse(empty).success).toBe(true);
  });

  it("rejects an unknown dataset name", () => {
    const parsed = exportEnvelopeSchema.safeParse({ ...envelope, dataset: "everything" });
    expect(parsed.success).toBe(false);
  });
});
