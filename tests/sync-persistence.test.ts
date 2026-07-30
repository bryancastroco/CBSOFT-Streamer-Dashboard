import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * Upsert and de-duplication semantics, against a real Postgres.
 *
 * These assertions live at the SQL level on purpose. "A re-sync updates rather
 * than duplicates" is a property of the `ON CONFLICT` clause and the unique
 * index behind it — not of the TypeScript that calls them — so testing it
 * through a mocked database would test the mock. PGlite runs the project's
 * actual migration files, so the indexes here are the indexes in production.
 *
 * This is the guarantee that keeps a nightly sweep from growing the tables
 * without bound: Meta re-returns the same posts, videos and comments on every
 * run, and every one of them has to land on the row that is already there.
 */

let db: PGlite;
let streamerId: string;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`Expected a row from: ${sql}`);
  return row;
}

beforeEach(async () => {
  // A clean roster per test. Cascades clear posts, videos, insights, comments
  // and summaries, so no test can see another's rows.
  await db.exec(`DELETE FROM streamers;`);

  const streamer = await one<{ id: string }>(
    `INSERT INTO streamers (streamer_code, streamer_name, page_id, page_name)
     VALUES ('CBS-TEST', 'Test Streamer', $1, 'Test Page') RETURNING id`,
    [FAKE_PAGE_ID],
  );
  streamerId = streamer.id;
});

/** The upsert `repositories/posts.ts` performs, in SQL. */
async function upsertPost(params: {
  facebookPostId: string;
  message: string;
  reactions: number | null;
  shares?: number | null;
}) {
  return one<{ id: string }>(
    `INSERT INTO posts (streamer_id, facebook_post_id, message, created_time,
                        reaction_count, share_count, raw_json)
     VALUES ($1, $2, $3, '2026-07-20T18:00:00Z', $4, $5, '{}'::jsonb)
     ON CONFLICT (facebook_post_id) DO UPDATE SET
       message = excluded.message,
       reaction_count = excluded.reaction_count,
       share_count = excluded.share_count,
       last_synced_at = now()
     RETURNING id`,
    [streamerId, params.facebookPostId, params.message, params.reactions, params.shares ?? null],
  );
}

describe("post upserts", () => {
  it("re-syncing the same post updates it rather than duplicating", async () => {
    const first = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_1`,
      message: "original",
      reactions: 10,
    });

    const second = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_1`,
      message: "edited",
      reactions: 42,
    });

    // Same row, updated in place — the internal id is stable, which is what
    // every foreign key from insights and comments depends on.
    expect(second.id).toBe(first.id);

    const { count } = await one<{ count: number }>(
      `SELECT count(*)::int FROM posts WHERE facebook_post_id = $1`,
      [`${FAKE_PAGE_ID}_1`],
    );
    expect(count).toBe(1);

    const post = await one<{ message: string; reaction_count: number }>(
      `SELECT message, reaction_count FROM posts WHERE id = $1`,
      [first.id],
    );
    expect(post.message).toBe("edited");
    expect(post.reaction_count).toBe(42);
  });

  it("never moves created_time, so ordering cannot drift", async () => {
    const post = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_2`,
      message: "a",
      reactions: 1,
    });
    const before = await one<{ created_time: Date }>(
      `SELECT created_time FROM posts WHERE id = $1`,
      [post.id],
    );

    await db.query(
      `INSERT INTO posts (streamer_id, facebook_post_id, message, created_time, raw_json)
       VALUES ($1, $2, 'b', '2020-01-01T00:00:00Z', '{}'::jsonb)
       ON CONFLICT (facebook_post_id) DO UPDATE SET message = excluded.message`,
      [streamerId, `${FAKE_PAGE_ID}_2`],
    );

    const after = await one<{ created_time: Date }>(
      `SELECT created_time FROM posts WHERE id = $1`,
      [post.id],
    );
    expect(new Date(after.created_time).toISOString()).toBe(
      new Date(before.created_time).toISOString(),
    );
  });

  it("keeps a null share count null rather than turning it into zero", async () => {
    // Meta omits `shares` entirely on a post with none. The column has no
    // default and the upsert must not invent one.
    const post = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_3`,
      message: "a",
      reactions: 5,
      shares: null,
    });

    const stored = await one<{ share_count: number | null }>(
      `SELECT share_count FROM posts WHERE id = $1`,
      [post.id],
    );
    expect(stored.share_count).toBeNull();
  });

  it("scopes uniqueness globally, not per streamer", async () => {
    // Meta's post id already contains the page id, so it is globally unique.
    // A second streamer claiming the same post id is a data error, not a
    // second row.
    const other = await one<{ id: string }>(
      `INSERT INTO streamers (streamer_code, streamer_name, page_id, page_name)
       VALUES ('CBS-OTHER', 'Other', '555000111222333', 'Other Page') RETURNING id`,
    );

    await upsertPost({ facebookPostId: `${FAKE_PAGE_ID}_4`, message: "a", reactions: 1 });

    await db.query(
      `INSERT INTO posts (streamer_id, facebook_post_id, message, created_time, raw_json)
       VALUES ($1, $2, 'b', '2026-07-20T18:00:00Z', '{}'::jsonb)
       ON CONFLICT (facebook_post_id) DO UPDATE SET
         streamer_id = excluded.streamer_id, message = excluded.message`,
      [other.id, `${FAKE_PAGE_ID}_4`],
    );

    const { count } = await one<{ count: number }>(
      `SELECT count(*)::int FROM posts WHERE facebook_post_id = $1`,
      [`${FAKE_PAGE_ID}_4`],
    );
    expect(count).toBe(1);
  });
});

