import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeaderboardMetric, StreamerTotals } from "@/lib/ui/dashboard-shapes";
import { cn } from "@/lib/utils";

/**
 * Who leads on each metric.
 *
 * Replaced an engagement time series and a single "top streamers" bar chart.
 * The chart ranked on reactions + comments + shares added together, which is
 * three units summed into a number that is not any of them — and it was the
 * only ranking on the page, so a streamer strong on views or on broadcasts was
 * invisible.
 *
 * ## Why bars and not numbers alone
 *
 * A leaderboard's question is "by how much", not "in what order". The order is
 * readable from a list; the gap between first and second is not, and that gap
 * is usually the finding. Each bar is drawn against the leader rather than an
 * axis, so the comparison is to the top of that list and nothing else.
 */

const numberFormat = new Intl.NumberFormat("en-GB");

type BoardSpec = {
  metric: LeaderboardMetric;
  title: string;
  hint: string;
  /**
   * Whether a value below zero is a real answer rather than an absence.
   *
   * True only for follower growth. Everything else is a count or a sum that
   * cannot go negative, so a zero there means "nothing happened" and the row is
   * better left out than listed on nil.
   */
  signed?: boolean;
};

/** Every board on the dashboard, in reading order. */
export const LEADERBOARDS: BoardSpec[] = [
  {
    metric: "followerGrowth",
    title: "Follower growth",
    hint: "Net change across the period. Followers belong to the Page, so the game and content filters do not narrow this.",
    signed: true,
  },
  { metric: "postCount", title: "Posts", hint: "Posts published in this period." },
  { metric: "videoCount", title: "Videos", hint: "Uploads and reels, excluding broadcasts." },
  { metric: "livestreamCount", title: "Livestreams", hint: "Broadcasts that ended in this period." },
  {
    metric: "views",
    title: "Views",
    hint: "The one figure here that includes video performance — everything else comes from posts.",
  },
  { metric: "reactions", title: "Reactions", hint: "Summed across posts that reported a figure." },
  { metric: "comments", title: "Comments", hint: "As Meta reports them on each post." },
  { metric: "shares", title: "Shares", hint: "Posts reporting no shares are excluded, not zeroed." },
];

function Board({
  title,
  hint,
  metric,
  signed = false,
  totals,
  limit,
}: BoardSpec & { totals: readonly StreamerTotals[]; limit: number }) {
  /*
   * Sorted here rather than in SQL. Seven queries each taking their own top few
   * would disagree about who exists — a streamer scoring on views and not on
   * shares would appear in one list and be missing from the other for a reason
   * no reader could see.
   */
  const ranked = [...totals]
    .filter((row) => (signed ? row[metric] !== 0 : row[metric] > 0))
    .sort((a, b) => b[metric] - a[metric] || a.streamerName.localeCompare(b.streamerName))
    .slice(0, limit);

  /*
   * The bar is scaled to the largest *gain*, not the largest magnitude. A Page
   * that shed two hundred followers is not the leader of a growth board, and
   * scaling to it would draw the decline as the longest bar on the card.
   */
  const leader = Math.max(0, ...ranked.map((row) => row[metric]));

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {ranked.length === 0 ? (
          /*
           * "Nothing yet" rather than a list of zeroes. A board showing every
           * streamer on 0 implies a ranking exists and they are tied, when in
           * fact nothing has been measured.
           */
          <p className="text-xs text-muted-foreground">No {title.toLowerCase()} in this period.</p>
        ) : (
          <ol className="space-y-2">
            {ranked.map((row, index) => (
              <li key={row.streamerId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <Link
                    href={`/streamers/${row.streamerId}`}
                    className="min-w-0 truncate underline-offset-4 hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">{index + 1}.</span>{" "}
                    {row.streamerName}
                  </Link>
                  <span
                    className={cn(
                      "shrink-0 font-medium tabular-nums",
                      // Only where the sign carries meaning. Colouring a post
                      // count green would imply a judgement about it.
                      signed && row[metric] > 0 && "text-success",
                      signed && row[metric] < 0 && "text-danger",
                    )}
                  >
                    {signed && row[metric] > 0 ? "+" : ""}
                    {numberFormat.format(row[metric])}
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                  // Against the leader, not an axis: the comparison a
                  // leaderboard invites is with the top of its own list.
                  aria-hidden
                >
                  <div
                    className="h-full rounded-full bg-[var(--chart-1)]"
                    style={{
                      // A decline draws nothing. There is no honest length for
                      // it on a bar that starts at the left edge.
                      width: `${leader > 0 && row[metric] > 0 ? Math.max(4, (row[metric] / leader) * 100) : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}

        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function StreamerLeaderboards({
  totals,
  limit = 5,
}: {
  totals: readonly StreamerTotals[];
  limit?: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {LEADERBOARDS.map((board) => (
        <Board key={board.metric} {...board} totals={totals} limit={limit} />
      ))}
    </div>
  );
}
