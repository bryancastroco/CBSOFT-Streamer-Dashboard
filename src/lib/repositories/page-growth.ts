import "server-only";

import { and, asc, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { pageMetricsDaily } from "@/lib/db/schema";

/**
 * Audience growth over a period.
 *
 * ## Why growth is measured from the *stored* endpoints, not the filter dates
 *
 * A period can start before collection did, or land on a day Meta did not
 * report. Anchoring to the requested dates would then compare a real figure
 * against nothing and call the result a hundred-percent gain.
 *
 * So the window is resolved to the first and last day that actually carry a
 * follower count, and both dates are returned. A card that says "+412 since 8
 * July" is auditable; one that says "+412" over an unstated window is not.
 */

export type GrowthPoint = {
  date: string;
  followers: number | null;
  newFollows: number | null;
};

export type PageGrowth = {
  /** Most recent known follower count in the window. */
  followers: number | null;
  /** Change across the window. Null when fewer than two days carry a count. */
  change: number | null;
  /** Change as a fraction of the starting figure, or null when it was zero. */
  changePercent: number | null;
  /** Follows gained, summed. Not the same as `change` — see the migration. */
  newFollows: number;
  /** The days actually covered, which may be narrower than the filter asked. */
  from: string | null;
  to: string | null;
  series: GrowthPoint[];
};

const EMPTY: PageGrowth = {
  followers: null,
  change: null,
  changePercent: null,
  newFollows: 0,
  from: null,
  to: null,
  series: [],
};

function windowClauses(params: {
  streamerId?: string | undefined;
  from?: Date | null;
  to?: Date | null;
}): SQL[] {
  const clauses: SQL[] = [];

  if (params.streamerId) clauses.push(eq(pageMetricsDaily.streamerId, params.streamerId));

  // Compared as dates, because the column is a date. Passing a timestamp would
  // exclude the final day for any period whose bound is mid-afternoon.
  if (params.from) clauses.push(gte(pageMetricsDaily.metricDate, isoDate(params.from)));
  if (params.to) clauses.push(lte(pageMetricsDaily.metricDate, isoDate(params.to)));

  return clauses;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * One streamer's growth across a window.
 *
 * Returns the full daily series as well as the summary, because the shape of
 * the line is the point — a flat month and a month that rose then collapsed
 * produce the same single number.
 */
export async function getPageGrowth(params: {
  streamerId: string;
  from?: Date | null;
  to?: Date | null;
}): Promise<PageGrowth> {
  const db = getDb();

  const rows = await db
    .select({
      date: pageMetricsDaily.metricDate,
      followers: pageMetricsDaily.followers,
      newFollows: pageMetricsDaily.newFollows,
    })
    .from(pageMetricsDaily)
    .where(and(...windowClauses(params)))
    .orderBy(asc(pageMetricsDaily.metricDate));

  if (rows.length === 0) return EMPTY;

  const series: GrowthPoint[] = rows.map((row) => ({
    date: row.date,
    followers: row.followers,
    newFollows: row.newFollows,
  }));

  // The endpoints that carry a count, which may sit inside the window rather
  // than at its edges.
  const counted = series.filter((point) => point.followers !== null);
  const first = counted[0];
  const last = counted.at(-1);

  const newFollows = series.reduce((total, point) => total + (point.newFollows ?? 0), 0);

  if (!first || !last || first.followers === null || last.followers === null) {
    return { ...EMPTY, newFollows, series };
  }

  const change = counted.length > 1 ? last.followers - first.followers : null;

  return {
    followers: last.followers,
    change,
    /*
     * Null rather than Infinity when the window starts at zero followers.
     * "Grew by ∞%" is not a fact anybody can act on, and a Page genuinely at
     * zero is a new Page rather than an error.
     */
    changePercent:
      change !== null && first.followers > 0 ? change / first.followers : null,
    newFollows,
    from: first.date,
    to: last.date,
    series,
  };
}

/**
 * Roster-wide totals for a window.
 *
 * Followers are summed across streamers, which is the right aggregate for
 * "audience reached" and the wrong one for "how many people" — the same person
 * following two Pages counts twice. Meta gives no way to deduplicate across
 * Pages, so the figure is what it is; the label on screen says "combined".
 */
export async function getRosterGrowth(params: {
  from?: Date | null;
  to?: Date | null;
}): Promise<{ followers: number | null; change: number | null; newFollows: number }> {
  const db = getDb();

  const rows = await db
    .select({
      date: pageMetricsDaily.metricDate,
      followers: sql<number>`sum(${pageMetricsDaily.followers})::int`,
      newFollows: sql<number>`coalesce(sum(${pageMetricsDaily.newFollows}), 0)::int`,
    })
    .from(pageMetricsDaily)
    .where(and(isNotNull(pageMetricsDaily.followers), ...windowClauses(params)))
    .groupBy(pageMetricsDaily.metricDate)
    .orderBy(asc(pageMetricsDaily.metricDate));

  if (rows.length === 0) return { followers: null, change: null, newFollows: 0 };

  const first = rows[0]!;
  const last = rows.at(-1)!;
  const newFollows = rows.reduce((total, row) => total + row.newFollows, 0);

  return {
    followers: last.followers,
    change: rows.length > 1 ? last.followers - first.followers : null,
    newFollows,
  };
}
