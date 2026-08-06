import "server-only";

import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { contentMetricsCurrent, posts, videos } from "@/lib/db/schema";
import { gameClause } from "@/lib/db/game-filter";
import { tsParam } from "@/lib/db/params";

import type { AggregatedMetric } from "@/lib/metrics/groups";
import {
  CANONICAL_METRIC_KEYS,
  type CanonicalMetricKey,
  type ContentApplicability,
  type MetricAvailability,
} from "@/lib/metrics/registry";

/**
 * Reads over `content_metrics_current`.
 *
 * The rollup service writes this table; nothing here does. Keeping the read
 * side separate means a page never resolves metrics on the fly — the numbers a
 * reader sees are the numbers that were stored, with the provenance that was
 * stored alongside them.
 */

/** One content item's canonical metrics, with the provenance of each. */
export type ContentMetrics = {
  values: Record<CanonicalMetricKey, number | null>;
  availability: Record<string, { status?: MetricAvailability; retained?: boolean } | undefined>;
  sourceMapping: Record<string, { metric?: string } | undefined>;
  interactionsIsCalculated: boolean;
  graphApiVersion: string;
  lastCollectedAt: Date;
};

function record(value: unknown): Record<string, never> {
  return typeof value === "object" && value !== null ? (value as Record<string, never>) : {};
}

const METRIC_COLUMNS = {
  reach: contentMetricsCurrent.reach,
  views: contentMetricsCurrent.views,
  viewers: contentMetricsCurrent.viewers,
  interactions: contentMetricsCurrent.interactions,
  likes: contentMetricsCurrent.likes,
  reactions: contentMetricsCurrent.reactions,
  comments: contentMetricsCurrent.comments,
  shares: contentMetricsCurrent.shares,
  watch_time: contentMetricsCurrent.watchTimeMs,
  average_play_time: contentMetricsCurrent.averagePlayTimeMs,
  three_second_views: contentMetricsCurrent.threeSecondViews,
  reels_plays: contentMetricsCurrent.reelsPlays,
} as const satisfies Record<CanonicalMetricKey, unknown>;

const SELECTION = {
  ...METRIC_COLUMNS,
  interactionsIsCalculated: contentMetricsCurrent.interactionsIsCalculated,
  availabilityJson: contentMetricsCurrent.availabilityJson,
  sourceMappingJson: contentMetricsCurrent.sourceMappingJson,
  graphApiVersion: contentMetricsCurrent.graphApiVersion,
  lastCollectedAt: contentMetricsCurrent.lastCollectedAt,
} as const;

type SelectedRow = {
  [K in keyof typeof SELECTION]: K extends "interactionsIsCalculated"
    ? boolean
    : K extends "graphApiVersion"
      ? string
      : K extends "lastCollectedAt"
        ? Date
        : K extends "availabilityJson" | "sourceMappingJson"
          ? unknown
          : number | null;
};

function shape(row: SelectedRow): ContentMetrics {
  return {
    values: {
      reach: row.reach,
      views: row.views,
      viewers: row.viewers,
      interactions: row.interactions,
      likes: row.likes,
      reactions: row.reactions,
      comments: row.comments,
      shares: row.shares,
      watch_time: row.watch_time,
      average_play_time: row.average_play_time,
      three_second_views: row.three_second_views,
      reels_plays: row.reels_plays,
    },
    availability: record(row.availabilityJson),
    sourceMapping: record(row.sourceMappingJson),
    interactionsIsCalculated: row.interactionsIsCalculated,
    graphApiVersion: row.graphApiVersion,
    lastCollectedAt: row.lastCollectedAt,
  };
}

/**
 * Canonical metrics for one post. Null when the rollup has not reached it.
 *
 * Null is a real state and the caller must handle it: content synced but not
 * yet rolled up has raw insights and no canonical row, and rendering zeroes
 * there would be a lie about a piece of content nobody has processed.
 */
export async function getPostMetrics(postId: string): Promise<ContentMetrics | null> {
  const db = getDb();

  const [row] = await db
    .select(SELECTION)
    .from(contentMetricsCurrent)
    .where(eq(contentMetricsCurrent.postId, postId))
    .limit(1);

  return row ? shape(row) : null;
}

