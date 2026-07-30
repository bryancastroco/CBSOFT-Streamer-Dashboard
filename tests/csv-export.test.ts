import { describe, expect, it } from "vitest";

import { NO_SIGNIFICANT_FINDINGS } from "@/lib/ai/contract";
import {
  ANALYSIS_EXPORT_COLUMNS,
  EXPORT_ROW_LIMIT,
  POST_EXPORT_COLUMNS,
  VIDEO_EXPORT_COLUMNS,
} from "@/lib/export/columns";
import { csvField, csvFilename, csvHeaders, toCsv, type CsvColumn } from "@/lib/export/csv";

describe("csv field escaping", () => {
  it("leaves a plain value alone", () => {
    expect(csvField("Friday night ranked")).toBe("Friday night ranked");
    expect(csvField(12345)).toBe("12345");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("chat was loud, but positive")).toBe('"chat was loud, but positive"');
  });

  it("doubles inner quotes", () => {
    expect(csvField('he said "gg"')).toBe('"he said ""gg"""');
  });

  it("quotes a value containing a newline, so it cannot break the row", () => {
    // A comment with a line break would otherwise shift every following row.
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("writes an absent value as blank, never as zero", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    // The distinction the whole application preserves: a reported zero is data.
    expect(csvField(0)).toBe("0");
  });

  it("writes dates as ISO 8601 in UTC", () => {
    expect(csvField(new Date("2026-07-15T13:47:11.000Z"))).toBe("2026-07-15T13:47:11.000Z");
  });

  it("blanks an invalid date and a non-finite number rather than writing NaN", () => {
    expect(csvField(new Date("nonsense"))).toBe("");
    expect(csvField(Number.NaN)).toBe("");
    expect(csvField(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formula injection", () => {
  // Comment text is third-party input, and a spreadsheet executes a cell that
  // begins with any of these. Every one must be neutralised.
  it.each(["=", "+", "-", "@", "\t", "\r"])("neutralises a cell beginning %j", (prefix) => {
    const field = csvField(`${prefix}HYPERLINK("http://evil.test")`);

    expect(field.startsWith("'") || field.startsWith(`"'`)).toBe(true);
    expect(field).not.toMatch(/^=/);
    expect(field).not.toMatch(/^\+/);
    expect(field).not.toMatch(/^-/);
    expect(field).not.toMatch(/^@/);
  });

  it("neutralises the classic command-execution payload", () => {
    const field = csvField('=cmd|" /C calc"!A0');
    expect(field.startsWith(`"'`) || field.startsWith("'")).toBe(true);
  });

  it("keeps the guard inside the quotes when the value also needs quoting", () => {
    // `'` outside the quotes would itself be data in the previous column.
    expect(csvField("=SUM(A1,A2)")).toBe(`"'=SUM(A1,A2)"`);
  });

  it("does not mangle an ordinary value that merely contains those characters", () => {
    expect(csvField("2+2 was the score")).toBe("2+2 was the score");
    expect(csvField("first-half")).toBe("first-half");
  });
});

describe("csv documents", () => {
  type Row = { name: string; count: number | null };
  const columns: readonly CsvColumn<Row>[] = [
    { header: "Name", value: (row) => row.name },
    { header: "Count", value: (row) => row.count },
  ];

  it("writes a header row and one row per record", () => {
    const csv = toCsv(
      [
        { name: "a", count: 1 },
        { name: "b", count: null },
      ],
      columns,
    );
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");

    expect(lines).toEqual(["Name,Count", "a,1", "b,"]);
  });

  it("emits a UTF-8 BOM and CRLF endings, for Excel on Windows", () => {
    const csv = toCsv([{ name: "café", count: 1 }], columns);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("\r\n");
  });

  it("writes only a header row for an empty result", () => {
    expect(toCsv([], columns).replace(/^﻿/, "")).toBe("Name,Count\r\n");
  });

  it("keeps column order stable regardless of row key order", () => {
    const reversed = toCsv([{ count: 5, name: "z" } as Row], columns);
    expect(reversed).toContain("z,5");
  });
});

describe("filenames and headers", () => {
  it("slugs the base name and stamps the UTC date", () => {
    expect(csvFilename("CBSOFT Posts", new Date("2026-07-15T23:59:00Z"))).toBe(
      "cbsoft-posts-2026-07-15.csv",
    );
  });

  it("never produces an empty name", () => {
    expect(csvFilename("!!!", new Date("2026-07-15T00:00:00Z"))).toBe("export-2026-07-15.csv");
  });

  it("sends an attachment that is not cached", () => {
    const headers = csvHeaders("cbsoft-posts-2026-07-15.csv");

    expect(headers["Content-Type"]).toContain("text/csv");
    expect(headers["Content-Disposition"]).toBe(
      'attachment; filename="cbsoft-posts-2026-07-15.csv"',
    );
    // An export is a snapshot; a cached copy would be handed to the next click.
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// The rule that matters most
// ---------------------------------------------------------------------------

/**
 * Substrings that must never appear in an export header.
 *
 * A CSV is the easiest artefact in this system to forward to someone outside it,
 * so it gets the narrowest column set. This asserts the rule from the outside:
 * if someone adds a token column to `lib/export/columns`, this fails.
 */
const TOKEN_FORBIDDEN = [
  "token",
  "secret",
  "credential",
  "password",
  "encrypted",
  "cipher",
  "authorization",
  "bearer",
];

const ALL_COLUMN_SETS = [
  ["posts", POST_EXPORT_COLUMNS] as const,
  ["videos", VIDEO_EXPORT_COLUMNS] as const,
  ["comment analysis", ANALYSIS_EXPORT_COLUMNS] as const,
];

describe("export columns never expose a token", () => {
  it.each(ALL_COLUMN_SETS)("the %s export has no token-shaped header", (_name, columns) => {
    for (const column of columns) {
      const header = column.header.toLowerCase();
      for (const forbidden of TOKEN_FORBIDDEN) {
        expect(header, `"${column.header}" looks like credential material`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it.each(ALL_COLUMN_SETS)("the %s export declares unique, non-empty headers", (_name, columns) => {
    const headers = columns.map((column) => column.header);

    expect(headers.every((header) => header.trim().length > 0)).toBe(true);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it("exports the streamer's identity and nothing else about them", () => {
    // Deliberately narrow: a code and a name are public facts. Token health,
    // the four-character suffix and the masked form are all absent.
    const streamerHeaders = POST_EXPORT_COLUMNS.map((column) => column.header).filter((header) =>
      header.toLowerCase().includes("streamer"),
    );

    expect(streamerHeaders).toEqual(["Streamer code", "Streamer name"]);
  });

  it("exports no commenter field, because none is ever collected", () => {
    for (const [, columns] of ALL_COLUMN_SETS) {
      for (const column of columns) {
        const header = column.header.toLowerCase();
        expect(header).not.toContain("commenter");
        expect(header).not.toContain("author");
        expect(header).not.toMatch(/\bfrom\b/);
      }
    }
  });
});

describe("analysis export shaping", () => {
  const row = {
    summaryId: "s1",
    contentType: "video" as const,
    contentId: "v1",
    contentTitle: "Friday night ranked",
    permalinkUrl: "https://facebook.com/watch/?v=1",
    contentCreatedAt: new Date("2026-07-14T18:00:00Z"),
    streamerId: "st1",
    streamerCode: "CBS-014",
    streamerName: "Sample Streamer",
    commentCount: 42,
    sentiment: "mixed",
    summary: "Chat enjoyed the gameplay but the audio dropped twice.",
    status: "completed",
    positivePoints: ["Great plays"],
    concerns: ["Audio dropped"],
    suggestions: [NO_SIGNIFICANT_FINDINGS],
    questions: [],
    urgentIssues: ["Stream key may be leaked"],
    urgentCount: 1,
    generatedAt: new Date("2026-07-15T09:00:00Z"),
  };

  const csv = toCsv([row], ANALYSIS_EXPORT_COLUMNS);
  const header = csv.replace(/^﻿/, "").split("\r\n")[0] ?? "";
  const body = csv.replace(/^﻿/, "").split("\r\n")[1] ?? "";

  it("includes every field the specification lists", () => {
    for (const expected of [
      "Streamer",
      "Content type",
      "Content title",
      "Comments analysed",
      "Sentiment",
      "Summary",
      "Concerns",
      "Suggestions",
      "Questions",
      "Urgent issues",
      "Generated",
    ]) {
      expect(header).toContain(expected);
    }
  });

  it("writes the placeholder-only list as blank rather than as a finding", () => {
    // "No significant findings" is the model's way of saying *nothing here*.
    // Exporting it as text would turn absence into a row of content.
    expect(body).not.toContain(NO_SIGNIFICANT_FINDINGS);
    expect(body).toContain("Audio dropped");
  });

  it("joins multiple findings with a pipe, not a comma", () => {
    const many = toCsv(
      [{ ...row, concerns: ["Audio dropped", "Lag spikes"] }],
      ANALYSIS_EXPORT_COLUMNS,
    );

    expect(many).toContain("Audio dropped | Lag spikes");
  });
});

describe("export bounds", () => {
  it("caps a download at a size one request can hold", () => {
    expect(EXPORT_ROW_LIMIT).toBeGreaterThan(0);
    expect(EXPORT_ROW_LIMIT).toBeLessThanOrEqual(10_000);
  });
});
