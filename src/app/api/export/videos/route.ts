import { jsonError, requireApiPermission } from "@/lib/api/admin-guard";
import { EXPORT_ROW_LIMIT, VIDEO_EXPORT_COLUMNS } from "@/lib/export/columns";
import { csvFilename, csvHeaders, toCsv } from "@/lib/export/csv";
import { resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { VIDEO_SORT_KEYS } from "@/lib/filters/sorting";
import { listVideos } from "@/lib/repositories/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/export/videos
 *
 * See `../posts/route.ts` — same contract, same guarantees, video columns.
 */
export async function GET(request: Request) {
  const auth = await requireApiPermission("videos.view");
  if (!auth.ok) return auth.response;

  const raw = Object.fromEntries(new URL(request.url).searchParams) as RawParams;

  const query = resolveBrowseQuery({
    raw,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: { key: "createdTime", direction: "desc" },
    limit: EXPORT_ROW_LIMIT,
  });

  try {
    const { items } = await listVideos({
      streamerId: query.streamerId,
      gameId: query.gameId,
      search: query.search,
      from: query.period.from,
      to: query.period.to,
      /*
       * Supplied by the Livestreams screen, which fixes its scope by route
       * rather than by filter. Without it a CSV downloaded from that page would
       * hold every video — a file disagreeing with the table it came from.
       */
      scope: query.scope,
      sort: query.sort,
      limit: EXPORT_ROW_LIMIT,
      offset: 0,
    });

    return new Response(toCsv(items, VIDEO_EXPORT_COLUMNS), {
      headers: csvHeaders(csvFilename("cbsoft-videos")),
    });
  } catch {
    return jsonError(500, "export_failed", "The export could not be generated.");
  }
}
