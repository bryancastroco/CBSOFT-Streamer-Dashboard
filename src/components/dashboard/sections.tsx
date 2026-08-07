import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  ExternalLink,
  FileText,
  Minus,
  TrendingDown,
  TrendingUp,
  Video,
} from "lucide-react";

import { EmptyState } from "@/components/layout/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  RecentContentRow,
  TokenHealthCounts,
  UrgentIssueRow,
} from "@/lib/repositories/dashboard";
import type { MetricTotal } from "@/lib/repositories/metrics";
import { SEVERITY_LABEL, severityOf } from "@/lib/ui/severity";
import { describeStatus } from "@/lib/ui/status";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/time/zone";

const numberFormat = new Intl.NumberFormat();

/**
 * A metric with an optional comparison.
 *
 * ## Why the comparison is so often absent
 *
 * A trend is shown only when there is a real previous period to compare with
 * and that period had a figure to compare against. An open-ended date range has
 * no preceding window; a previous window of zero gives a percentage that is
 * either undefined or infinite. In both cases the comparison is hidden rather
 * than rendered as "+100%" or "—", because a number on a dashboard is taken as
 * a measurement whether or not it deserves to be.
 */
export function MetricTile({
  label,
  value,
  icon: Icon,
  previous,
  hint,
  href,
  tone = "default",
  notReported,
}: {
  label: string;
  value: number | null;
  icon: LucideIcon;
  previous?: number | null;
  hint: string;
  href?: string;
  tone?: "default" | "warning" | "danger";
  /** Rows where Meta reported nothing. Shown so a total is not read as complete. */
  notReported?: number;
}) {
  const change =
    typeof value === "number" && typeof previous === "number" && previous > 0
      ? ((value - previous) / previous) * 100
      : null;

  /*
   * A previous window existed and held nothing.
   *
   * There is no percentage to compute from zero, but silence is the wrong
   * answer: with no data before the current window, every card renders bare
   * and the comparison looks broken rather than inapplicable. Saying so costs
   * one line and removes the ambiguity.
   */
  const noPriorActivity =
    change === null && typeof previous === "number" && previous === 0 && (value ?? 0) > 0;

  const TrendIcon =
    change === null ? Minus : change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;

  const body = (
    <Card
      className={cn(
        "h-full transition-colors",
        href && "hover:border-border-strong",
        tone === "warning" && "border-warning/40",
        tone === "danger" && "border-danger/40",
      )}
    >
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-xs font-medium text-muted-foreground">{label}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
          <Icon
            className={cn(
              "size-4 shrink-0",
              tone === "warning" && "text-warning",
              tone === "danger" && "text-danger",
              tone === "default" && "text-muted-foreground",
            )}
            aria-hidden
          />
        </div>

        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {value === null ? "—" : numberFormat.format(value)}
        </p>

        <div className="flex min-h-4 flex-wrap items-center gap-x-2 text-xs">
          {change !== null ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                change > 0 && "text-success",
                change < 0 && "text-danger",
                change === 0 && "text-muted-foreground",
              )}
            >
              <TrendIcon className="size-3" aria-hidden />
              {change > 0 ? "+" : ""}
              {change.toFixed(0)}%
              <span className="font-normal text-muted-foreground">vs previous</span>
            </span>
          ) : null}

          {/*
           * "Missing" is not "zero". Meta declines to report some metrics, and
           * a total that quietly omits them would understate the truth while
           * looking authoritative.
           */}
          {noPriorActivity ? (
            <span className="text-muted-foreground">no activity in the previous period</span>
          ) : null}

          {notReported && notReported > 0 ? (
            <span className="text-muted-foreground">{notReported} not reported</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );

  return href ? (
    <Link
      href={href}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {body}
    </Link>
  ) : (
    body
  );
}

/** Pull a displayable number out of a MetricTotal. */
export function totalOf(metric: MetricTotal): number | null {
  return metric.total;
}

