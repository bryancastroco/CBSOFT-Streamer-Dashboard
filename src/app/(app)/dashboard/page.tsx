import type { Metadata } from "next";
import { Suspense } from "react";
import {
  AlertTriangle,
  FileText,
  Heart,
  KeyRound,
  MessageSquare,
  Share2,
  ShieldAlert,
  Sparkles,
  Users,
  Video,
} from "lucide-react";

import { FilterBar } from "@/components/data/filter-bar";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { MetricCardSkeleton } from "@/components/data/states";
import { PageHeader } from "@/components/layout/page-header";
import { requireUser } from "@/lib/auth/guards";
import { buildBrowseHref, resolveBrowseQuery, type RawParams } from "@/lib/filters/browse";
import type { SortState } from "@/lib/filters/sorting";
import { getDashboardMetrics, type MetricTotal } from "@/lib/repositories/metrics";
import { listStreamerOptions } from "@/lib/repositories/streamers";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/**
 * The dashboard has no sortable table, but it shares the filter contract with
 * every other screen so a period chosen here survives a click through to Posts.
 */
const SORT_KEYS = ["none"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT: SortState<SortKey> = { key: "none", direction: "desc" };

const numberFormat = new Intl.NumberFormat("en-GB");

/**
 * Render an engagement sum.
 *
 * A window in which nothing reported a figure shows `—`, never `0`. Rows that
 * Meta did not report a figure for are named in the hint rather than folded
 * into the total, because a total that quietly excludes half its rows is a
 * wrong number presented confidently.
 */
function totalCard(total: MetricTotal, rowLabel: string): { value: string; hint: string } {
  if (total.reported === 0) {
    return {
      value: "—",
      hint:
        total.notReported > 0
          ? `Not reported by Meta for any of the ${total.notReported} ${rowLabel} in this period.`
          : `No ${rowLabel} in this period.`,
    };
  }

  const base = `Across ${numberFormat.format(total.reported)} ${rowLabel}.`;

  return {
    value: numberFormat.format(total.total ?? 0),
    hint:
      total.notReported > 0
        ? `${base} ${numberFormat.format(total.notReported)} did not report it — excluded, not counted as zero.`
        : base,
  };
}

async function DashboardCards({ params }: { params: RawParams }) {
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
  });

  const metrics = await getDashboardMetrics({
    streamerId: query.streamerId,
    from: query.period.from,
    to: query.period.to,
    scope: query.scope,
  });

  const contentHref = (path: string) =>
    buildBrowseHref(path, query, DEFAULT_SORT, { resetOffset: true });

  const reactions = totalCard(metrics.totalReactions, "posts");
  const comments = totalCard(metrics.totalComments, "posts");
  const shares = totalCard(metrics.totalShares, "posts");

  return (
    <MetricGrid>
      <MetricCard
        label="Active streamers"
        value={numberFormat.format(metrics.activeStreamers)}
        hint="Current roster, not affected by the period filter."
        icon={Users}
        href="/streamers"
      />
      <MetricCard
        label="Valid Page tokens"
        value={numberFormat.format(metrics.validTokens)}
        hint="Last validated against Meta and healthy."
        icon={KeyRound}
        tone={metrics.validTokens === 0 && metrics.activeStreamers > 0 ? "warning" : "default"}
      />
      <MetricCard
        label="Tokens requiring attention"
        value={numberFormat.format(metrics.tokensNeedingAttention)}
        hint="Missing, expiring, expired, invalid or under-scoped."
        icon={ShieldAlert}
        tone={metrics.tokensNeedingAttention > 0 ? "warning" : "default"}
        href="/streamers"
      />
      <MetricCard
        label="Posts collected"
        value={numberFormat.format(metrics.postsCollected)}
        hint={query.period.label}
        icon={FileText}
        href={contentHref("/posts")}
      />
      <MetricCard
        label="Videos collected"
        value={numberFormat.format(metrics.videosCollected)}
        hint={query.period.label}
        icon={Video}
        href={contentHref("/videos")}
      />

      <MetricCard
        label="Total reactions"
        value={reactions.value}
        hint={reactions.hint}
        icon={Heart}
      />
      <MetricCard
        label="Total comments"
        value={comments.value}
        hint={comments.hint}
        icon={MessageSquare}
      />
      <MetricCard label="Total shares" value={shares.value} hint={shares.hint} icon={Share2} />

      <MetricCard
        label="AI summaries generated"
        value={numberFormat.format(metrics.summariesGenerated)}
        hint="Completed analyses for content in this period."
        icon={Sparkles}
        href={contentHref("/comment-analysis")}
      />
      <MetricCard
        label="Urgent issues detected"
        value={numberFormat.format(metrics.urgentIssues)}
        hint="Analyses reporting at least one real urgent finding."
        icon={AlertTriangle}
        tone={metrics.urgentIssues > 0 ? "danger" : "default"}
        href={contentHref("/comment-analysis")}
      />
    </MetricGrid>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  await requireUser();

  const params = await searchParams;
  const query = resolveBrowseQuery({
    raw: params,
    sortKeys: SORT_KEYS,
    defaultSort: DEFAULT_SORT,
  });
  const streamers = await listStreamerOptions();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Aggregate performance across every connected CBSOFT streamer Page. All times are UTC."
      />

      <FilterBar
        query={query}
        basePath="/dashboard"
        defaultSort={DEFAULT_SORT}
        options={{ streamers, showSearch: false }}
      />

      {/*
       * The cards are their own Suspense boundary so the filter bar paints and
       * stays interactive while the aggregates are still being counted — a
       * reader who picked the wrong period can change it without waiting.
       */}
      <Suspense
        key={JSON.stringify(params)}
        fallback={
          <MetricGrid>
            {Array.from({ length: 10 }, (_, index) => (
              <MetricCardSkeleton key={index} />
            ))}
          </MetricGrid>
        }
      >
        <DashboardCards params={params} />
      </Suspense>

      <p className="text-xs text-muted-foreground">
        Engagement totals cover posts only — Meta reports reactions, comments and shares on the post
        edge. Video engagement is reported as insight metrics on each video.
      </p>
    </>
  );
}
