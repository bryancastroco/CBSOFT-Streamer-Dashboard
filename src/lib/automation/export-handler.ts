import "server-only";

import { automationError, guardAutomationRequest } from "@/lib/automation/guard";
import { describeFilters, parseExportQuery, type ExportQuery } from "@/lib/automation/query";
import { childLogger } from "@/lib/observability/logger";
import {
  columnsFor,
  EXPORT_DEFINITIONS,
  type ExportDataset,
} from "@/lib/google-sheets/export-contract";
import { projectRowsToSheet, sheetHeadersFor, sheetTabFor } from "@/lib/google-sheets/sheet-schema";
import type { ExportPage } from "@/lib/repositories/automation-exports";
import { recordExportRun } from "@/lib/repositories/export-runs";

/**
 * The one handler behind all seven export endpoints.
 *
 * Written once rather than seven times so that the guard, the query contract,
 * the envelope shape and the outbound validation cannot drift between datasets.
 * Each route supplies only its dataset name and its query function; everything a
 * caller can observe is decided here.
 */

/**
 * Validate rows against the published schema before sending them.
 *
 * This is not defensive typing — TypeScript already agrees the row builder
 * matches. It catches the case types cannot: a value that is the right *type*
 * but the wrong *shape* at runtime, such as a `timestamptz` that arrived as a
 * string, or a `jsonb` column holding something a past version wrote. Google
 * Sheets is upsert-oriented; a row whose columns shift mid-run corrupts the
 * destination sheet, and a `500` is far cheaper to recover from than a
 * half-corrupted spreadsheet nobody notices for a week.
 */
function validateRows(
  dataset: ExportDataset,
  rows: readonly unknown[],
): { ok: true } | { ok: false; detail: string } {
  const { schema } = EXPORT_DEFINITIONS[dataset];

  for (const [index, row] of rows.entries()) {
    const parsed = schema.safeParse(row);
    if (parsed.success) continue;

    const first = parsed.error.issues[0];
    return {
      ok: false,
      detail: `Row ${index} failed the ${dataset} contract at ${
        first?.path.join(".") || "(root)"
      }: ${first?.message ?? "unknown"}`,
    };
  }

  return { ok: true };
}

/**
 * The two shapes a caller can ask for.
 *
 * `json` is the API: snake_case fields, every published column.
 * `sheets` is the spreadsheet projection: rows re-keyed to the tab's headers,
 * in tab order, so n8n's Google Sheets node can map automatically with no
 * transform node in between. Seven branches each needing a hand-maintained Set
 * node is seven places for a column to be quietly dropped.
 *
 * `sheets` is strictly a **subset** of `json` — it can only read fields the
 * contract already publishes — so it cannot widen what leaves the server.
 */
function parseFormat(url: URL): "json" | "sheets" | null {
  const raw = url.searchParams.get("format");
  if (raw === null || raw === "json") return "json";
  if (raw === "sheets") return "sheets";
  return null;
}

export async function handleExportRequest<T extends Record<string, unknown>>(
  request: Request,
  dataset: ExportDataset,
  query: (filters: ExportQuery) => Promise<ExportPage<T>>,
): Promise<Response> {
  const guard = guardAutomationRequest(request, "read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const format = parseFormat(url);

  if (format === null) {
    return automationError(
      400,
      "invalid_query",
      "One or more query parameters are invalid.",
      { issues: [{ field: "format", message: 'format must be "json" or "sheets".' }] },
      guard.headers,
    );
  }

  const parsed = parseExportQuery(url);

  if (!parsed.ok) {
    // Machine callers get told exactly what was wrong. Unlike the browser
    // filters, a scheduled workflow silently receiving the wrong window would
    // write wrong rows into a spreadsheet every night.
    void recordExportRun({
      dataset,
      format,
      caller: "n8n",
      status: "failed",
      rowCount: 0,
      errorMessage: `Invalid query: ${parsed.issues.map((issue) => issue.field).join(", ")}`,
    });

    return automationError(
      400,
      "invalid_query",
      "One or more query parameters are invalid.",
      { issues: parsed.issues },
      guard.headers,
    );
  }

  const log = childLogger({ component: "automation.export", dataset, format });
  const startedAt = Date.now();

  try {
    const page = await query(parsed.query);
    const rows = page.rows as unknown as Record<string, unknown>[];

    const validation = validateRows(dataset, rows);
    if (!validation.ok) {
      log.error("automation.export.contract_violation", { detail: validation.detail });

      void recordExportRun({
        dataset,
        format,
        caller: "n8n",
        status: "failed",
        rowCount: 0,
        errorMessage: "A row did not match the published contract.",
        durationMs: Date.now() - startedAt,
      });

      return automationError(
        500,
        "contract_violation",
        "The export could not be produced because a row did not match the published contract.",
        undefined,
        guard.headers,
      );
    }

    const returned = rows.length;
    const hasMore = parsed.query.offset + returned < page.total;
    const tab = sheetTabFor(dataset);

    log.info("automation.export.served", {
      returned,
      total: page.total,
      offset: parsed.query.offset,
    });

    void recordExportRun({
      dataset,
      format,
      caller: "n8n",
      status: "succeeded",
      rowCount: returned,
      totalAvailable: page.total,
      filters: describeFilters(parsed.query),
      durationMs: Date.now() - startedAt,
    });

    return Response.json(
      {
        ok: true,
        dataset,
        contract_version: 2,
        format,
        generated_at: new Date().toISOString(),
        // In `sheets` format these are the tab's headers, in tab order — which
        // is what the header row of the spreadsheet must contain.
        columns: format === "sheets" ? sheetHeadersFor(dataset) : columnsFor(dataset),
        key_column:
          format === "sheets"
            ? (tab?.matchColumn ?? EXPORT_DEFINITIONS[dataset].keyColumn)
            : EXPORT_DEFINITIONS[dataset].keyColumn,
        /** Present in `sheets` format so a branch can name its destination. */
        ...(format === "sheets" ? { sheet_tab: tab?.tab ?? null } : {}),
        watermark_column: EXPORT_DEFINITIONS[dataset].watermarkColumn,
        /*
         * Comes from Postgres at microsecond precision, and covers the whole
         * filtered set rather than this page.
         *
         * Deriving it from the rows would be wrong twice over: the row strings
         * are millisecond-precision, so feeding one back re-delivers the
         * boundary rows on every run — and since a bulk upsert stamps every row
         * it writes with one transaction timestamp, that means re-delivering the
         * entire previous batch.
         */
        max_watermark: page.maxWatermark,
        filters: describeFilters(parsed.query),
        pagination: {
          limit: parsed.query.limit,
          offset: parsed.query.offset,
          returned,
          total: page.total,
          has_more: hasMore,
          next_offset: hasMore ? parsed.query.offset + returned : null,
        },
        rows: format === "sheets" ? projectRowsToSheet(dataset, rows) : rows,
      },
      { headers: { "cache-control": "no-store", ...guard.headers } },
    );
  } catch (cause) {
    // The message is logged, not returned: a database error can carry a
    // connection string, and this response goes into an n8n execution log.
    log.error("automation.export.failed", {
      error: cause instanceof Error ? cause.message : "unknown",
    });

    void recordExportRun({
      dataset,
      format,
      caller: "n8n",
      status: "failed",
      rowCount: 0,
      errorMessage: "The export could not be generated.",
      durationMs: Date.now() - startedAt,
    });

    return automationError(
      500,
      "export_failed",
      "The export could not be generated.",
      undefined,
      guard.headers,
    );
  }
}
