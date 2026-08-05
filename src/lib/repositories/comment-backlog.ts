import "server-only";

import { and, desc, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { ContentRef } from "@/lib/comments/content-ref";
import { getDb } from "@/lib/db";
import { resultRows } from "@/lib/db/params";
import { posts, videos } from "@/lib/db/schema";

/**
 * What the unattended backfill still has to do.
 *
 * ## Two queues, not one
 *
 * "Every post has an analysis" decomposes into two backlogs bounded by two
 * different scarce resources, and conflating them produces a drain that runs at
 * the speed of the slower one:
 *
 *   collection — items whose comments edge has never been walked. Bounded by
 *                Meta Graph quota. This is the large queue: one walk per item.
 *   analysis   — items that have comments but no usable summary. Bounded by the
 *                AI provider's requests per minute. Much smaller, because most
 *                content carries no comments at all and never reaches it.
 *
 * ## Claiming order
 *
 * Newest content first, in both queues. A drain that runs oldest-first spends
 * its first several nights on posts nobody is looking at, and the roster's most
 * recent content — the part someone might actually open tomorrow — waits until
 * the very end. Newest-first means every run makes the dashboard more complete
 * where it is being read.
 */

export type BacklogItem = ContentRef & {
  streamerId: string;
  /** For logging and the run summary. Never a token, never a message. */
  facebookId: string;
};

/**
 * Content whose comments have never been collected.
 *
 * `comments_synced_at IS NULL` is the whole predicate, and it is why migration
 * 0014 exists. The obvious alternative — "has no rows in `comments`" — cannot
 * distinguish a post that was never looked at from one that was looked at and
 * genuinely has no comments, so it would re-walk every silent post on every run
 * and never advance past them.
 *
 * Only streamers with a usable Page token are considered. Handing back an item
 * whose streamer has no token produces a `no_token` outcome that consumes a
 * slot in the run's budget and achieves nothing.
 */
export async function listContentAwaitingCollection(limit: number): Promise<BacklogItem[]> {
  const db = getDb();

  const [postRows, videoRows] = await Promise.all([
    db
      .select({ id: posts.id, streamerId: posts.streamerId, facebookId: posts.facebookPostId })
      .from(posts)
      .where(and(isNull(posts.commentsSyncedAt), collectableStreamer(posts.streamerId)))
      .orderBy(desc(posts.createdTime))
      .limit(limit),
    db
      .select({ id: videos.id, streamerId: videos.streamerId, facebookId: videos.facebookVideoId })
      .from(videos)
      .where(and(isNull(videos.commentsSyncedAt), collectableStreamer(videos.streamerId)))
      .orderBy(desc(videos.createdTime))
      .limit(limit),
  ]);

  /*
   * Videos first, then posts, and the whole thing re-cut to `limit`.
   *
   * There are two orders of magnitude fewer videos than posts here, so
   * interleaving by date would let the post queue starve the video one for
   * days. Videos are also the more expensive content to have missing from a
   * report, being the smaller and more scrutinised set.
   */
  return [
    ...videoRows.map((row) => ({ type: "video" as const, ...row })),
    ...postRows.map((row) => ({ type: "post" as const, ...row })),
  ].slice(0, limit);
}

/**
 * Content that has comments but nothing usable to show for them.
 *
 * Deliberately a coarse filter. Whether the *stored* summary still matches the
 * *current* comments is a hash comparison, and the hash is computed over the
 * comment text — not something SQL can answer without reading every comment
 * back. `syncContentComments` re-checks it anyway and returns `unchanged`
 * without spending anything, so a row picked up here that turns out to be
 * current costs one cheap read rather than a model call.
 *
 * What this must not do is miss work. So it claims anything without a summary
 * in a settled state: no row at all, `failed`, `pending`, or a `processing` row
 * left behind by an invocation that was killed mid-analysis.
 */
export async function listContentAwaitingAnalysis(limit: number): Promise<BacklogItem[]> {
  const db = getDb();

  const rows = await db.execute<{
    content_type: "post" | "video";
    id: string;
    streamer_id: string;
    facebook_id: string;
  }>(sql`
    select 'video' as content_type, v.id, v.streamer_id, v.facebook_video_id as facebook_id,
           v.created_time
      from videos v
     where exists (select 1 from comments c where c.video_id = v.id)
       and not exists (
             select 1 from comment_summaries s
              where s.video_id = v.id and s.status in ('completed', 'no_comments'))
    union all
    select 'post' as content_type, p.id, p.streamer_id, p.facebook_post_id as facebook_id,
           p.created_time
      from posts p
     where exists (select 1 from comments c where c.post_id = p.id)
       and not exists (
             select 1 from comment_summaries s
              where s.post_id = p.id and s.status in ('completed', 'no_comments'))
     order by content_type asc, created_time desc
     limit ${limit}
  `);

  return resultRows<{
    content_type: "post" | "video";
    id: string;
    streamer_id: string;
    facebook_id: string;
  }>(rows).map((row) => ({
    type: row.content_type,
    id: row.id,
    streamerId: row.streamer_id,
    facebookId: row.facebook_id,
  }));
}

/**
 * How much is left, counted rather than inferred.
 *
 * The one number that answers "is this actually finished", independently of
 * what any individual run reported. Cheap — both halves are index-only against
 * the partial indexes added in 0014.
 */
export async function countCommentBacklog(): Promise<{
  awaitingCollection: number;
  awaitingAnalysis: number;
}> {
  const db = getDb();

  const collection = await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from posts where comments_synced_at is null)
      + (select count(*) from videos where comments_synced_at is null)
    )::int as n
  `);

  const analysis = await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from posts p
        where exists (select 1 from comments c where c.post_id = p.id)
          and not exists (select 1 from comment_summaries s
                           where s.post_id = p.id and s.status in ('completed', 'no_comments')))
      + (select count(*) from videos v
          where exists (select 1 from comments c where c.video_id = v.id)
            and not exists (select 1 from comment_summaries s
                             where s.video_id = v.id and s.status in ('completed', 'no_comments')))
    )::int as n
  `);

  return {
    awaitingCollection: resultRows<{ n: number }>(collection)[0]?.n ?? 0,
    awaitingAnalysis: resultRows<{ n: number }>(analysis)[0]?.n ?? 0,
  };
}

/**
 * Streamers worth spending a Graph call on: active, undeleted, holding a token.
 *
 * Mirrors `listSyncableStreamers`. Expressed as a correlated EXISTS rather than
 * a join so the caller's `limit` still means "items", not "rows after a fan-out".
 *
 * Presence is read from `page_token_last_four`, never from the ciphertext
 * column. `streamers_token_consistency_check` guarantees the two travel
 * together, so the answer is identical — and the masked column is the one it is
 * safe for the rest of the codebase to name. `tests/token-containment.test.ts`
 * enforces that boundary, and it caught this line.
 */
function collectableStreamer(column: PgColumn) {
  return sql`exists (
    select 1 from streamers s
     where s.id = ${column}
       and s.active = true
       and s.deleted_at is null
       and s.page_token_last_four is not null
  )`;
}

/** Narrow a backlog row to the ref the sync service takes. */
export function toContentRef(item: BacklogItem): ContentRef {
  return { type: item.type, id: item.id };
}
