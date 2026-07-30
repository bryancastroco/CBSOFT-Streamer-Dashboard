import { jsonError, requireApiPermission } from "@/lib/api/admin-guard";
import { EXPORT_ROW_LIMIT } from "@/lib/export/columns";
import { csvFilename, csvHeaders, toCsv, type CsvColumn } from "@/lib/export/csv";
import { parseExportQuery, type ExportQuery } from "@/lib/automation/query";
import { EXPORT_DATASETS, type ExportDataset } from "@/lib/google-sheets/export-contract";
import { projectRowsToSheet, sheetTabFor } from "@/lib/google-sheets/sheet-schema";
import { childLogger } from "@/lib/observability/logger";
import {
  exportCommentSummaries,
  exportPostInsights,
  exportPosts,
  exportStreamers,
  exportSyncLogs,
  exportVideoInsights,
  exportVideos,
  type ExportPage,
} from "@/lib/repositories/automation-exports";
import { recordExportRun } from "@/lib/repositories/export-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/export/sheets/{dataset}
 *
 * The CSV fallback: one spreadsheet tab, as a file, with exactly the headers
 * that tab requires.
 *
 * ## Why this exists
 *
 * n8n is the normal path and it is a single point of failure. When it is down,
 * misconfigured, or waiting on a credential somebody has to rotate, the
 * reporting mirror stops being fed — and the answer cannot be "wait for the
 * automation to be fixed", because the sheet is what the business reads.
 *
 * So an admin can download a tab and paste it in. The headers come from the same
 * `sheet-schema` definitions the automation uses, in the same order, so a pasted
 * file lines up with a sheet the workflow has been writing to. Two paths
 * producing two different layouts would be worse than no fallback at all.
 *
 * ## How it differs from the automation endpoint
 *
 * Authenticated by **session**, not by the n8n bearer secret: this is a person
 * clicking a link in the browser, and it is deliberately not reachable with the
 * automation credential. It accepts the same filters, and it records itself in
 * `export_runs` with `caller: "browser"` so the Settings page can distinguish a
 * hand-pulled file from a scheduled one.
 */

/**
 * Dataset → query.
 *
 * Typed rather than cast: each function returns its own row type, and those are
 * all assignable to `Record<string, unknown>`, so the map holds without an
 * escape hatch. A missing dataset is a compile error, which is what keeps this
 * in step with `EXPORT_DATASETS`.
 */
type SheetQuery = (filters: ExportQuery) => Promise<ExportPage<Record<string, unknown>>>;

const QUERIES: Record<ExportDataset, SheetQuery> = {
  streamers: exportStreamers,
  posts: exportPosts,
  post_insights: exportPostInsights,
  videos: exportVideos,
  video_insights: exportVideoInsights,
  comment_summaries: exportCommentSummaries,
  sync_logs: exportSyncLogs,
};

/** URL segments are hyphenated; dataset names are not. */
function datasetFromSlug(slug: string): ExportDataset | null {
  const candidate = slug.replace(/-/g, "_");
  return (EXPORT_DATASETS as readonly string[]).includes(candidate)
    ? (candidate as ExportDataset)
    : null;
}

export async function GET(request: Request, context: { params: Promise<{ dataset: string }> }) {
  // Any signed-in role may download a report. This is the same data the
  // dashboard already shows them.
  const auth = await requireApiPermission("reports.view");
  if (!auth.ok) return auth.response;

  const { dataset: slug } = await context.params;
  const dataset = datasetFromSlug(slug);

  if (!dataset) {
    return jsonError(404, "unknown_dataset", `There is no "${slug}" export.`);
  }

  const tab = sheetTabFor(dataset);
  if (!tab) {
    return jsonError(404, "unknown_dataset", `There is no sheet tab for "${slug}".`);
  }

  const parsed = parseExportQuery(new URL(request.url));
  if (!parsed.ok) {
    return jsonError(400, "invalid_query", "One or more query parameters are invalid.", {
      issues: parsed.issues,
    });
  }

  const log = childLogger({ component: "export.sheets_csv", dataset });
  const startedAt = Date.now();

  try {
    const page = await QUERIES[dataset]({
      ...parsed.query,
      // A CSV is a whole-file download; the reader is not paging through it.
      limit: EXPORT_ROW_LIMIT,
      offset: 0,
    });

    const projected = projectRowsToSheet(dataset, page.rows);

    /*
     * Columns are built from the tab definition rather than from the rows, so
     * the header row is complete and correctly ordered even when the result is
     * empty — which is exactly when an operator most needs to see the shape.
     */
    const columns: CsvColumn<Record<string, string | number | boolean>>[] = tab.columns.map(
      (column) => ({
        header: column.header,
        value: (row) => row[column.header] ?? null,
      }),
    );

    void recordExportRun({
      dataset,
      format: "csv",
      caller: "browser",
      status: "succeeded",
      rowCount: projected.length,
      totalAvailable: page.total,
      durationMs: Date.now() - startedAt,
    });

    log.info("export.sheets_csv.served", { rows: projected.length, total: page.total });

    return new Response(toCsv(projected, columns), {
      headers: csvHeaders(csvFilename(`cbsoft-${tab.tab}`)),
    });
  } catch (cause) {
    log.error("export.sheets_csv.failed", {
      error: cause instanceof Error ? cause.message : "unknown",
    });

    void recordExportRun({
      dataset,
      format: "csv",
      caller: "browser",
      status: "failed",
      rowCount: 0,
      errorMessage: "The export could not be generated.",
      durationMs: Date.now() - startedAt,
    });

    return jsonError(500, "export_failed", "The export could not be generated.");
  }
}
