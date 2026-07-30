import type { Metadata } from "next";
import { Suspense } from "react";

import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { Pagination } from "@/components/data/pagination";
import { TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { ANALYSIS_DEFAULT_SORT, AnalysisTable } from "@/components/tables/analysis-table";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import { ANALYSIS_SORT_KEYS } from "@/lib/filters/sorting";
import { listCommentAnalyses } from "@/lib/repositories/analysis";
import { listStreamerOptions } from "@/lib/repositories/streamers";

export const metadata: Metadata = { title: "Comment analysis" };
export const dynamic = "force-dynamic";

const BASE_PATH = "/comment-analysis";

async function AnalysisPanel({ params }: { params: RawParams }) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: ANALYSIS_SORT_KEYS,
    defaultSort: ANALYSIS_DEFAULT_SORT,
  });

  const { items, total } = await listCommentAnalyses({
    streamerId: query.streamerId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    scope: query.scope,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  return (
    <>
      <Card>
        <CardContent className="px-0">
          <AnalysisTable
            items={items}
            query={query}
            basePath={BASE_PATH}
            empty={{
              title: "No analyses match these filters",
              description:
                "An analysis appears once an admin has collected comments for a post or video. Try widening the period or choosing All streamers.",
              action: { label: "Clear filters", href: BASE_PATH },
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={BASE_PATH}
          defaultSort={ANALYSIS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label="analyses"
        />
        <CsvExportLink
          href={buildBrowseHref("/api/export/comment-analysis", query, ANALYSIS_DEFAULT_SORT, {
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </>
  );
}

export default async function CommentAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  await requireUser();

  const params = await searchParams;
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: ANALYSIS_SORT_KEYS,
    defaultSort: ANALYSIS_DEFAULT_SORT,
  });
  const streamers = await listStreamerOptions();

  return (
    <>
      <PageHeader
        title="Comment analysis"
        description="AI summaries of the comments on posts and videos. Commenter names are never collected, stored, or shown — every analysis is generated from comment text alone."
      />

      <FilterBar
        query={query}
        basePath={BASE_PATH}
        defaultSort={ANALYSIS_DEFAULT_SORT}
        options={{ streamers, searchPlaceholder: "Summary text, content title or streamer…" }}
      />

      <Suspense
        key={JSON.stringify(params)}
        fallback={
          <Card>
            <CardContent className="px-0">
              <TableSkeleton columns={6} rows={5} />
            </CardContent>
          </Card>
        }
      >
        <AnalysisPanel params={params} />
      </Suspense>
    </>
  );
}
