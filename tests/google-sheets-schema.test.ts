import { describe, expect, it } from "vitest";

import {
  buildInsightKey,
  columnsFor,
  EXPORT_DATASETS,
  EXPORT_DEFINITIONS,
} from "@/lib/google-sheets/export-contract";
import {
  BRANCH_LETTERS,
  SHEET_TABS,
  branchLetterFor,
  buildSheetSchemaDocument,
  projectRowToSheet,
  projectRowsToSheet,
  sheetHeadersFor,
  sheetTabFor,
} from "@/lib/google-sheets/sheet-schema";

/**
 * The seven tabs, exactly as the specification lists them.
 *
 * Duplicated from `sheet-schema.ts` on purpose. These headers are the header row
 * of a live spreadsheet and the field names in somebody's n8n expressions —
 * renaming one silently breaks a sheet this repository cannot see. Requiring two
 * deliberate edits is the point.
 */
const EXPECTED_TABS: { tab: string; match: string; columns: string[] }[] = [
  {
    tab: "Streamers",
    match: "Streamer ID",
    columns: [
      "Streamer ID",
      "Streamer Code",
      "Streamer Name",
      "Page ID",
      "Page Name",
      "Token Status",
      "Active",
      "Last Successful Sync",
      "Last Sync Error",
      "Updated At",
    ],
  },
  {
    tab: "Facebook Posts",
    match: "Post ID",
    columns: [
      "Post ID",
      "Streamer ID",
      "Streamer Name",
      "Page ID",
      "Message",
      "Created Time",
      "Reactions",
      "Comments",
      "Shares",
      "Permalink",
      "Last Synced At",
    ],
  },
  {
    tab: "Post Insights",
    match: "Insight Key",
    columns: [
      "Insight Key",
      "Post ID",
      "Streamer ID",
      "Metric Name",
      "Period",
      "Value",
      "End Time",
      "Collected At",
    ],
  },
  {
    tab: "Facebook Videos",
    match: "Video ID",
    columns: [
      "Video ID",
      "Streamer ID",
      "Streamer Name",
      "Page ID",
      "Title",
      "Description",
      "Length Seconds",
      "Created Time",
      "Permalink",
      "Last Synced At",
    ],
  },
  {
    tab: "Video Insights",
    match: "Insight Key",
    columns: [
      "Insight Key",
      "Video ID",
      "Streamer ID",
      "Metric Name",
      "Period",
      "Value",
      "End Time",
      "Collected At",
    ],
  },
  {
    tab: "Comment Summaries",
    match: "Summary ID",
    columns: [
      "Summary ID",
      "Content Type",
      "Content ID",
      "Streamer ID",
      "Streamer Name",
      "Content Title",
      "Comment Count",
      "Sentiment",
      "Summary",
      "Positive Points",
      "Concerns",
      "Suggestions",
      "Questions",
      "Urgent Issues",
      "Generated At",
    ],
  },
  {
    tab: "Sync Logs",
    match: "Sync Run ID",
    columns: [
      "Sync Run ID",
      "Streamer ID",
      "Sync Type",
      "Status",
      "Posts Processed",
      "Videos Processed",
      "Comments Processed",
      "Summaries Generated",
      "Started At",
      "Completed At",
      "Error Message",
    ],
  },
];

describe("the seven tabs", () => {
  it("declares exactly the tabs the specification names, in order", () => {
    expect(SHEET_TABS.map((tab) => tab.tab)).toEqual(EXPECTED_TABS.map((tab) => tab.tab));
  });

  it.each(EXPECTED_TABS)("$tab has exactly its specified columns, in order", (expected) => {
    const tab = SHEET_TABS.find((candidate) => candidate.tab === expected.tab);

    expect(tab).toBeDefined();
    expect(tab?.columns.map((column) => column.header)).toEqual(expected.columns);
  });

  it.each(EXPECTED_TABS)("$tab matches on $match", (expected) => {
    const tab = SHEET_TABS.find((candidate) => candidate.tab === expected.tab);
    expect(tab?.matchColumn).toBe(expected.match);
  });

  it("covers every export dataset exactly once", () => {
    const datasets = SHEET_TABS.map((tab) => tab.dataset);

    expect(new Set(datasets).size).toBe(datasets.length);
    expect([...datasets].sort()).toEqual([...EXPORT_DATASETS].sort());
  });

  it("assigns one branch letter per tab, A through G", () => {
    expect(SHEET_TABS).toHaveLength(BRANCH_LETTERS.length);
    expect(SHEET_TABS.map((tab) => branchLetterFor(tab.dataset))).toEqual([...BRANCH_LETTERS]);
  });
});