/**
 * One way of showing a piece of content, wherever it appears.
 *
 * Posts have a message and videos have a title; both are shown the same way so
 * a mixed list reads as one list. The type icon carries the distinction, and
 * the Facebook link is separate from the detail link — they go to different
 * places and merging them loses one of them.
 */
export function ContentPreview({
  contentType,
  preview,
  permalinkUrl,
  streamerName,
}: {
  contentType: "post" | "video";
  preview: string | null;
  permalinkUrl: string | null;
  streamerName?: string | null;
}) {
  const Icon = contentType === "video" ? Video : FileText;
  const text = preview?.trim();

  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="line-clamp-2 text-sm">
          {text || <span className="text-muted-foreground italic">No text</span>}
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {streamerName ? <span className="truncate">{streamerName}</span> : null}
          {permalinkUrl ? (
            <a
              href={permalinkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Facebook
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Recent content: a table on desktop, cards on mobile, one data source. */
export function RecentContent({ rows }: { rows: RecentContentRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No content in this period"
        description="Nothing was published in the selected window, or the filters exclude it."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/posts">Browse all posts</Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      {/* Mobile: cards, so nothing scrolls sideways. */}
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={`${row.contentType}-${row.id}`}>
            <Card>
              <CardContent className="space-y-3 p-4">
                <ContentPreview
                  contentType={row.contentType}
                  preview={row.preview}
                  permalinkUrl={row.permalinkUrl}
                  streamerName={row.streamerName}
                />
                <dl className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <div>
                    <dt>Reactions</dt>
                    <dd className="text-foreground tabular-nums">{fmt(row.reactions)}</dd>
                  </div>
                  <div>
                    <dt>Comments</dt>
                    <dd className="text-foreground tabular-nums">{fmt(row.comments)}</dd>
                  </div>
                  <div>
                    <dt>Shares</dt>
                    <dd className="text-foreground tabular-nums">{fmt(row.shares)}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge domain="sentiment" status={row.sentiment ?? "no_comments"} />
                  {row.summaryStatus ? (
                    <StatusBadge domain="ai" status={row.summaryStatus} />
                  ) : null}
                  <Button asChild variant="ghost" size="sm" className="ml-auto">
                    <Link href={`/${row.contentType}s/${row.id}`}>Open</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {/* Desktop: a real table. */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Most recent posts and videos</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                Content
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Reactions
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Comments
              </th>
              {/* Shares drop out first on a narrow desktop; it is the least asked-for figure. */}
              <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                Shares
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Sentiment
              </th>
              <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">
                Summary
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.contentType}-${row.id}`}
                className="border-b last:border-0 hover:bg-muted/40"
              >
                <td className="max-w-sm py-3 pr-3">
                  <ContentPreview
                    contentType={row.contentType}
                    preview={row.preview}
                    permalinkUrl={row.permalinkUrl}
                    streamerName={row.streamerName}
                  />
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt(row.reactions)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmt(row.comments)}</td>
                <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
                  {fmt(row.shares)}
                </td>
                <td className="px-3 py-3">
                  <StatusBadge domain="sentiment" status={row.sentiment ?? "no_comments"} />
                </td>
                <td className="hidden px-3 py-3 xl:table-cell">
                  {row.summaryStatus ? <StatusBadge domain="ai" status={row.summaryStatus} /> : "—"}
                </td>
                <td className="py-3 pl-3 text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/${row.contentType}s/${row.id}`}>
                      Open<span className="sr-only"> details</span>
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** An absent figure renders as a dash, never as zero. */
function fmt(value: number | null): string {
  return value === null ? "—" : numberFormat.format(value);
}

const SEVERITY_STYLE = {
  high: "border-danger/40 bg-danger-subtle/30",
  medium: "border-warning/40 bg-warning-subtle/25",
  low: "border-border",
} as const;

/**
 * Urgent issues, ranked but not uniformly alarming.
 *
 * Severity comes from what was found — negative sentiment plus multiple
 * findings — so a Low issue looks calm. If everything rendered as High the
 * section would stop being a priority list and become a wall of red that
 * people learn to skip.
 */
export function UrgentIssues({ issues }: { issues: UrgentIssueRow[] }) {
  if (issues.length === 0) {
    return (
      <EmptyState
        title="No urgent issues detected"
        description="No significant urgent issues were found in the selected period."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {issues.map((issue) => {
        const severity = severityOf(issue);

        return (
          <li key={issue.summaryId}>
            <Card className={cn("shadow-none", SEVERITY_STYLE[severity])}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-xs font-medium",
                      severity === "high" && "border-danger/40 text-danger-foreground",
                      severity === "medium" && "border-warning/40 text-warning-foreground",
                      severity === "low" && "text-muted-foreground",
                    )}
                  >
                    {SEVERITY_LABEL[severity]} severity
                  </span>
                  <StatusBadge domain="sentiment" status={issue.sentiment ?? "no_comments"} />
                  <span className="text-xs text-muted-foreground">
                    {issue.commentCount} comment{issue.commentCount === 1 ? "" : "s"}
                  </span>
                </div>

                <ContentPreview
                  contentType={issue.contentType}
                  preview={issue.preview}
                  permalinkUrl={null}
                  streamerName={issue.streamerName}
                />

                <ul className="space-y-1">
                  {issue.issues.map((finding) => (
                    <li key={finding} className="text-sm">
                      • {finding}
                    </li>
                  ))}
                </ul>

                {issue.contentId ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/${issue.contentType}s/${issue.contentId}`}>View details</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Token health as counts by status.
 *
 * Never a token value — this receives only counts, so there is nothing here
 * that could leak one even if the markup were wrong.
 */
export function TokenHealth({ counts, isAdmin }: { counts: TokenHealthCounts; isAdmin: boolean }) {
  const order = [
    "valid",
    "expiring",
    "expired",
    "missing_permission",
    "invalid",
    "unknown",
    "missing",
  ];
  const present = order.filter((status) => (counts[status] ?? 0) > 0);
  const needsAttention = present.some((status) => status !== "valid");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Token health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {present.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active streamers.</p>
        ) : (
          <ul className="space-y-2">
            {present.map((status) => (
              <li key={status} className="flex items-center justify-between gap-3">
                <StatusBadge domain="token" status={status} />
                <span className="text-sm font-medium tabular-nums">{counts[status]}</span>
              </li>
            ))}
          </ul>
        )}

        <Button
          asChild
          variant={needsAttention ? "default" : "outline"}
          size="sm"
          className="w-full"
        >
          <Link href={isAdmin ? "/admin/streamers" : "/streamers"}>
            {/*
             * Admins get the screen where a token can be replaced; viewers get
             * the read-only roster. The label says which, rather than offering
             * an action the reader cannot take.
             */}
            {isAdmin ? "Manage streamers" : "View streamers"}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Synchronisation health: counts, the newest runs, and a way into the history. */
export function SyncHealth({
  totals,
  recent,
}: {
  totals: { total: number; succeeded: number; partial: number; failed: number; running: number };
  recent: { id: string; status: string; startedAt: Date; completedAt: Date | null }[];
}) {
  const rows = [
    { status: "completed", label: "Successful", count: totals.succeeded },
    { status: "completed_with_errors", label: "With warnings", count: totals.partial },
    { status: "failed", label: "Failed", count: totals.failed },
    { status: "processing", label: "Running", count: totals.running },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Synchronisation health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.status} className="flex items-center justify-between gap-3">
              <StatusBadge domain="sync" status={row.status} />
              <span className="text-sm font-medium tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>

        {recent.length > 0 ? (
          <ul className="space-y-1 border-t pt-3">
            {recent.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-2 text-xs">
                <StatusBadge domain="sync" status={run.status} compact />
                {/*
                 * Was an unpinned `toLocaleString`, which resolved to the
                 * server's zone during SSR and the browser's after hydration —
                 * the same row rendering two different times within a second
                 * of itself, and neither matching the sync-logs page.
                 */}
                <span className="truncate text-muted-foreground">
                  {formatDateTime(run.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href="/admin/sync-logs">
            View sync history
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export { describeStatus };