export async function getVideoMetrics(videoId: string): Promise<ContentMetrics | null> {
  const db = getDb();

  const [row] = await db
    .select(SELECTION)
    .from(contentMetricsCurrent)
    .where(eq(contentMetricsCurrent.videoId, videoId))
    .limit(1);

  return row ? shape(row) : null;
}

/**
 * Which kind of content a stored row describes, for deciding what can apply.
 *
 * Read back from the stored availability rather than guessed: the rollup
 * already decided whether a post carries video, and re-deciding it here from
 * different evidence would let the detail page and the stored row disagree.
 */
export function applicabilityOf(metrics: ContentMetrics, contentType: "post" | "video"): ContentApplicability {
  if (contentType === "video") return "video";

  return metrics.availability["views"]?.status === "not_applicable" ? "post" : "video_post";
}

export type MetricTotals = {
  metrics: Record<CanonicalMetricKey, AggregatedMetric>;
  /** Content items in scope, whether or not any metric was reported. */
  contentCount: number;
  /** Items in scope with no canonical row at all — the rollup gap. */
  withoutMetrics: number;
};

/**
 * Just the bounds.
 *
 * Structurally satisfied by both `Period` and `ResolvedPeriod`, so a caller
 * hands over whichever it already holds without a conversion step that could
 * quietly shift a boundary by a day.
 */
export type MetricPeriod = { from: Date | null; to: Date | null };

export type MetricTotalsFilters = {
  streamerId?: string | undefined;
  /** A game id, or `ANY_GAME` / `UNFILED_GAME`. See `gameClause`. */
  gameId?: string | undefined;
  period?: MetricPeriod | undefined;
  /** Restrict to posts or to videos. Omit for both. */
  contentType?: "post" | "video" | undefined;
};

/**
 * Sums, counts and one weighted mean, in a single pass.
 *
 * Every metric returns both a total and the number of items that reported it.
 * A sum without its denominator is the most misleading figure this product can
 * produce: views summed over 121 of 1,626 posts reads as the roster's views
 * unless the coverage is shown beside it.
 *
 * Joins to the content table because the period filter is on publication time,
 * which lives there — `last_collected_at` is when we asked Meta, not when the
 * content went out, and filtering a date range by it would move items between
 * periods every time the rollup ran.
 */
