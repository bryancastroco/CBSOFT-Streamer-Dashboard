import { jsonError, requireApiPermission } from "@/lib/api/admin-guard";
import { EXPORT_ROW_LIMIT, POST_EXPORT_COLUMNS } from "@/lib/export/columns";
import { csvFilename, csvHeaders, toCsv } from "@/lib/export/csv";
import { resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { POST_SORT_KEYS } from "@/lib/filters/sorting";
import { listPosts } from "@/lib/repositories/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/export/posts
 *
 * The posts table as CSV. Filters, search and sort arrive as the same query
 * string the screen was rendered from and are resolved by the same
 * `resolveBrowseQuery`, so the file cannot describe a different set of rows
 * than the table it was downloaded from.
 *
 * Authorised on `posts.view`, not on a role: this is the same data a viewer can
 * already read on screen. The column list in `lib/export/columns` is explicit
 * and contains nothing about Page tokens.
 */
export async function GET(request: Request) {
  const auth = await requireApiPermission("posts.view");
  if (!auth.ok) return auth.response;

  const raw = Object.fromEntries(new URL(request.url).searchParams) as RawParams;

  const query = resolveBrowseQuery({
    raw,
    sortKeys: POST_SORT_KEYS,
    defaultSort: { key: "createdTime", direction: "desc" },
    limit: EXPORT_ROW_LIMIT,
  });

  try {
    const { items } = await listPosts({
      streamerId: query.streamerId,
      gameId: query.gameId,
      search: query.search,
      from: query.period.from,
      to: query.period.to,
      sort: query.sort,
      limit: EXPORT_ROW_LIMIT,
      // An export is the whole filtered set, not the page the reader happened
      // to be on when they clicked.
      offset: 0,
    });

    return new Response(toCsv(items, POST_EXPORT_COLUMNS), {
      headers: csvHeaders(csvFilename("cbsoft-posts")),
    });
  } catch {
    return jsonError(500, "export_failed", "The export could not be generated.");
  }
}
