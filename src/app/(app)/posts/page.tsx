import type { Metadata } from "next";
import { Suspense } from "react";

import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { POSTS_DEFAULT_SORT, PostsTable } from "@/components/tables/posts-table";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { POST_SORT_KEYS } from "@/lib/filters/sorting";
import { listGameOptions } from "@/lib/repositories/games";
import { listPosts } from "@/lib/repositories/posts";
import { listStreamerOptions } from "@/lib/repositories/streamers";

export const metadata: Metadata = { title: "Posts" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/posts";

async function PostsPanel({ params, showGames }: { params: RawParams; showGames: boolean }) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: POST_SORT_KEYS,
    defaultSort: POSTS_DEFAULT_SORT,
  });

  const { items, total } = await listPosts({
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
    query.gameId !== undefined ||
    query.period.preset !== "all";

  return (
    <>
      <Card>
        <CardContent className="px-0">
          <PostsTable
            items={items}
            query={query}
            basePath={BASE_PATH}
            showGames={showGames}
            empty={{
              title: "No posts match these filters",
              description: isFiltered
                ? "Try widening the period, clearing the search, or choosing All streamers."
                : "An admin can collect posts from Admin → Streamers → Sync Posts.",
              ...(isFiltered ? { action: { label: "Clear filters", href: BASE_PATH } } : {}),
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={BASE_PATH}
          defaultSort={POSTS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label="posts"
        />
        {/*
         * The export is handed the same query string the table was rendered
         * from, so the file cannot contain a different set of rows than the one
         * on screen.
         */}
        <CsvExportLink
          href={buildBrowseHref("/api/export/posts", query, POSTS_DEFAULT_SORT, {
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </>
  );
}

export default async function PostsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  // Any signed-in role may read posts — this is core viewer content.
  await requireUser();

  const params = await searchParams;
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: POST_SORT_KEYS,
    defaultSort: POSTS_DEFAULT_SORT,
  });
  const [streamers, games] = await Promise.all([listStreamerOptions(), listGameOptions()]);

  return (
    <>
      <PageHeader
        title="Posts"
        description="Published Facebook Page posts collected from Meta. A dash means Meta did not report that figure — it does not mean zero. All times are UTC."
      />

      <FilterBar
        query={query}
        basePath={BASE_PATH}
        defaultSort={POSTS_DEFAULT_SORT}
        options={{
          streamers,
          games,
          showScope: false,
          searchPlaceholder: "Message, post id or streamer…",
        }}
      />

      {/*
       * Its own Suspense boundary so the filter bar paints and stays interactive
       * while the query runs — a reader who picked the wrong period can change it
       * without waiting for the wrong answer to arrive first.
       */}
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
        <PostsPanel params={params} showGames={games.length > 0} />
      </Suspense>
    </>
  );
}
