/**
 * CSV serialisation — a PURE module.
 *
 * Two things this file exists to get right, both of which are easy to get wrong
 * with a naive `rows.map(r => r.join(","))`:
 *
 * 1. **RFC 4180 quoting.** A comment containing a comma, a quote or a newline
 *    must not shift every subsequent column by one. Fields are quoted and inner
 *    quotes doubled.
 *
 * 2. **Formula injection.** A cell beginning `=`, `+`, `-`, `@`, tab or CR is
 *    executed as a formula when the file is opened in Excel, Numbers or Google
 *    Sheets. Since these exports contain third-party comment text, a commenter
 *    could otherwise plant `=HYPERLINK(...)` in a comment and have it run on a
 *    manager's machine. Such cells are prefixed with a single quote, which the
 *    spreadsheet strips on display but will not evaluate.
 *
 * Note that this is a *download* path, not the Google Sheets export path. Rows
 * that leave the system toward Sheets or n8n go through the Zod contract in
 * `lib/google-sheets/export-contract.ts` first. This module never sees a token
 * because no column definition anywhere selects one.
 */

/** One output column: a header and how to read it off a row. */
export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | boolean | Date | null | undefined;
};

const RISKY_LEADING = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Render one value as a CSV field.
 *
 * `null` and `undefined` become empty — deliberately not `"0"` or `"null"`.
 * A blank cell reads as "not reported", which is the same distinction the UI
 * makes with "Metric not available from Meta".
 */
export function csvField(value: string | number | boolean | Date | null | undefined): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (value instanceof Date) {
    text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else if (typeof value === "number") {
    text = Number.isFinite(value) ? String(value) : "";
  } else {
    text = value;
  }

  if (text.length === 0) return "";

  // Neutralise before quoting, so the guard character ends up inside the quotes.
  const firstChar = text.charAt(0);
  const neutralised = RISKY_LEADING.has(firstChar) ? `'${text}` : text;

  const needsQuoting = /[",\r\n]/.test(neutralised);
  if (!needsQuoting) return neutralised;

  return `"${neutralised.replace(/"/g, '""')}"`;
}

/**
 * Serialise rows to a CSV document.
 *
 * CRLF line endings and a UTF-8 BOM, because the most common destination is
 * Excel on Windows: without the BOM it misreads accented characters, and
 * without CRLF it can run rows together.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [columns.map((column) => csvField(column.header)).join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value(row))).join(","));
  }

  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * A filename-safe slug plus a UTC date stamp.
 *
 * Two exports taken on different days should not overwrite each other in the
 * downloads folder.
 */
export function csvFilename(base: string, now: Date = new Date()): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";

  return `${slug}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Headers for a CSV download response. */
export function csvHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    // The quoted form is what makes a filename with a space survive; these are
    // slugged, but quoting costs nothing and removes the edge case.
    "Content-Disposition": `attachment; filename="${filename}"`,
    // An export is a snapshot of a moment. Caching it would hand a stale file
    // to the next person who clicked the same link.
    "Cache-Control": "no-store",
  };
}
