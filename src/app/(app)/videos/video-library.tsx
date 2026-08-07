import { Suspense } from "react";

import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { VIDEOS_DEFAULT_SORT, VideosTable } from "@/components/tables/videos-table";
import { Card, CardContent } from "@/components/ui/card";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import type { ContentScope } from "@/lib/filters/period";
import { VIDEO_SORT_KEYS } from "@/lib/filters/sorting";
import { getGameFilterView } from "@/lib/services/game-filter-view";
import { listStreamerFilterOptions } from "@/lib/services/streamer-options";
import { loadVideoLibrary } from "@/lib/services/video-library";

/**
 * The screen behind both `/videos` and `/livestreams`.
 *
 * Two routes over one table, differing only in which `media_kind` they show and
 * what they call it. Written once because the alternative is two copies of a
 * filter bar, a pagination footer and an export link that agree today and drift
 * on the first change to any of them — which is exactly how this project ended
 * up with two "Danger zone" cards offering different numbers of options.
 *
 * The scope is fixed by the route rather than chosen in the filter bar. A
 * reader on Livestreams asked for livestreams by navigating there; offering a
 * control that could contradict the page they are on is a second source of
 * truth for the same question.
 */

export type VideoLibraryProps = {
  searchParams: Promise<RawParams>;
  /** `videos` or `livestreams`. Fixes what this route lists. */
  scope: ContentScope;
  basePath: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  /** Plural noun for the pagination footer — "videos", "livestreams". */
  itemLabel: string;
  empty: { title: string; filtered: string; unfiltered: string };
  csvBaseName: string;
};

async function LibraryPanel({
  params,
  scope,
  basePath,
  showGames,
  defaultGameId,
  itemLabel,
  empty,
  csvBaseName,
}: {
  params: RawParams;
  scope: ContentScope;
  basePath: string;
  showGames: boolean;
  defaultGameId: string | undefined;
  itemLabel: string;
  empty: VideoLibraryProps["empty"];
  csvBaseName: string;
}) {
  const { items, total, query, isFiltered } = await loadVideoLibrary({
    raw: params,
    scope,
    defaultGameId,
  });

  /*
   * The scope rides along to the export.
   *
   * `buildBrowseHref` only writes what the reader chose, and this was chosen by
   * the route. Without it a CSV downloaded from Livestreams would quietly
   * contain every video — the file disagreeing with the table it came from,
   * which is the one thing an export must never do.
   */
  const csvHref = `${buildBrowseHref(`/api/export/${csvBaseName}`, query, VIDEOS_DEFAULT_SORT, {
    resetOffset: false,
  })}${"&"}scope=${scope}`;

  return (
    <>
      <Card>
        <CardContent className="px-0">
          <VideosTable
            items={items}
            query={query}
            basePath={basePath}
            showGames={showGames}
            empty={{
              title: empty.title,
              description: isFiltered ? empty.filtered : empty.unfiltered,
              ...(isFiltered ? { action: { label: "Clear filters", href: basePath } } : {}),
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={basePath}
          defaultSort={VIDEOS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label={itemLabel}
        />
        <CsvExportLink href={csvHref} disabled={items.length === 0} />
      </div>
    </>
  );
}

export async function VideoLibrary(props: VideoLibraryProps) {
  const params = await props.searchParams;
  const [streamers, gameFilter] = await Promise.all([
    listStreamerFilterOptions(),
    getGameFilterView(),
  ]);

  // Resolved after the view: the default depends on whether any game exists.
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: VIDEOS_DEFAULT_SORT,
    defaultGameId: gameFilter.defaultGameId,
  });

  return (
    <>
      <PageHeader title={props.title} description={props.description} />

      <FilterBar
        query={query}
        basePath={props.basePath}
        defaultSort={VIDEOS_DEFAULT_SORT}
        options={{
          streamers,
          games: gameFilter.games,
          showAllContent: gameFilter.showAllContent,
          showUnregistered: gameFilter.showUnregistered,
          // Fixed by the route. See the note at the top of this file.
          showScope: false,
          searchPlaceholder: props.searchPlaceholder,
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
        <LibraryPanel
          params={params}
          scope={props.scope}
          basePath={props.basePath}
          showGames={gameFilter.games.length > 0}
          defaultGameId={gameFilter.defaultGameId}
          itemLabel={props.itemLabel}
          empty={props.empty}
          csvBaseName={props.csvBaseName}
        />
      </Suspense>
    </>
  );
}
