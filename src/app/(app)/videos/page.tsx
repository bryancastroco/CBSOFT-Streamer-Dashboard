import type { Metadata } from "next";
import { Suspense } from "react";

import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { VIDEOS_DEFAULT_SORT, VideosTable } from "@/components/tables/videos-table";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { VIDEO_SORT_KEYS } from "@/lib/filters/sorting";
import { listStreamerOptions } from "@/lib/repositories/streamers";
import { listVideos } from "@/lib/repositories/videos";
import { getGameFilterView } from "@/lib/services/game-filter-view";
import { DISPLAY_TIME_ZONE_LABEL } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Videos" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/videos";

async function VideosPanel({
  params,
  showGames,
  defaultGameId,
}: {
  params: RawParams;
  showGames: boolean;
  defaultGameId: string | undefined;
}) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: VIDEOS_DEFAULT_SORT,
    defaultGameId,
  });

  const { items, total } = await listVideos({
    streamerId: query.streamerId,
    gameId: query.gameId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  const isFiltered =
    query.search !== undefined ||
    query.streamerId !== undefined ||
    query.gameId !== query.defaultGameId ||
    query.period.preset !== "all";

  return (
    <>
      <Card>
        <CardContent className="px-0">
          <VideosTable
            items={items}
            query={query}
            basePath={BASE_PATH}
            showGames={showGames}
            empty={{
              title: "No videos match these filters",
              description: isFiltered
                ? "Try widening the period, clearing the search, or choosing All streamers."
                : "An admin can collect videos from Admin → Streamers → Sync Videos.",
              ...(isFiltered ? { action: { label: "Clear filters", href: BASE_PATH } } : {}),
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={BASE_PATH}
          defaultSort={VIDEOS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label="videos"
        />
        <CsvExportLink
          href={buildBrowseHref("/api/export/videos", query, VIDEOS_DEFAULT_SORT, {
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </>
  );
}

export default async function VideosPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requireUser();

  const params = await searchParams;
  const [streamers, gameFilter] = await Promise.all([listStreamerOptions(), getGameFilterView()]);

  // Resolved after the view: the default depends on whether any game exists.
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: VIDEOS_DEFAULT_SORT,
    defaultGameId: gameFilter.defaultGameId,
  });

  return (
    <>
      <PageHeader
        title="Videos"
        description={`Videos published on connected Facebook Pages. Ended live broadcasts appear here as VODs. All times are ${DISPLAY_TIME_ZONE_LABEL}.`}
      />

      <FilterBar
        query={query}
        basePath={BASE_PATH}
        defaultSort={VIDEOS_DEFAULT_SORT}
        options={{
          streamers,
          games: gameFilter.games,
          showAllContent: gameFilter.showAllContent,
          showUnregistered: gameFilter.showUnregistered,
          showScope: false,
          searchPlaceholder: "Title, description, video id or streamer…",
        }}
      />

      <Suspense
        key={JSON.stringify(params)}
        fallback={
          <Card>
            <CardContent className="px-0">
              <TableSkeleton columns={5} />
            </CardContent>
          </Card>
        }
      >
        <VideosPanel
          params={params}
          showGames={gameFilter.games.length > 0}
          defaultGameId={gameFilter.defaultGameId}
        />
      </Suspense>
    </>
  );
}
