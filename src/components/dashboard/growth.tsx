import { Minus, TrendingDown, TrendingUp, Users } from "lucide-react";

import { FollowerChart, NewFollowsChart } from "@/components/dashboard/charts";
import { MetricCard, MetricGrid } from "@/components/data/metric-card";
import { EmptyState } from "@/components/layout/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PageGrowth } from "@/lib/repositories/page-growth";
import { formatDayLabel } from "@/lib/time/zone";

/**
 * Audience size and how it moved.
 *
 * ## Why the window is stated rather than assumed
 *
 * Meta serves a rolling thirty-day window, and collection started when this
 * feature did. A period reaching further back than either produces a figure
 * covering less than the filter asked for, and a change quoted over an unstated
 * window is not auditable — "+412" and "+412 since 8 July" are different
 * claims.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

function formatDay(iso: string | null): string {
  // A calendar day from Meta's own daily buckets, not an instant — so it is
  // labelled as given rather than converted into the display zone.
  return iso ? formatDayLabel(iso) : "—";
}

/** A signed figure, because "+7" and "7" say different things about a trend. */
function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${numberFormat.format(value)}`;
}

export function GrowthPanel({
  growth,
  title = "Audience growth",
  note,
}: {
  growth: PageGrowth;
  title?: string;
  /**
   * A caveat about what this panel does *not* honour.
   *
   * Followers belong to the Page, not to a post, so a filter that narrows
   * content cannot narrow them. Sitting silently beside filtered content
   * figures, these numbers would read as "this game's audience" — a claim Meta
   * never made and this data cannot support.
   */
  note?: string | undefined;
}) {
  if (growth.series.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" aria-hidden />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No audience figures for this period"
            description="Meta serves roughly thirty days of Page history. Widen the period, or wait for the next sync to collect it."
          />
        </CardContent>
      </Card>
    );
  }

  const rising = growth.change !== null && growth.change > 0;
  const falling = growth.change !== null && growth.change < 0;
  const TrendIcon = rising ? TrendingUp : falling ? TrendingDown : Minus;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>
          {/*
           * The covered window, not the requested one. They differ whenever the
           * period reaches past Meta's rolling history or past the day
           * collection started.
           */}
          {formatDay(growth.from)} to {formatDay(growth.to)}.{note ? ` ${note}` : null}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <MetricGrid>
          <MetricCard
            label="Followers"
            value={growth.followers === null ? "—" : numberFormat.format(growth.followers)}
            hint="Most recent figure in this window."
          />
          <MetricCard
            label="Change"
            value={growth.change === null ? "—" : signed(growth.change)}
            hint={
              growth.changePercent === null
                ? "Needs two days of history."
                : `${signed(Math.round(growth.changePercent * 1000) / 10)}% over the window.`
            }
            {...(rising ? { tone: "success" as const } : falling ? { tone: "danger" as const } : {})}
          />
          <MetricCard
            label="New follows"
            value={numberFormat.format(growth.newFollows)}
            /*
             * Not the same as Change, and the difference confuses everyone the
             * first time. Meta reports arrivals; departures are invisible on
             * this edge, so the two figures disagree by however many people
             * left.
             */
            hint="Arrivals only — unfollows are not reported, so this exceeds Change."
          />
        </MetricGrid>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <TrendIcon className="size-3.5" aria-hidden />
          {growth.change === null
            ? "Not enough history yet to show a trend."
            : rising
              ? "Growing over this window."
              : falling
                ? "Declining over this window."
                : "Flat over this window."}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Followers</p>
          <FollowerChart data={growth.series} />
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">New follows per day</p>
          <NewFollowsChart data={growth.series} />
        </div>
      </CardContent>
    </Card>
  );
}
