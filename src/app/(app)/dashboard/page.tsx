import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import {
  AlertTriangle,
  FileText,
  Heart,
  KeyRound,
  MessageSquare,
  Share2,
  Users,
  Video,
} from "lucide-react";

import {
  EngagementChart,
  SentimentChart,
  TopStreamersChart,
  VolumeChart,
} from "@/components/dashboard/charts";
import {
  MetricTile,
  RecentContent,
  SyncHealth,
  TokenHealth,
  UrgentIssues,
} from "@/components/dashboard/sections";
import { CommentOverviewPanel } from "@/components/dashboard/comment-overview";
import { AggregateMetricGroups } from "@/components/metrics/metric-group";
import { FilterBar } from "@/components/data/filter-bar";
import { PageHeader, SectionHeader } from "@/components/layout/page-header";
import { CardSkeleton, EmptyState, TableSkeleton } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import type { SortState } from "@/lib/filters/sorting";
import {
  getMetricsComparison,
  getSentimentDistribution,
  getTimeSeries,
  getTokenHealth,
  getTopStreamers,
  listRecentContent,
  listUrgentIssues,
  type DashboardFilters,
} from "@/lib/repositories/dashboard";
import { getMetricTotals } from "@/lib/repositories/canonical-metrics";
import { getCommentOverview } from "@/lib/repositories/comment-overview";
import { getSyncLogTotals, listSyncLogs } from "@/lib/repositories/sync-logs";
import { listStreamerOptions } from "@/lib/repositories/streamers";
import { getGameFilterView } from "@/lib/services/game-filter-view";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * One reading across every comment the filters select.
 *
 * Its own Suspense boundary because it reads the comment table rather than the
 * pre-aggregated metric tables, and a reader should not wait on it to see the
 * headline figures.
 */
async function Conversation({ params, defaultGameId }: SectionProps) {
  const overview = await getCommentOverview(filtersFrom(params, defaultGameId));
  return <CommentOverviewPanel overview={overview} />;
}

/**
 * The dashboard shares the filter contract with every other screen, so a
 * period chosen here survives a click through to Posts. There is no sortable
 * table on this page, hence the single inert sort key.
 */
const SORT_KEYS = ["none"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT: SortState<SortKey> = { key: "none", direction: "desc" };

/**
 * What every section needs to resolve the same filters.
 *
 * `defaultGameId` travels with `params` rather than being read inside
 * `filtersFrom`, because deciding it needs a database round trip and each
 * section is its own Suspense boundary — resolving it per section would be six
 * identical queries to answer one question the page already asked.
 */
type SectionProps = { params: RawParams; defaultGameId: string | undefined };

function filtersFrom(params: RawParams, defaultGameId: string | undefined): DashboardFilters {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
    defaultGameId,
  });

  return {
    streamerId: query.streamerId,
    gameId: query.gameId,
    period: { from: query.period.from, to: query.period.to },
    scope: query.scope,
  };
}

/**
 * The eight headline figures.
 *
 * Comparisons appear only where a previous window exists and had something to
 * compare against — see `MetricTile`. Roster figures carry none at all: active
 * streamers and token health describe the present, not the period, so a
 * period-over-period change would be a category error.
 */
async function Metrics({ params, defaultGameId }: SectionProps) {
  const filters = filtersFrom(params, defaultGameId);
  const { current, previous } = await getMetricsComparison(filters);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricTile
        label="Active streamers"
        value={current.activeStreamers}
        icon={Users}
        hint="Streamers currently marked active. A roster figure, not a period total."
        href="/streamers"
      />
      <MetricTile
        label="Valid page tokens"
        value={current.validTokens}
        icon={KeyRound}
        tone={current.tokensNeedingAttention > 0 ? "warning" : "default"}
        hint={
          current.tokensNeedingAttention > 0
            ? `${current.tokensNeedingAttention} token(s) need attention. A streamer with an invalid token stops syncing.`
            : "Every active streamer has a working Page token."
        }
        href="/streamers"
      />
      <MetricTile
        label="Posts collected"
        value={current.postsCollected}
        previous={previous?.postsCollected}
        icon={FileText}
        hint="Posts published in the selected period, after filters."
        href="/posts"
      />
      <MetricTile
        label="Videos collected"
        value={current.videosCollected}
        previous={previous?.videosCollected}
        icon={Video}
        hint="Videos published in the selected period, after filters."
        href="/videos"
      />
      <MetricTile
        label="Total reactions"
        value={current.totalReactions.total}
        previous={previous?.totalReactions.total}
        notReported={current.totalReactions.notReported}
        icon={Heart}
        hint="Summed across posts that reported a figure. Posts Meta reported nothing for are excluded rather than counted as zero."
      />
      <MetricTile
        label="Total comments"
        value={current.totalComments.total}
        previous={previous?.totalComments.total}
        notReported={current.totalComments.notReported}
        icon={MessageSquare}
        hint="Summed across posts that reported a figure."
      />
      <MetricTile
        label="Total shares"
        value={current.totalShares.total}
        previous={previous?.totalShares.total}
        notReported={current.totalShares.notReported}
        icon={Share2}
        hint="Meta omits shares on posts with none, so this is usually the sparsest of the three."
      />
      <MetricTile
        label="Urgent issues"
        value={current.urgentIssues}
        previous={previous?.urgentIssues}
        icon={AlertTriangle}
        tone={current.urgentIssues > 0 ? "danger" : "default"}
        hint="Analysed content where the model recorded a real finding. Placeholder findings are excluded."
        href="/comment-analysis"
      />
    </div>
  );
}

