import { jsonError, requireApiPermission } from "@/lib/api/admin-guard";
import { ANALYSIS_EXPORT_COLUMNS, EXPORT_ROW_LIMIT } from "@/lib/export/columns";
import { csvFilename, csvHeaders, toCsv } from "@/lib/export/csv";
import { resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { ANALYSIS_SORT_KEYS } from "@/lib/filters/sorting";
import { listCommentAnalyses } from "@/lib/repositories/analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/export/comment-analysis
 *
 * The analysis reading list as CSV, across posts and videos.
 *
 * The exported columns are the analysis: summary, sentiment, and the finding
 * lists. Individual comments are not exported and no commenter field exists to
 * export — the Graph fetch never requests one. A CSV is the easiest artefact in
 * this system to forward outside it, which is exactly why it carries the
 * analysis rather than the source text.
 */
export async function GET(request: Request) {
  const auth = await requireApiPermission("analysis.view");
  if (!auth.ok) return auth.response;

  const raw = Object.fromEntries(new URL(request.url).searchParams) as RawParams;

  const query = resolveBrowseQuery({
    raw,
    sortKeys: ANALYSIS_SORT_KEYS,
    defaultSort: { key: "generatedAt", direction: "desc" },
    limit: EXPORT_ROW_LIMIT,
  });

  try {
    const { items } = await listCommentAnalyses({
      streamerId: query.streamerId,
      search: query.search,
      from: query.period.from,
      to: query.period.to,
      scope: query.scope,
      sort: query.sort,
      limit: EXPORT_ROW_LIMIT,
      offset: 0,
    });

    return new Response(toCsv(items, ANALYSIS_EXPORT_COLUMNS), {
      headers: csvHeaders(csvFilename("cbsoft-comment-analysis")),
    });
  } catch {
    return jsonError(500, "export_failed", "The export could not be generated.");
  }
}
