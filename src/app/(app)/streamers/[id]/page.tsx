import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, ExternalLink, Settings2 } from "lucide-react";

import {
  EditStreamerPanel,
  SyncPanel,
  TokenPanel,
} from "@/app/(app)/admin/streamers/[id]/panels";
import { StreamerRemovalCard } from "@/app/(app)/admin/streamers/[id]/removal-card";
import { SyncPostsPanel } from "@/app/(app)/admin/streamers/[id]/sync-posts-panel";
import { SyncVideosPanel } from "@/app/(app)/admin/streamers/[id]/sync-videos-panel";
import {
  resolveStreamerTab,
  STREAMER_TAB_LABELS,
  tabsFor,
  type StreamerTab,
} from "@/app/(app)/streamers/[id]/tabs";
import { TokenStatusBadge } from "@/components/admin/token-status-badge";
import { CsvExportLink } from "@/components/data/csv-export-link";
import { FilterBar } from "@/components/data/filter-bar";
import { GrowthPanel } from "@/components/dashboard/growth";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { Pagination } from "@/components/data/pagination";
import { EmptyState, MetricCardSkeleton, TableSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { TabNav } from "@/components/layout/tab-nav";
import { ANALYSIS_DEFAULT_SORT, AnalysisTable } from "@/components/tables/analysis-table";
import { POSTS_DEFAULT_SORT, PostsTable } from "@/components/tables/posts-table";
import { VIDEOS_DEFAULT_SORT, VideosTable } from "@/components/tables/videos-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { isAdmin } from "@/lib/auth/roles";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import {
  ANALYSIS_SORT_KEYS,
  POST_SORT_KEYS,
  VIDEO_SORT_KEYS,
  type SortState,
} from "@/lib/filters/sorting";
import { EXPECTED_SCOPES } from "@/lib/meta/token-status";
import { listCommentAnalyses } from "@/lib/repositories/analysis";
import { getStreamerOverview, type MetricTotal } from "@/lib/repositories/metrics";
import { getPageGrowth } from "@/lib/repositories/page-growth";
import { listPosts } from "@/lib/repositories/posts";
import {
  getStreamerById,
  getStreamerIdentity,
  getStreamerRemovalView,
  listStreamerOptions,
  listSyncRunsForStreamer,
} from "@/lib/repositories/streamers";
import { listVideos } from "@/lib/repositories/videos";
import { streamerIdSchema } from "@/lib/validation/streamers";

export const metadata: Metadata = { title: "Streamer" };
export const dynamic = "force-dynamic";

const numberFormat = new Intl.NumberFormat("en-GB");

function formatWhen(value: Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

/** A sum, with the rows that reported nothing named rather than counted as zero. */
function totalCard(total: MetricTotal): { value: string; hint: string } {
  if (total.reported === 0) {
    return {
      value: "—",
      hint:
        total.notReported > 0
          ? `Not reported by Meta for any of the ${total.notReported} posts in this period.`
          : "No posts in this period.",
    };
  }

  return {
    value: numberFormat.format(total.total ?? 0),
    hint:
      total.notReported > 0
        ? `${numberFormat.format(total.notReported)} posts did not report this — excluded, not counted as zero.`
        : `Across ${numberFormat.format(total.reported)} posts.`,
  };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

async function OverviewTab({ streamerId, params }: { streamerId: string; params: RawParams }) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: ["none"] as const,
    defaultSort: { key: "none", direction: "desc" },
  });

  const [overview, growth] = await Promise.all([
    getStreamerOverview({
      streamerId,
      from: query.period.from,
      to: query.period.to,
    }),
    /*
     * Audience figures come from a different table on a different cadence —
     * one row per day from Page insights, rather than per-post metrics — so
     * they are fetched alongside rather than folded into the overview query.
     */
    getPageGrowth({ streamerId, from: query.period.from, to: query.period.to }),
  ]);

  const reactions = totalCard(overview.reactions);
  const comments = totalCard(overview.comments);
  const shares = totalCard(overview.shares);

  return (
    <div className="space-y-4">
      <MetricGrid>
        <MetricCard
          label="Posts collected"
          value={numberFormat.format(overview.postCount)}
          hint={query.period.label}
        />
        <MetricCard
          label="Videos collected"
          value={numberFormat.format(overview.videoCount)}
          hint={query.period.label}
        />
        <MetricCard
          label="Comments stored"
          value={numberFormat.format(overview.commentCount)}
          hint="Comment text only — no commenter identity is ever collected."
        />
        <MetricCard
          label="AI summaries"
          value={numberFormat.format(overview.summaryCount)}
          hint="Completed analyses."
        />
        <MetricCard
          label="Urgent issues"
          value={numberFormat.format(overview.urgentCount)}
          hint="Analyses reporting at least one real urgent finding."
          tone={overview.urgentCount > 0 ? "danger" : "default"}
        />
        <MetricCard label="Total reactions" value={reactions.value} hint={reactions.hint} />
        <MetricCard label="Total comments" value={comments.value} hint={comments.hint} />
        <MetricCard label="Total shares" value={shares.value} hint={shares.hint} />
        <MetricCard
          label="Latest post"
          value={overview.latestPostAt ? "Collected" : "—"}
          hint={formatWhen(overview.latestPostAt)}
        />
        <MetricCard
          label="Latest video"
          value={overview.latestVideoAt ? "Collected" : "—"}
          hint={formatWhen(overview.latestVideoAt)}
        />
      </MetricGrid>

      {/*
       * Below the content figures, because it answers a different question.
       * The grid above is "what did they publish"; this is "did the audience
       * grow", which is the outcome that publishing is meant to produce.
       */}
      <GrowthPanel growth={growth} />
    </div>
  );
}