describe("tabs are projections of the export contract", () => {
  it.each(SHEET_TABS)("$tab only names fields the export publishes", (tab) => {
    // A tab cannot invent data. Every column has to come from a field the API
    // contract already declares — which is what makes it impossible for the
    // spreadsheet to carry something the export review never saw.
    const published = new Set(columnsFor(tab.dataset));

    for (const column of tab.columns) {
      expect(published, `${tab.tab}."${column.header}" → ${column.sourceField}`).toContain(
        column.sourceField,
      );
    }
  });

  it.each(SHEET_TABS)("$tab has a matching column that exists on the tab", (tab) => {
    // n8n's "Column to Match On" must name a real header, or every
    // Append-or-Update quietly becomes an Append.
    expect(tab.columns.map((column) => column.header)).toContain(tab.matchColumn);
  });

  it.each(SHEET_TABS)("$tab has unique, non-empty headers", (tab) => {
    const headers = tab.columns.map((column) => column.header);

    expect(headers.every((header) => header.trim().length > 0)).toBe(true);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it.each(SHEET_TABS)("$tab describes every column", (tab) => {
    for (const column of tab.columns) {
      expect(column.description.length, `${tab.tab}."${column.header}"`).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule that matters most
// ---------------------------------------------------------------------------

const FORBIDDEN_HEADER_FRAGMENTS = [
  "access token",
  "page token",
  "encrypted",
  "ciphertext",
  "last four",
  "masked",
  "secret",
  "credential",
  "password",
  "bearer",
  "commenter",
  "author",
];

describe("no tab can carry a Page token", () => {
  it.each(SHEET_TABS)("$tab has no credential-shaped header", (tab) => {
    for (const column of tab.columns) {
      const header = column.header.toLowerCase();
      for (const fragment of FORBIDDEN_HEADER_FRAGMENTS) {
        expect(header, `"${column.header}" on ${tab.tab}`).not.toContain(fragment);
      }
    }
  });

  it("shows token health on the Streamers tab, and nothing more", () => {
    const streamers = sheetTabFor("streamers");
    const headers = streamers?.columns.map((column) => column.header) ?? [];

    // A health enum is what lets a workflow alert on a Page needing reauth.
    expect(headers).toContain("Token Status");
    // The credential itself, in any of its three stored forms, is absent.
    expect(headers).not.toContain("Token");
    expect(headers).not.toContain("Page Access Token");
    expect(headers).not.toContain("Token Last Four");
  });

  it("carries no Google credential field anywhere in the schema document", () => {
    // n8n owns it. There is nothing here to describe.
    const serialised = JSON.stringify(buildSheetSchemaDocument()).toLowerCase();

    expect(serialised).not.toContain("service_account");
    expect(serialised).not.toContain("private_key");
    expect(serialised).not.toContain("client_email");
    expect(serialised).toContain("n8n");
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe("projecting a row onto its tab", () => {
  const postRow = {
    post_id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
    streamer_id: "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
    streamer_code: "CBS-014",
    streamer_name: "Sample Streamer",
    facebook_page_id: "102938475610293",
    facebook_post_id: "102938475610293_8801",
    message: "Ranked grind tonight",
    created_time: "2026-07-29T18:04:00.000Z",
    permalink_url: "https://facebook.com/102938475610293/posts/8801",
    reactions: 412,
    comments: 63,
    shares: null,
    insight_metric_count: 7,
    last_synced_at: "2026-07-30T03:02:19.884Z",
    updated_at: "2026-07-30T03:02:19.884Z",
  };

  it("re-keys the row to the tab's headers", () => {
    const projected = projectRowToSheet("posts", postRow);

    expect(Object.keys(projected)).toEqual([...sheetHeadersFor("posts")]);
    expect(projected["Post ID"]).toBe("102938475610293_8801");
    expect(projected["Streamer Name"]).toBe("Sample Streamer");
  });

  it("renders an unreported figure as an empty cell, never as zero", () => {
    // The distinction the whole system preserves. A sheet formula summing a
    // column must not be handed a fabricated 0.
    const projected = projectRowToSheet("posts", postRow);

    expect(projected["Shares"]).toBe("");
    expect(projected["Shares"]).not.toBe(0);
    expect(projected["Reactions"]).toBe(412);
  });

  it("keeps a reported zero as a number", () => {
    const projected = projectRowToSheet("posts", { ...postRow, reactions: 0 });
    expect(projected["Reactions"]).toBe(0);
  });

  it("passes numbers and booleans through so the sheet holds real values", () => {
    const projected = projectRowToSheet("streamers", {
      streamer_id: "a",
      streamer_code: "b",
      streamer_name: "c",
      facebook_page_id: "d",
      facebook_page_name: "e",
      active: true,
      token_status: "valid",
      token_expires_at: null,
      last_successful_sync_at: null,
      last_sync_error: null,
      created_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:00.000Z",
    });

    expect(projected["Active"]).toBe(true);
    expect(projected["Last Successful Sync"]).toBe("");
  });

  it("drops fields the tab does not include", () => {
    // `insight_metric_count` and `updated_at` are published by the API but are
    // not on the Posts tab. A projection is a subset, not a rename-everything.
    const projected = projectRowToSheet("posts", postRow);

    expect(projected).not.toHaveProperty("insight_metric_count");
    expect(projected).not.toHaveProperty("Updated At");
  });

  it("cannot invent a column from a field that is not there", () => {
    const projected = projectRowToSheet("posts", {});

    // Every header is still present — an empty row is blank, not absent, or the
    // CSV header and the data would disagree.
    expect(Object.keys(projected)).toEqual([...sheetHeadersFor("posts")]);
    expect(Object.values(projected).every((value) => value === "")).toBe(true);
  });

  it("projects a list of rows in order", () => {
    const rows = projectRowsToSheet("posts", [postRow, { ...postRow, reactions: 1 }]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.["Reactions"]).toBe(412);
    expect(rows[1]?.["Reactions"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Composite keys
// ---------------------------------------------------------------------------

describe("the insight composite key", () => {
  const base = {
    facebookContentId: "102938475610293_8801",
    metricName: "post_impressions",
    period: "lifetime",
    endTime: "2026-07-29T00:00:00.000Z",
  };

  it("is deterministic", () => {
    expect(buildInsightKey(base)).toBe(buildInsightKey({ ...base }));
  });

  it("mirrors the database's uniqueness rule", () => {
    // `(content, metric, coalesce(period,''), coalesce(end_time,'epoch'))`.
    // Two metrics differing in any one part must key differently, or a Sheets
    // upsert would collapse rows the database keeps apart.
    const keys = new Set([
      buildInsightKey(base),
      buildInsightKey({ ...base, metricName: "post_reach" }),
      buildInsightKey({ ...base, period: "day" }),
      buildInsightKey({ ...base, endTime: "2026-07-30T00:00:00.000Z" }),
      buildInsightKey({ ...base, facebookContentId: "102938475610293_8802" }),
    ]);

    expect(keys.size).toBe(5);
  });

  it("treats an absent period and an absent end time as empty, matching coalesce", () => {
    expect(buildInsightKey({ ...base, period: null, endTime: null })).toBe(
      "102938475610293_8801::post_impressions::::",
    );
  });

  it("distinguishes a null period from an empty-string period only if Meta ever sends one", () => {
    // Both coalesce to '' in the database, so they must collide here too —
    // keying them apart would put two sheet rows where the database has one.
    expect(buildInsightKey({ ...base, period: null })).toBe(
      buildInsightKey({ ...base, period: "" }),
    );
  });

  it("is what both insight tabs match on", () => {
    expect(EXPORT_DEFINITIONS.post_insights.keyColumn).toBe("insight_key");
    expect(EXPORT_DEFINITIONS.video_insights.keyColumn).toBe("insight_key");
    expect(sheetTabFor("post_insights")?.matchColumn).toBe("Insight Key");
    expect(sheetTabFor("video_insights")?.matchColumn).toBe("Insight Key");
  });
});

// ---------------------------------------------------------------------------
// The schema document
// ---------------------------------------------------------------------------

describe("the schema endpoint document", () => {
  const document = buildSheetSchemaDocument();

  it("returns everything the specification asks for", () => {
    for (const tab of document.tabs) {
      expect(tab.tab).toBeTruthy();
      expect(tab.required_columns.length).toBeGreaterThan(0);
      expect(tab.match_column).toBeTruthy();
      expect(tab.columns.every((column) => column.type.length > 0)).toBe(true);
    }
  });

  it("describes all seven tabs with their branch letters", () => {
    expect(document.tabs).toHaveLength(7);
    expect(document.tabs.map((tab) => tab.branch)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("flags exactly one match column per tab", () => {
    for (const tab of document.tabs) {
      const flagged = tab.columns.filter((column) => column.is_match_column);

      expect(flagged, tab.tab).toHaveLength(1);
      expect(flagged[0]?.header).toBe(tab.match_column);
    }
  });

  it("points at endpoints that exist", () => {
    for (const tab of document.tabs) {
      expect(tab.export_endpoint).toMatch(/^\/api\/automation\/exports\/[a-z-]+$/);
      expect(tab.sheets_format_endpoint).toContain("format=sheets");
      expect(tab.csv_fallback_endpoint).toMatch(/^\/api\/export\/sheets\/[a-z-]+$/);
      // Hyphenated in the URL, underscored as a dataset name.
      expect(tab.export_endpoint).toContain(tab.dataset.replace(/_/g, "-"));
    }
  });

  it("states that the sheet is written and never read", () => {
    expect(document.spreadsheet.direction).toBe("write-only mirror");
    expect(document.spreadsheet.owner_of_google_credential).toBe("n8n");
  });

  it("warns against a plain Append", () => {
    // The failure mode is invisible for a week and then obvious: a duplicate of
    // every row, every night.
    expect(document.notes.join(" ")).toMatch(/Append or Update/i);
  });
});
