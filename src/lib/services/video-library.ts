import "server-only";

import { resolveBrowseQuery, type BrowseQuery, type RawParams } from "@/lib/filters/browse";
import type { ContentScope } from "@/lib/filters/period";
import { VIDEO_SORT_KEYS } from "@/lib/filters/sorting";
import { listVideos, type VideoTableItem } from "@/lib/repositories/videos";
import { VIDEOS_DEFAULT_SORT } from "@/lib/ui/video-sort";

/**
 * One page of the video library, resolved from URL parameters.
 *
 * ## Why a service rather than a fetch inside the component
 *
 * `/videos` and `/livestreams` are the same screen over the same table,
 * differing only in `media_kind`. Sharing that screen means a component neither
 * route owns — and a component may not import a repository, by lint rule and by
 * `server-only`. `removal-card.tsx` solved the same problem the same way: the
 * component takes data, something else fetches it.
 *
 * A service is what that something else is here. It may reach the repository,
 * it keeps the query resolution in one place so the two routes cannot drift on
 * what "filtered" means, and the component stays presentational.
 */

export type VideoLibraryPage = {
  items: VideoTableItem[];
  total: number;
  query: BrowseQuery<(typeof VIDEO_SORT_KEYS)[number]>;
  /**
   * Whether the reader narrowed anything.
   *
   * Drives the empty state, which has to say two different things: "nothing
   * matches what you asked for" is a filter to clear, and "nothing here yet" is
   * a sync to run. Getting that backwards sends somebody to the wrong screen.
   *
   * The scope is deliberately not counted. It comes from the route, not from
   * the reader, so an empty Livestreams page is not a filtering problem they
   * can fix by clearing anything.
   */
  isFiltered: boolean;
};

export async function loadVideoLibrary(params: {
  raw: RawParams;
  scope: ContentScope;
  defaultGameId: string | undefined;
}): Promise<VideoLibraryPage> {
  const query = resolveBrowseQuery({
    raw: params.raw,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: VIDEOS_DEFAULT_SORT,
    defaultGameId: params.defaultGameId,
  });

  const { items, total } = await listVideos({
    streamerId: query.streamerId,
    gameId: query.gameId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    scope: params.scope,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  return {
    items,
    total,
    query,
    isFiltered:
      query.search !== undefined ||
      query.streamerId !== undefined ||
      query.gameId !== query.defaultGameId ||
      query.period.preset !== "all",
  };
}