async function PostsTab({
  streamerId,
  params,
  basePath,
}: {
  streamerId: string;
  params: RawParams;
  basePath: string;
}) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: POST_SORT_KEYS,
    defaultSort: POSTS_DEFAULT_SORT,
  });

  const { items, total } = await listPosts({
    streamerId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="px-0">
          <PostsTable
            items={items}
            query={query}
            basePath={basePath}
            showStreamer={false}
            empty={{
              title: "No posts in this period",
              description:
                "Widen the period, or ask an admin to run Sync Posts for this streamer's Page.",
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={basePath}
          defaultSort={POSTS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label="posts"
        />
        <CsvExportLink
          href={buildBrowseHref("/api/export/posts", query, POSTS_DEFAULT_SORT, {
            streamerId,
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </div>
  );
}

async function VideosTab({
  streamerId,
  params,
  basePath,
}: {
  streamerId: string;
  params: RawParams;
  basePath: string;
}) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: VIDEO_SORT_KEYS,
    defaultSort: VIDEOS_DEFAULT_SORT,
  });

  const { items, total } = await listVideos({
    streamerId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="px-0">
          <VideosTable
            items={items}
            query={query}
            basePath={basePath}
            showStreamer={false}
            empty={{
              title: "No videos in this period",
              description:
                "Widen the period, or ask an admin to run Sync Videos for this streamer's Page.",
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
          label="videos"
        />
        <CsvExportLink
          href={buildBrowseHref("/api/export/videos", query, VIDEOS_DEFAULT_SORT, {
            streamerId,
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </div>
  );
}

async function AnalysisTab({
  streamerId,
  params,
  basePath,
}: {
  streamerId: string;
  params: RawParams;
  basePath: string;
}) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: ANALYSIS_SORT_KEYS,
    defaultSort: ANALYSIS_DEFAULT_SORT,
  });

  const { items, total } = await listCommentAnalyses({
    streamerId,
    search: query.search,
    from: query.period.from,
    to: query.period.to,
    scope: query.scope,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="px-0">
          <AnalysisTable
            items={items}
            query={query}
            basePath={basePath}
            showStreamer={false}
            empty={{
              title: "No analyses in this period",
              description:
                "An analysis appears once an admin has collected comments for one of this streamer's posts or videos.",
            }}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Pagination
          query={query}
          basePath={basePath}
          defaultSort={ANALYSIS_DEFAULT_SORT}
          total={total}
          shown={items.length}
          label="analyses"
        />
        <CsvExportLink
          href={buildBrowseHref("/api/export/comment-analysis", query, ANALYSIS_DEFAULT_SORT, {
            streamerId,
            resetOffset: false,
          })}
          disabled={items.length === 0}
        />
      </div>
    </div>
  );
}

async function SyncHistoryTab({ streamerId }: { streamerId: string }) {
  const runs = await listSyncRunsForStreamer(streamerId, 50);

  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="px-0">
          <EmptyState
            title="No synchronisation runs yet"
            description="A run is recorded every time posts, videos or comments are collected for this streamer."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">
              Synchronisation runs for this streamer, newest first, with what each run processed.
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Started</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col" className="hidden text-right sm:table-cell">
                  Posts
                </TableHead>
                <TableHead scope="col" className="hidden text-right sm:table-cell">
                  Videos
                </TableHead>
                <TableHead scope="col" className="hidden text-right lg:table-cell">
                  Comments
                </TableHead>
                <TableHead scope="col" className="hidden text-right lg:table-cell">
                  Summaries
                </TableHead>
                <TableHead scope="col">Finished</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="align-top text-xs whitespace-nowrap text-muted-foreground">
                    {formatWhen(run.startedAt)}
                  </TableCell>
                  <TableCell className="align-top text-xs">{run.syncType}</TableCell>
                  <TableCell className="align-top">
                    <Badge
                      variant={
                        run.status === "failed"
                          ? "destructive"
                          : run.status === "completed_with_errors"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {run.status}
                    </Badge>
                    {/*
                     * The sanitised message only. A sync error is stored with
                     * token material already stripped, and nothing here
                     * re-derives it.
                     */}
                    {run.errorMessage ? (
                      <p className="mt-1 max-w-md font-mono text-xs break-words text-muted-foreground">
                        {run.errorMessage}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono text-xs sm:table-cell">
                    {run.postsProcessed}
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono text-xs sm:table-cell">
                    {run.videosProcessed}
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                    {run.commentsProcessed}
                  </TableCell>
                  <TableCell className="hidden text-right align-top font-mono text-xs lg:table-cell">
                    {run.summariesGenerated}
                  </TableCell>
                  <TableCell className="align-top text-xs whitespace-nowrap text-muted-foreground">
                    {run.completedAt ? formatWhen(run.completedAt) : "In flight"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The Settings tab.
 *
 * Rendered only for admins, and it loads the token-bearing `StreamerView` only
 * on that branch — a viewer's request never reaches a query that selects token
 * health at all. What reaches the browser is still only `••••••••••••ABCD` and
 * the stored four-character suffix; every control re-checks the role in its
 * Server Action before mutating anything.
 */
async function SettingsTab({ streamerId }: { streamerId: string }) {
  const [streamer, removal] = await Promise.all([
    getStreamerById(streamerId),
    getStreamerRemovalView(streamerId),
  ]);
  if (!streamer) notFound();

  const grantedScopes = new Set(streamer.tokenScopes);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Page token</CardTitle>
              <CardDescription>
                Stored as AES-256-GCM ciphertext. Only the last four characters are ever shown.
              </CardDescription>
            </div>
            <TokenStatusBadge status={streamer.tokenStatus} />
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Stored token</dt>
              <dd className="font-mono">{streamer.hasToken ? streamer.maskedToken : "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last validated</dt>
              <dd>{formatWhen(streamer.tokenLastValidatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd>
                {streamer.tokenExpiresAt ? formatWhen(streamer.tokenExpiresAt) : "Does not expire"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last successful sync</dt>
              <dd>{formatWhen(streamer.lastSuccessfulSyncAt)}</dd>
            </div>
          </dl>

          {streamer.tokenValidationError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs font-medium">Last validation result</p>
              <p className="mt-1 text-xs text-muted-foreground">{streamer.tokenValidationError}</p>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs text-muted-foreground">Permissions</p>
            <div className="flex flex-wrap gap-2">
              {EXPECTED_SCOPES.map((scope) => (
                <Badge
                  key={scope}
                  variant={grantedScopes.has(scope) ? "secondary" : "outline"}
                  className="font-mono text-xs"
                >
                  {grantedScopes.has(scope) ? "✓" : "○"} {scope}
                </Badge>
              ))}
            </div>
          </div>

          {!streamer.deletedAt ? (
            <>
              <Separator />
              <TokenPanel streamerId={streamer.id} hasToken={streamer.hasToken} />
            </>
          ) : null}
        </CardContent>
      </Card>

      {!streamer.deletedAt ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
              <CardDescription>
                Editing these does not touch the stored token. Replacing a token is a separate,
                separately audited action.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EditStreamerPanel streamer={streamer} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Synchronisation</CardTitle>
              <CardDescription>
                Each run fetches from Meta and updates existing rows in place.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-start gap-6">
                <SyncPostsPanel
                  streamerId={streamer.id}
                  disabled={!streamer.hasToken}
                  disabledReason={
                    streamer.hasToken ? null : "Add a Page token before synchronising."
                  }
                />
                <SyncVideosPanel
                  streamerId={streamer.id}
                  disabled={!streamer.hasToken}
                  disabledReason={
                    streamer.hasToken ? null : "Add a Page token before synchronising."
                  }
                />
                <SyncPanel streamerId={streamer.id} disabled={!streamer.hasToken} />
              </div>
            </CardContent>
          </Card>

        </>
      ) : null}

      {/*
       * Outside the `!deletedAt` branch, deliberately.
       *
       * A streamer already removed from the roster still has one option left —
       * deleting it permanently — and hiding the card for those is what made
       * that unreachable from this screen. The card itself decides which of the
       * three to offer.
       */}
      {removal ? <StreamerRemovalCard streamer={removal} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const FALLBACKS: Record<StreamerTab, React.ReactNode> = {
  overview: (
    <MetricGrid>
      {Array.from({ length: 10 }, (_, index) => (
        <MetricCardSkeleton key={index} />
      ))}
    </MetricGrid>
  ),
  posts: (
    <Card>
      <CardContent className="px-0">
        <TableSkeleton columns={5} />
      </CardContent>
    </Card>
  ),
  videos: (
    <Card>
      <CardContent className="px-0">
        <TableSkeleton columns={5} />
      </CardContent>
    </Card>
  ),
  analysis: (
    <Card>
      <CardContent className="px-0">
        <TableSkeleton columns={6} rows={5} />
      </CardContent>
    </Card>
  ),
  sync: (
    <Card>
      <CardContent className="px-0">
        <TableSkeleton columns={6} />
      </CardContent>
    </Card>
  ),
  settings: (
    <Card>
      <CardContent className="px-0">
        <TableSkeleton columns={2} rows={6} />
      </CardContent>
    </Card>
  ),
};

export default async function StreamerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUser();
  const admin = isAdmin(user.role);

  const { id } = await params;
  const parsed = streamerIdSchema.safeParse(id);
  if (!parsed.success) notFound();

  // Identity only. The token-bearing query happens inside the Settings tab, on
  // the admin branch, so a viewer's request never touches it.
  const streamer = await getStreamerIdentity(parsed.data);
  if (!streamer) notFound();

  const raw = await searchParams;
  const tab = resolveStreamerTab(raw["tab"], admin);

  const query = resolveBrowseQuery({
    raw,
    sortKeys: ["none"] as const,
    defaultSort: { key: "none", direction: "desc" } as SortState<"none">,
  });

  const streamers = await listStreamerOptions();

  /**
   * Tab links carry the filters. `basePath` keeps `?tab=` so a sort or a page
   * change inside a tab stays inside that tab rather than bouncing to Overview.
   */
  const tabHref = (target: StreamerTab) =>
    buildBrowseHref(`/streamers/${streamer.id}?tab=${target}`, query, {
      key: "none",
      direction: "desc",
    });

  const basePath = `/streamers/${streamer.id}?tab=${tab}`;
  const showFilters = tab !== "settings" && tab !== "sync";

  return (
    <>
      <PageHeader
        title={streamer.streamerName}
        description={`${streamer.streamerCode} · ${streamer.pageName} (${streamer.pageId})`}
        primaryAction={
          <div className="flex flex-wrap items-center gap-2">
            {admin ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/streamers/${streamer.id}`}>
                  <Settings2 className="size-4" aria-hidden />
                  Admin view
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/streamers">
                <ArrowLeft className="size-4" aria-hidden />
                Roster
              </Link>
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={streamer.active ? "secondary" : "outline"}>
          {streamer.active ? "Active" : "Disabled"}
        </Badge>
        {streamer.deletedAt ? (
          <Badge variant="destructive">
            <AlertTriangle className="size-3.5" aria-hidden />
            Deleted {formatWhen(streamer.deletedAt)}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Last successful sync {formatWhen(streamer.lastSuccessfulSyncAt)}
        </span>
        <a
          href={`https://www.facebook.com/${streamer.pageId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Open Page on Facebook
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>

      <TabNav
        items={tabsFor(admin).map((key) => ({
          key,
          label: STREAMER_TAB_LABELS[key],
          href: tabHref(key),
        }))}
        active={tab}
        label="Streamer sections"
      />

      {showFilters ? (
        <FilterBar
          query={query}
          basePath={basePath}
          defaultSort={{ key: "none", direction: "desc" }}
          options={{
            streamers,
            showScope: tab === "analysis",
            showSearch: tab !== "overview",
            searchPlaceholder: "Search this streamer's content…",
          }}
        />
      ) : null}

      <Suspense key={`${tab}-${JSON.stringify(raw)}`} fallback={FALLBACKS[tab]}>
        {tab === "overview" ? <OverviewTab streamerId={streamer.id} params={raw} /> : null}
        {tab === "posts" ? (
          <PostsTab streamerId={streamer.id} params={raw} basePath={basePath} />
        ) : null}
        {tab === "videos" ? (
          <VideosTab streamerId={streamer.id} params={raw} basePath={basePath} />
        ) : null}
        {tab === "analysis" ? (
          <AnalysisTab streamerId={streamer.id} params={raw} basePath={basePath} />
        ) : null}
        {tab === "sync" ? <SyncHistoryTab streamerId={streamer.id} /> : null}
        {tab === "settings" ? <SettingsTab streamerId={streamer.id} /> : null}
      </Suspense>

      {streamer.notes ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{streamer.notes}</p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