/** Engagement, publishing mix and the leaders — four charts, not eight. */
async function Performance({ params, defaultGameId }: SectionProps) {
  const filters = filtersFrom(params, defaultGameId);
  const [series, top] = await Promise.all([getTimeSeries(filters), getTopStreamers(filters)]);

  if (series.length === 0) {
    return (
      <EmptyState
        title="Nothing to chart yet"
        description="No posts or videos fall in the selected period. Widen the date range, or run a synchronisation."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Engagement over time</CardTitle>
        </CardHeader>
        <CardContent>
          <EngagementChart data={series} />
          {/*
           * Said plainly rather than left for the reader to discover. Videos
           * keep their metrics in video_insights under different metric names,
           * so folding them into this line would sum two unlike things.
           */}
          <p className="mt-2 text-xs text-muted-foreground">
            Reactions, comments and shares come from posts. Video engagement is reported by Meta
            under a different set of metrics and is not summed here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Top streamers</CardTitle>
        </CardHeader>
        <CardContent>
          {top.length === 0 ? (
            <p className="text-sm text-muted-foreground">No post engagement in this period.</p>
          ) : (
            <TopStreamersChart data={top} />
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Content volume</CardTitle>
        </CardHeader>
        <CardContent>
          <VolumeChart data={series} />
          <p className="mt-2 text-xs text-muted-foreground">
            Days with nothing published are absent rather than plotted as zero.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

async function Sentiment({ params, defaultGameId }: SectionProps) {
  const filters = filtersFrom(params, defaultGameId);
  const slices = await getSentimentDistribution(filters);
  const analysed = slices.reduce((sum, slice) => sum + slice.count, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Community sentiment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {analysed === 0 ? (
          <p className="text-sm text-muted-foreground">
            No content has been analysed in this period.
          </p>
        ) : (
          <>
            <SentimentChart data={slices} />
            <p className="text-xs text-muted-foreground">
              Across {analysed} analysed item{analysed === 1 ? "" : "s"}. &ldquo;No comments&rdquo;
              means there was nothing to analyse, which is a different finding from neutral.
            </p>
          </>
        )}
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href="/comment-analysis">Open comment analysis</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The canonical metrics, grouped.
 *
 * Reads `content_metrics_current` rather than resolving anything: the numbers
 * here are the numbers the rollup stored, with the provenance stored beside
 * them. Every total carries its own denominator, because a sum over the subset
 * Meta happened to report is not the roster's figure.
 */
async function CanonicalMetrics({ params, defaultGameId }: SectionProps) {
  const filters = filtersFrom(params, defaultGameId);

  const totals = await getMetricTotals({
    streamerId: filters.streamerId,
    gameId: filters.gameId,
    period: filters.period,
    ...(filters.scope === "posts"
      ? { contentType: "post" as const }
      : filters.scope === "videos"
        ? { contentType: "video" as const }
        : {}),
  });

  if (totals.contentCount === 0) {
    return (
      <EmptyState
        title="No performance metrics yet"
        description="Nothing in this period has been processed into metrics. Run a sync, then a metric rollup."
      />
    );
  }

  return (
    <AggregateMetricGroups metrics={totals.metrics} withoutMetrics={totals.withoutMetrics} />
  );
}

async function Operations({ params, defaultGameId, isAdmin }: SectionProps & { isAdmin: boolean }) {
  const filters = filtersFrom(params, defaultGameId);

  const [issues, tokens, syncTotals, recentRuns] = await Promise.all([
    listUrgentIssues(filters),
    getTokenHealth(),
    getSyncLogTotals(),
    listSyncLogs(4),
  ]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="space-y-3 lg:col-span-2">
        <SectionHeader
          title="Urgent issues"
          description="Content the model flagged as needing a look."
        />
        <UrgentIssues issues={issues} />
      </section>

      <div className="space-y-4">
        <SyncHealth
          totals={syncTotals}
          recent={recentRuns.map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          }))}
        />
        <TokenHealth counts={tokens} isAdmin={isAdmin} />
      </div>
    </div>
  );
}

async function Recent({ params, defaultGameId }: SectionProps) {
  const rows = await listRecentContent(filtersFrom(params, defaultGameId));
  return <RecentContent rows={rows} />;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const [user, params, streamerOptions, gameFilter] = await Promise.all([
    requireUser(),
    searchParams,
    listStreamerOptions(),
    getGameFilterView(),
  ]);

  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
    defaultGameId: gameFilter.defaultGameId,
  });
  const isAdmin = user.role === "admin";

  /*
   * Keyed on the filters so every section re-suspends when they change.
   * Without it React reuses the resolved boundary and the reader sees the
   * previous period's numbers under the new filter chip.
   */
  const key = JSON.stringify(params);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Monitor streamer performance, Facebook content engagement, comment sentiment, and synchronization health."
        showBreadcrumbs={false}
        primaryAction={
          /*
           * Admin only. A viewer cannot trigger a sync, and a disabled button
           * they can never use is worse than an action that simply is not
           * offered.
           */
          isAdmin ? (
            <Button asChild size="sm">
              <Link href="/admin/streamers">Sync all</Link>
            </Button>
          ) : undefined
        }
        secondaryAction={
          <Button asChild variant="outline" size="sm">
            <Link href="/reports">Export</Link>
          </Button>
        }
      />

      <FilterBar
        query={query}
        basePath="/dashboard"
        defaultSort={DEFAULT_SORT}
        options={{
          streamers: streamerOptions,
          games: gameFilter.games,
          showAllContent: gameFilter.showAllContent,
          showUnregistered: gameFilter.showUnregistered,
        }}
      />

      {/*
       * Each section streams independently, so a slow chart query does not
       * hold back the headline figures most readers came for.
       */}
      <Suspense key={`m-${key}`} fallback={<CardSkeleton count={8} />}>
        <Metrics params={params} defaultGameId={gameFilter.defaultGameId} />
      </Suspense>

      <section className="space-y-3">
        <SectionHeader
          title="What people are saying"
          description="Every comment in the current selection, pooled into one reading. Written by the configured AI provider and cached against the content it covers, so changing a filter and coming back costs nothing. Falls back to an in-process count when no provider is available."
        />
        <Suspense key={`co-${key}`} fallback={<CardSkeleton count={1} />}>
          <Conversation params={params} defaultGameId={gameFilter.defaultGameId} />
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Performance metrics"
          description="Meta's own figures, grouped. Each total says how much of the content it covers — a metric Meta did not report is excluded, never counted as zero."
        />
        <Suspense key={`c-${key}`} fallback={<CardSkeleton count={3} />}>
          <CanonicalMetrics params={params} defaultGameId={gameFilter.defaultGameId} />
        </Suspense>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Performance overview" />
        <Suspense key={`p-${key}`} fallback={<CardSkeleton count={3} />}>
          <Performance params={params} defaultGameId={gameFilter.defaultGameId} />
        </Suspense>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="min-w-0 space-y-3 lg:col-span-2">
          <SectionHeader title="Recent content" description="The newest posts and videos." />
          <Suspense key={`r-${key}`} fallback={<TableSkeleton rows={5} />}>
            <Recent params={params} defaultGameId={gameFilter.defaultGameId} />
          </Suspense>
        </section>

        <Suspense key={`s-${key}`} fallback={<CardSkeleton count={1} />}>
          <Sentiment params={params} defaultGameId={gameFilter.defaultGameId} />
        </Suspense>
      </div>

      <Suspense key={`o-${key}`} fallback={<CardSkeleton count={3} />}>
        <Operations params={params} defaultGameId={gameFilter.defaultGameId} isAdmin={isAdmin} />
      </Suspense>
    </>
  );
}