describe("video upserts", () => {
  async function upsertVideo(facebookVideoId: string, title: string, length: number | null) {
    return one<{ id: string }>(
      `INSERT INTO videos (streamer_id, facebook_video_id, title, length_seconds,
                           created_time, raw_json)
       VALUES ($1, $2, $3, $4, '2026-07-20T20:00:00Z', '{}'::jsonb)
       ON CONFLICT (facebook_video_id) DO UPDATE SET
         title = excluded.title,
         length_seconds = excluded.length_seconds,
         last_synced_at = now()
       RETURNING id`,
      [streamerId, facebookVideoId, title, length],
    );
  }

  it("re-syncing the same video updates it rather than duplicating", async () => {
    const first = await upsertVideo(`${FAKE_PAGE_ID}_v1`, "original", 100);
    const second = await upsertVideo(`${FAKE_PAGE_ID}_v1`, "renamed", 200);

    expect(second.id).toBe(first.id);

    const stored = await one<{ title: string; length_seconds: number }>(
      `SELECT title, length_seconds FROM videos WHERE id = $1`,
      [first.id],
    );
    expect(stored.title).toBe("renamed");
    expect(stored.length_seconds).toBe(200);
  });

  it("stores fractional seconds without rounding", async () => {
    const video = await upsertVideo(`${FAKE_PAGE_ID}_v2`, "vod", 7325.5);

    const stored = await one<{ length_seconds: number }>(
      `SELECT length_seconds FROM videos WHERE id = $1`,
      [video.id],
    );
    expect(stored.length_seconds).toBe(7325.5);
  });

  it("refuses a negative length", async () => {
    await expect(upsertVideo(`${FAKE_PAGE_ID}_v3`, "vod", -1)).rejects.toThrow(
      /videos_length_non_negative_check/,
    );
  });
});

