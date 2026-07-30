import { describe, expect, it } from "vitest";

import { projectRowToSheet, SHEET_TABS } from "@/lib/google-sheets/sheet-schema";
import { buildSheetSchemaDocument } from "@/lib/google-sheets/sheet-schema";

/**
 * What actually lands in a spreadsheet cell.
 *
 * Two rules the phase specification calls out, and both fail silently when
 * broken — which is why they are asserted rather than reasoned about:
 *
 *   1. A structured value must become JSON, never `[object Object]`.
 *   2. A missing metric must stay distinguishable from a zero.
 *
 * The second is the one that corrupts a report rather than an export. `0` and
 * "Meta declined to report this" are different facts, and a spreadsheet that
 * conflates them produces an average that is quietly wrong.
 */

describe("structured values become JSON", () => {
  it("serialises a reaction breakdown rather than stringifying it", () => {
    const row = projectRowToSheet("post_insights", {
      insight_key: "k",
      value_display: "…",
      // Deliberately an object, which the contract would normally have
      // pre-encoded. The projection must not be the layer that gives up.
      value_json: { like: 62, love: 70, haha: 2 },
    } as never);

    const cell = row["Value (JSON)"] ?? row["Value"] ?? "";

    expect(String(cell)).not.toContain("[object Object]");
  });

  it("serialises an array rather than joining it with commas", () => {
    const projected = projectRowToSheet("comment_summaries", {
      summary_id: "s",
      concerns: ["late deliveries", "audio quality"],
    } as never);

    const cell = String(projected["Concerns"] ?? "");

    expect(cell).not.toContain("[object Object]");
    if (cell.length > 0) expect(() => JSON.parse(cell)).not.toThrow();
  });

  it("never emits [object Object] for any tab, given a structured value everywhere", () => {
    /*
     * The blanket assertion. Feeds an object into every column of every tab and
     * checks nothing anywhere degrades to the default toString.
     */
    for (const tab of SHEET_TABS) {
      const row: Record<string, unknown> = {};
      for (const column of tab.columns) row[column.sourceField] = { nested: [1, 2, 3] };

      const projected = projectRowToSheet(tab.dataset, row);

      for (const [header, value] of Object.entries(projected)) {
        expect(String(value), `${tab.tab} → ${header}`).not.toContain("[object Object]");
      }
    }
  });
});

describe("missing is not zero", () => {
  it("renders null and undefined as an empty cell, never as 0", () => {
    const projected = projectRowToSheet("posts", {
      facebook_post_id: "p1",
      reactions: null,
      comments: undefined,
      shares: 0,
    } as never);

    expect(projected["Reactions"]).toBe("");
    expect(projected["Comments"]).toBe("");
    // A real zero survives as a number, so the two remain distinguishable.
    expect(projected["Shares"]).toBe(0);
  });

  it("keeps a genuine zero as a number rather than text", () => {
    const projected = projectRowToSheet("posts", {
      facebook_post_id: "p1",
      reactions: 0,
    } as never);

    expect(projected["Reactions"]).toBe(0);
    expect(typeof projected["Reactions"]).toBe("number");
  });

  it("passes booleans through unquoted so a sheet can filter on them", () => {
    const projected = projectRowToSheet("streamers", {
      streamer_id: "s1",
      active: false,
    } as never);

    // `false`, not `"false"` — and definitely not "" , which would read as
    // "unknown" rather than "switched off".
    expect(projected["Active"]).toBe(false);
  });
});

describe("the published schema describes what the export actually promises", () => {
  const document = buildSheetSchemaDocument();

  it("marks every column required or optional", () => {
    for (const tab of document.tabs) {
      for (const column of tab.columns) {
        expect(typeof column.required, `${tab.tab} → ${column.header}`).toBe("boolean");
      }
    }
  });

  it("marks an identifier required and a nullable field optional", () => {
    const posts = document.tabs.find((tab) => tab.dataset === "posts");
    const byHeader = new Map(posts?.columns.map((column) => [column.header, column]));

    // The matching column must always carry a value: an upsert keyed on a blank
    // cell appends forever.
    expect(byHeader.get("Post ID")?.required).toBe(true);

    // Meta omits shares on a post with none, so the contract allows null.
    expect(byHeader.get("Shares")?.required).toBe(false);
  });

  it("declares the match column of every tab, and marks it required", () => {
    for (const tab of document.tabs) {
      const match = tab.columns.find((column) => column.is_match_column);

      expect(match, `${tab.tab} has no match column`).toBeDefined();
      expect(match?.header).toBe(tab.match_column);
      expect(match?.required, `${tab.tab} match column must be required`).toBe(true);
    }
  });

  it("carries a description and a type for every column", () => {
    for (const tab of document.tabs) {
      for (const column of tab.columns) {
        expect(column.description.length, `${tab.tab} → ${column.header}`).toBeGreaterThan(0);
        expect(column.type.length).toBeGreaterThan(0);
      }
    }
  });
});
