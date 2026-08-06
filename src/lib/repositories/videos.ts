import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import { getDb } from "@/lib/db";
import { gameClause } from "@/lib/db/game-filter";
import { commentSummaries, games, streamers, videoInsights, videos } from "@/lib/db/schema";
import type { SortState, VideoSortKey } from "@/lib/filters/sorting";
import type { NormalizedInsight } from "@/lib/meta/posts";
import type { NormalizedVideo } from "@/lib/meta/videos";

/**
 * Video and video-insight persistence.
 *
 * Mirrors `repositories/posts.ts` deliberately: the two content types differ in
 * their Graph edges and their metadata, not in how they are stored or read, so
 * keeping the shapes parallel means the UI and service layers can treat them
 * alike.
 */

export type VideoListItem = {
  id: string;
  facebookVideoId: string;
  streamerId: string;
  streamerCode: string;
  streamerName: string;
  title: string | null;
  description: string | null;
  lengthSeconds: number | null;
  createdTime: Date;
  permalinkUrl: string | null;
  lastSyncedAt: Date;
};

const LIST_COLUMNS = {
  id: videos.id,
  facebookVideoId: videos.facebookVideoId,
  streamerId: videos.streamerId,
  streamerCode: streamers.streamerCode,
  streamerName: streamers.streamerName,
  title: videos.title,
  description: videos.description,
  lengthSeconds: videos.lengthSeconds,
  createdTime: videos.createdTime,
  permalinkUrl: videos.permalinkUrl,
  lastSyncedAt: videos.lastSyncedAt,
} as const;

/** A row of the videos table. */
export type VideoTableItem = VideoListItem & {
  /** The game it is filed under. Null means no attribution was resolved. */
  gameName: string | null;
  /** `hashtag` or `streamer` — how that attribution was decided. */
  gameSource: string | null;
  /** How many insight metrics Meta actually returned for this video. */
  metricCount: number;
  sentiment: string | null;
  summaryStatus: string | null;
  storedCommentCount: number | null;
};

const metricCountExpression = sql<number>`(
  select count(*)::int from ${videoInsights} where ${videoInsights.videoId} = ${videos.id}
)`;

/** See the note on the same expression in `repositories/posts.ts`. */
const gameNameExpression = sql<string | null>`(
  select g.name from ${games} g where g.id = ${videos.gameId}
)`;

const TABLE_COLUMNS = {
  ...LIST_COLUMNS,
  gameName: gameNameExpression,
  gameSource: videos.gameSource,
  metricCount: metricCountExpression,
  sentiment: commentSummaries.sentiment,
  summaryStatus: commentSummaries.status,
  storedCommentCount: commentSummaries.commentCount,
} as const;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Upsert videos, keyed on `facebook_video_id`.
 *
 * `created_time` is never updated — a video's publication time does not change,
 * and letting it drift would corrupt ordering.
 */
export async function upsertVideos(params: {
  streamerId: string;
  videos: NormalizedVideo[];
}): Promise<{ written: number }> {
  if (params.videos.length === 0) return { written: 0 };

  const db = getDb();
  const now = new Date();

  const values = params.videos.map((video) => ({
    streamerId: params.streamerId,
    facebookVideoId: video.facebookVideoId,
    title: video.title,
    description: video.description,
    lengthSeconds: video.lengthSeconds,
    createdTime: video.createdTime,
    permalinkUrl: video.permalinkUrl,
    rawJson: video.raw,
    lastSyncedAt: now,
  }));

  const written = await db
    .insert(videos)
    .values(values)
    .onConflictDoUpdate({
      target: videos.facebookVideoId,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        lengthSeconds: sql`excluded.length_seconds`,
        permalinkUrl: sql`excluded.permalink_url`,
        rawJson: sql`excluded.raw_json`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      },
    })
    .returning({ id: videos.id });

  return { written: written.length };
}

/** Resolve internal ids for a set of Meta video ids. */
export async function mapFacebookVideoIds(
  facebookVideoIds: string[],
): Promise<Map<string, string>> {
  if (facebookVideoIds.length === 0) return new Map();

  const db = getDb();

  const rows = await db
    .select({ id: videos.id, facebookVideoId: videos.facebookVideoId })
    .from(videos)
    // See the note in `posts.ts#mapFacebookPostIds`: the `sql` template turns a
    // JS array into `ANY(($1, $2))`, which is a row constructor and not an
    // array. `inArray` binds a single array parameter correctly.
    .where(inArray(videos.facebookVideoId, facebookVideoIds));

  return new Map(rows.map((row) => [row.facebookVideoId, row.id]));
}

/**
 * Upsert insights for one video.
 *
 * The uniqueness key is an expression index over `coalesce(period, '')` and
 * `coalesce(end_time, 'epoch')`, which Drizzle's `onConflictDoUpdate` target
 * cannot express — hence the explicit conflict clause, as in `posts.ts`.
 *
 * `value_json` accepts any JSON shape: video metrics return scalars, breakdown
 * objects, arrays, and nested structures, and all of them round-trip intact.
 */