describe("insight upserts", () => {
  let postId: string;

  beforeEach(async () => {
    const post = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_i`,
      message: "a",
      reactions: 1,
    });
    postId = post.id;
  });

  /** The expression-index upsert `repositories/posts.ts` performs. */
  async function upsertInsight(
    metric: string,
    period: string | null,
    value: unknown,
    endTime: string | null,
  ) {
    await db.query(
      `INSERT INTO post_insights (post_id, metric_name, period, value_json, end_time, raw_json)
       VALUES ($1, $2, $3, $4::jsonb, $5, '{}'::jsonb)
       ON CONFLICT (post_id, metric_name, coalesce(period, ''), coalesce(end_time, 'epoch'::timestamptz))
       DO UPDATE SET value_json = excluded.value_json, collected_at = now()`,
      [postId, metric, period, JSON.stringify(value), endTime],
    );
  }

  it("refreshes a metric in place across re-syncs", async () => {
    await upsertInsight("post_impressions", "lifetime", 100, null);
    await upsertInsight("post_impressions", "lifetime", 250, null);

    const stored = await rows<{ value_json: number }>(
      `SELECT value_json FROM post_insights WHERE post_id = $1 AND metric_name = 'post_impressions'`,
      [postId],
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.value_json).toBe(250);
  });

  it("keeps a periodic series as separate rows, one per end_time", async () => {
    // Collapsing these would destroy the day-by-day series a trend chart needs.
    await upsertInsight("post_video_views", "day", 950, "2026-07-21T07:00:00Z");
    await upsertInsight("post_video_views", "day", 1120, "2026-07-22T07:00:00Z");

    const stored = await rows<{ value_json: number }>(
      `SELECT value_json FROM post_insights
       WHERE post_id = $1 AND metric_name = 'post_video_views' ORDER BY end_time`,
      [postId],
    );

    expect(stored.map((row) => row.value_json)).toEqual([950, 1120]);
  });

  it("treats a null period as one slot, so a re-sync does not accumulate", async () => {
    // The reason the index coalesces: NULL is not equal to NULL in a unique
    // index, so without the coalesce every re-sync would insert a new row.
    await upsertInsight("post_clicks", null, 5, null);
    await upsertInsight("post_clicks", null, 9, null);

    const stored = await rows<{ value_json: number }>(
      `SELECT value_json FROM post_insights WHERE post_id = $1 AND metric_name = 'post_clicks'`,
      [postId],
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.value_json).toBe(9);
  });

  it("stores every JSON shape Meta returns", async () => {
    await upsertInsight("m_number", "lifetime", 42, null);
    await upsertInsight("m_object", "lifetime", { like: 301, love: 88 }, null);
    await upsertInsight("m_array", "lifetime", [1, 0.9, 0.72], null);
    await upsertInsight("m_null", "lifetime", null, null);

    const stored = await rows<{ metric_name: string; value_json: unknown }>(
      `SELECT metric_name, value_json FROM post_insights WHERE post_id = $1
         AND metric_name LIKE 'm\\_%' ORDER BY metric_name`,
      [postId],
    );

    expect(stored.map((row) => row.value_json)).toEqual([
      [1, 0.9, 0.72],
      null,
      42,
      { like: 301, love: 88 },
    ]);
  });
});

describe("comment de-duplication", () => {
  let postId: string;

  beforeEach(async () => {
    const post = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_c`,
      message: "a",
      reactions: 1,
    });
    postId = post.id;
  });

  async function upsertComment(facebookCommentId: string, message: string, hash: string) {
    await db.query(
      `INSERT INTO comments (content_type, post_id, facebook_comment_id, message,
                             created_time, content_hash)
       VALUES ('post', $1, $2, $3, '2026-07-21T10:00:00Z', $4)
       ON CONFLICT (facebook_comment_id) DO UPDATE SET
         message = excluded.message,
         content_hash = excluded.content_hash,
         last_synced_at = now()`,
      [postId, facebookCommentId, message, hash],
    );
  }

  it("stores a comment at most once, however many times Meta returns it", async () => {
    // Meta re-returns every comment on every sync. This is what stops the
    // table growing by the whole comment set each night.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await upsertComment("c1", "great stream", "hash-1");
    }

    const { count } = await one<{ count: number }>(
      `SELECT count(*)::int FROM comments WHERE facebook_comment_id = 'c1'`,
    );
    expect(count).toBe(1);
  });

  it("updates the stored text when Meta reports an edit", async () => {
    await upsertComment("c2", "original", "hash-a");
    await upsertComment("c2", "edited", "hash-b");

    const stored = await one<{ message: string; content_hash: string }>(
      `SELECT message, content_hash FROM comments WHERE facebook_comment_id = 'c2'`,
    );

    expect(stored.message).toBe("edited");
    // The changed hash is what makes the summary regenerate.
    expect(stored.content_hash).toBe("hash-b");
  });

  it("has no column that could hold a commenter", async () => {
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'comments'`,
    );

    const names = columns.map((row) => row.column_name);
    for (const forbidden of ["from", "from_id", "from_name", "author", "author_id", "commenter"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("refuses a comment that claims two parents", async () => {
    const video = await one<{ id: string }>(
      `INSERT INTO videos (streamer_id, facebook_video_id, created_time, raw_json)
       VALUES ($1, 'v-dual', '2026-07-20T20:00:00Z', '{}'::jsonb) RETURNING id`,
      [streamerId],
    );

    await expect(
      db.query(
        `INSERT INTO comments (content_type, post_id, video_id, facebook_comment_id,
                               created_time, content_hash)
         VALUES ('post', $1, $2, 'c-dual', now(), 'h')`,
        [postId, video.id],
      ),
    ).rejects.toThrow(/comments_one_parent_check/);
  });
});

describe("summary uniqueness", () => {
  it("keeps exactly one current summary per content item", async () => {
    const post = await upsertPost({
      facebookPostId: `${FAKE_PAGE_ID}_s`,
      message: "a",
      reactions: 1,
    });

    // `comment_summaries_status_consistency_check` requires a `completed`
    // summary to carry summary text — a completed analysis with nothing in it
    // is not a completed analysis.
    await db.query(
      `INSERT INTO comment_summaries (content_type, post_id, source_hash, comment_count,
                                      status, summary)
       VALUES ('post', $1, 'h1', 10, 'completed', 'First analysis.')`,
      [post.id],
    );

    // Regenerating updates in place. A second row would make "the summary for
    // this post" ambiguous, and the Sheets upsert would flip between them.
    await db.query(
      `INSERT INTO comment_summaries (content_type, post_id, source_hash, comment_count,
                                      status, summary)
       VALUES ('post', $1, 'h2', 12, 'completed', 'Second analysis.')
       ON CONFLICT (post_id) WHERE post_id IS NOT NULL
       DO UPDATE SET source_hash = excluded.source_hash,
                     comment_count = excluded.comment_count,
                     summary = excluded.summary`,
      [post.id],
    );

    const stored = await rows<{ source_hash: string }>(
      `SELECT source_hash FROM comment_summaries WHERE post_id = $1`,
      [post.id],
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.source_hash).toBe("h2");
  });
});