export async function getMetricTotals(filters: MetricTotalsFilters): Promise<MetricTotals> {
  const db = getDb();

  const clauses: (SQL | undefined)[] = [];

  if (filters.streamerId) {
    clauses.push(eq(contentMetricsCurrent.streamerId, filters.streamerId));
  }
  if (filters.contentType) {
    clauses.push(eq(contentMetricsCurrent.contentType, filters.contentType));
  }

  /*
   * Publication time, from whichever content table the row points at. The
   * `tsParam` cast is required: postgres.js under `prepare: false` cannot
   * serialise a Date inside a template and throws ERR_INVALID_ARG_TYPE, taking
   * the whole statement with it.
   */
  const publishedAt = sql`coalesce(${posts.createdTime}, ${videos.createdTime})`;

  /*
   * Attribution likewise comes from whichever content row this metric belongs
   * to. `content_metrics_current` carries no `game_id` of its own — deliberately,
   * because attribution changes when a hashtag is edited and the rollup runs on
   * its own schedule. Reading it through the join means a re-filed post is
   * counted under its new game on the next render, not the next rollup.
   */
  const attributedGame = sql`coalesce(${posts.gameId}, ${videos.gameId})`;
  const game = gameClause(attributedGame, filters.gameId);
  if (game) clauses.push(game);

  if (filters.period?.from) {
    clauses.push(sql`${publishedAt} >= ${tsParam(filters.period.from)}::timestamptz`);
  }
  if (filters.period?.to) {
    clauses.push(sql`${publishedAt} <= ${tsParam(filters.period.to)}::timestamptz`);
  }

  const where = and(...clauses.filter((clause): clause is SQL => clause !== undefined));

  const sum = (column: AnyColumn) => sql<string | null>`sum(${column})`;
  const reported = (column: AnyColumn) => sql<number>`count(${column})::int`;

  /**
   * `applicable_<key>` for every canonical metric, derived from the registry.
   *
   * Generated rather than hand-listed so a metric added to the registry cannot
   * silently inherit a neighbour's denominator — which is exactly how
   * three-second views came to report coverage of 127 out of 121.
   */
  const applicableCounts = Object.fromEntries(
    CANONICAL_METRIC_KEYS.map((key) => [
      `applicable_${key}`,
      sql<number>`count(*) filter (
        where coalesce(
          ${contentMetricsCurrent.availabilityJson} -> ${key} ->> 'status',
          'unavailable'
        ) <> 'not_applicable'
      )::int`,
    ]),
  ) as Record<`applicable_${CanonicalMetricKey}`, SQL<number>>;

  const [row] = await db
    .select({
      contentCount: sql<number>`count(*)::int`,

      reachSum: sum(contentMetricsCurrent.reach),
      reachN: reported(contentMetricsCurrent.reach),
      viewsSum: sum(contentMetricsCurrent.views),
      viewsN: reported(contentMetricsCurrent.views),
      viewersSum: sum(contentMetricsCurrent.viewers),
      viewersN: reported(contentMetricsCurrent.viewers),
      interactionsSum: sum(contentMetricsCurrent.interactions),
      interactionsN: reported(contentMetricsCurrent.interactions),
      interactionsCalculated: sql<number>`count(*) filter (where ${contentMetricsCurrent.interactionsIsCalculated})::int`,
      likesSum: sum(contentMetricsCurrent.likes),
      likesN: reported(contentMetricsCurrent.likes),
      reactionsSum: sum(contentMetricsCurrent.reactions),
      reactionsN: reported(contentMetricsCurrent.reactions),
      commentsSum: sum(contentMetricsCurrent.comments),
      commentsN: reported(contentMetricsCurrent.comments),
      sharesSum: sum(contentMetricsCurrent.shares),
      sharesN: reported(contentMetricsCurrent.shares),
      watchSum: sum(contentMetricsCurrent.watchTimeMs),
      watchN: reported(contentMetricsCurrent.watchTimeMs),
      threeSecondSum: sum(contentMetricsCurrent.threeSecondViews),
      threeSecondN: reported(contentMetricsCurrent.threeSecondViews),
      reelsSum: sum(contentMetricsCurrent.reelsPlays),
      reelsN: reported(contentMetricsCurrent.reelsPlays),

      /*
       * The weighted mean, computed where both parts exist. Summing averages
       * would be arithmetic nonsense; a plain mean would give a video with nine
       * views the same weight as one with ninety thousand.
       */
      playTimeWeighted: sql<string | null>`
        sum(${contentMetricsCurrent.averagePlayTimeMs} * ${contentMetricsCurrent.views})
          filter (where ${contentMetricsCurrent.averagePlayTimeMs} is not null
                    and ${contentMetricsCurrent.views} is not null
                    and ${contentMetricsCurrent.views} > 0)`,
      playTimeWeight: sql<string | null>`
        sum(${contentMetricsCurrent.views})
          filter (where ${contentMetricsCurrent.averagePlayTimeMs} is not null
                    and ${contentMetricsCurrent.views} is not null
                    and ${contentMetricsCurrent.views} > 0)`,
      playTimeN: reported(contentMetricsCurrent.averagePlayTimeMs),

      /*
       * One applicability denominator per metric, read from that metric's own
       * availability entry.
       *
       * Sharing a denominator across a group looks reasonable and is wrong.
       * Running this against production reported "127 of 121" for three-second
       * views: it borrowed the `views` denominator, and `views` applies to
       * video posts while three-second views applies to video posts *and*
       * video objects. Six videos were counted in the numerator and excluded
       * from the denominator. Watch time was understated the same way — 81 of
       * 121 where the truth is 81 of 184.
       */
      ...applicableCounts,
    })
    .from(contentMetricsCurrent)
    .leftJoin(posts, eq(posts.id, contentMetricsCurrent.postId))
    .leftJoin(videos, eq(videos.id, contentMetricsCurrent.videoId))
    .where(where);

  const gap = await countContentWithoutMetrics(filters);

  const total = row?.contentCount ?? 0;
  const num = (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

  const build = (
    key: CanonicalMetricKey,
    value: number | null,
    reportedCount: number,
    applicable: number,
    calculated = false,
  ): AggregatedMetric => ({
    key,
    // Zero reporters means no measurement, not a total of zero.
    value: reportedCount === 0 ? null : value,
    reported: reportedCount,
    applicable,
    calculated,
  });

  /** Each metric's own denominator, never a neighbour's. */
  const applicable = (key: CanonicalMetricKey): number =>
    (row as Record<string, number> | undefined)?.[`applicable_${key}`] ?? 0;

  const weighted = num(row?.playTimeWeighted ?? null);
  const weight = num(row?.playTimeWeight ?? null);

  return {
    contentCount: total,
    withoutMetrics: gap,
    metrics: {
      reach: build("reach", num(row?.reachSum), row?.reachN ?? 0, applicable("reach")),
      views: build("views", num(row?.viewsSum), row?.viewsN ?? 0, applicable("views")),
      viewers: build("viewers", num(row?.viewersSum), row?.viewersN ?? 0, applicable("viewers")),
      interactions: build(
        "interactions",
        num(row?.interactionsSum),
        row?.interactionsN ?? 0,
        applicable("interactions"),
        /*
         * True when *any* item's interactions were derived. The total then
         * mixes measured and calculated figures, and calling the whole thing
         * calculated is the conservative reading — the alternative presents a
         * partly-derived number as if Meta had measured all of it.
         */
        (row?.interactionsCalculated ?? 0) > 0,
      ),
      likes: build("likes", num(row?.likesSum), row?.likesN ?? 0, applicable("likes")),
      reactions: build(
        "reactions",
        num(row?.reactionsSum),
        row?.reactionsN ?? 0,
        applicable("reactions"),
      ),
      comments: build("comments", num(row?.commentsSum), row?.commentsN ?? 0, applicable("comments")),
      shares: build("shares", num(row?.sharesSum), row?.sharesN ?? 0, applicable("shares")),
      watch_time: build(
        "watch_time",
        num(row?.watchSum),
        row?.watchN ?? 0,
        applicable("watch_time"),
      ),
      average_play_time: {
        key: "average_play_time",
        value: weighted !== null && weight !== null && weight > 0 ? weighted / weight : null,
        reported: row?.playTimeN ?? 0,
        applicable: applicable("average_play_time"),
        // Always. A roster-level average is derived however it is computed.
        calculated: true,
      },
      three_second_views: build(
        "three_second_views",
        num(row?.threeSecondSum),
        row?.threeSecondN ?? 0,
        applicable("three_second_views"),
      ),
      reels_plays: build(
        "reels_plays",
        num(row?.reelsSum),
        row?.reelsN ?? 0,
        applicable("reels_plays"),
      ),
    },
  };
}

/**
 * Content in scope that the rollup has not reached.
 *
 * Surfaced rather than hidden. A dashboard total silently computed over the
 * two-thirds of the roster that happened to be processed is the failure mode
 * this whole phase exists to prevent.
 */
export async function countContentWithoutMetrics(
  filters: MetricTotalsFilters,
): Promise<number> {
  const db = getDb();

  const missing = (table: typeof posts | typeof videos, join: AnyColumn) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(
        and(
          filters.streamerId ? eq(table.streamerId, filters.streamerId) : undefined,
          gameClause(table.gameId, filters.gameId),
          filters.period?.from
            ? sql`${table.createdTime} >= ${tsParam(filters.period.from)}::timestamptz`
            : undefined,
          filters.period?.to
            ? sql`${table.createdTime} <= ${tsParam(filters.period.to)}::timestamptz`
            : undefined,
          sql`not exists (
            select 1 from ${contentMetricsCurrent} where ${join} = ${table.id}
          )`,
        ),
      );

  const [postGap, videoGap] = await Promise.all([
    filters.contentType === "video"
      ? Promise.resolve([{ n: 0 }])
      : missing(posts, contentMetricsCurrent.postId),
    filters.contentType === "post"
      ? Promise.resolve([{ n: 0 }])
      : missing(videos, contentMetricsCurrent.videoId),
  ]);

  return (postGap[0]?.n ?? 0) + (videoGap[0]?.n ?? 0);
}