export async function upsertVideoInsights(params: {
  videoId: string;
  insights: NormalizedInsight[];
}): Promise<{ written: number }> {
  if (params.insights.length === 0) return { written: 0 };

  const db = getDb();
  const collectedAt = new Date();

  // ISO strings, not `Date` objects — see the note in
  // `posts.ts#upsertPostInsights`. A `Date` bound into a raw `sql` fragment
  // fails to serialise under `prepare: false` and takes the whole insert with
  // it.
  const rows = params.insights.map(
    (insight) => sql`(
      ${params.videoId}::uuid,
      ${insight.metricName},
      ${insight.period},
      ${insight.value === null || insight.value === undefined ? null : JSON.stringify(insight.value)}::jsonb,
      ${insight.endTime ? insight.endTime.toISOString() : null}::timestamptz,
      ${JSON.stringify(insight.raw)}::jsonb,
      ${collectedAt.toISOString()}::timestamptz
    )`,
  );

  await db.execute(sql`
    INSERT INTO ${videoInsights}
      (video_id, metric_name, period, value_json, end_time, raw_json, collected_at)
    VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (video_id, metric_name, coalesce(period, ''), coalesce(end_time, 'epoch'::timestamptz))
    DO UPDATE SET
      value_json   = excluded.value_json,
      raw_json     = excluded.raw_json,
      collected_at = excluded.collected_at
  `);

  return { written: params.insights.length };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ListVideosFilters = {
  streamerId?: string | undefined;
  /** A game id, or `ANY_GAME` / `UNFILED_GAME`. See `gameClause`. */
  gameId?: string | undefined;
  search?: string | undefined;
  from?: Date | null;
  to?: Date | null;
  sort?: SortState<VideoSortKey>;
  limit: number;
  offset: number;
};

/** Sort keys mapped to columns — see the note in `repositories/posts.ts`. */
const VIDEO_SORT_COLUMNS: Record<VideoSortKey, SQL | AnyColumn> = {
  createdTime: videos.createdTime,
  streamer: streamers.streamerCode,
  title: videos.title,
  length: videos.lengthSeconds,
  metrics: metricCountExpression,
  comments: commentSummaries.commentCount,
  sentiment: commentSummaries.sentiment,
  summaryStatus: commentSummaries.status,
};

const DEFAULT_VIDEO_SORT: SortState<VideoSortKey> = { key: "createdTime", direction: "desc" };

export async function listVideos(
  filters: ListVideosFilters,
): Promise<{ items: VideoTableItem[]; total: number }> {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filters.streamerId) conditions.push(eq(videos.streamerId, filters.streamerId));

  const game = gameClause(videos.gameId, filters.gameId);
  if (game) conditions.push(game);

  if (filters.from) conditions.push(gte(videos.createdTime, filters.from));
  if (filters.to) conditions.push(lte(videos.createdTime, filters.to));

  if (filters.search) {
    const term = `%${filters.search}%`;
    const match = or(
      ilike(videos.title, term),
      ilike(videos.description, term),
      ilike(videos.facebookVideoId, term),
      ilike(streamers.streamerName, term),
      ilike(streamers.streamerCode, term),
    );
    if (match) conditions.push(match);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const sort = filters.sort ?? DEFAULT_VIDEO_SORT;
  const column = VIDEO_SORT_COLUMNS[sort.key] ?? VIDEO_SORT_COLUMNS.createdTime;
  const ordering =
    sort.direction === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;

  const [items, totals] = await Promise.all([
    db
      .select(TABLE_COLUMNS)
      .from(videos)
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .leftJoin(commentSummaries, eq(commentSummaries.videoId, videos.id))
      .where(where)
      .orderBy(ordering, desc(videos.createdTime), asc(videos.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ value: count() })
      .from(videos)
      .innerJoin(streamers, eq(videos.streamerId, streamers.id))
      .where(where),
  ]);

  return { items, total: totals[0]?.value ?? 0 };
}

export type VideoInsightItem = {
  id: string;
  metricName: string;
  period: string | null;
  value: unknown;
  endTime: Date | null;
  collectedAt: Date;
};

export type VideoDetail = VideoListItem & {
  rawJson: unknown;
  insights: VideoInsightItem[];
};

export async function getVideoById(id: string): Promise<VideoDetail | null> {
  const db = getDb();

  const [video] = await db
    .select({ ...LIST_COLUMNS, rawJson: videos.rawJson })
    .from(videos)
    .innerJoin(streamers, eq(videos.streamerId, streamers.id))
    .where(eq(videos.id, id))
    .limit(1);

  if (!video) return null;

  const insights = await db
    .select({
      id: videoInsights.id,
      metricName: videoInsights.metricName,
      period: videoInsights.period,
      value: videoInsights.valueJson,
      endTime: videoInsights.endTime,
      collectedAt: videoInsights.collectedAt,
    })
    .from(videoInsights)
    .where(eq(videoInsights.videoId, id))
    .orderBy(videoInsights.metricName, desc(videoInsights.endTime));

  return { ...video, insights };
}

/**
 * The videos an automation sweep should refresh comments for.
 * Same bounding as `listRecentPostIdsForStreamer` — see the note there.
 */
export async function listRecentVideoIdsForStreamer(
  streamerId: string,
  limit: number,
): Promise<string[]> {
  const db = getDb();

  const rows = await db
    .select({ id: videos.id })
    .from(videos)
    .where(eq(videos.streamerId, streamerId))
    .orderBy(desc(videos.createdTime), asc(videos.id))
    .limit(limit);

  return rows.map((row) => row.id);
}

export async function countVideosForStreamer(streamerId: string): Promise<number> {
  const db = getDb();

  const [row] = await db
    .select({ value: count() })
    .from(videos)
    .where(eq(videos.streamerId, streamerId));

  return row?.value ?? 0;
}
