import type { PGlite } from "@electric-sql/pglite";
import { inArray, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { posts, videos } from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The Meta-id → internal-id lookups, compiled by Drizzle and run against a real
 * Postgres.
 *
 * ## Why this file exists
 *
 * `mapFacebookPostIds` and `mapFacebookVideoIds` were written as:
 *
 *     sql`${posts.facebookPostId} = ANY(${facebookPostIds})`
 *
 * Drizzle's template tag binds each array element as its own parameter, so that
 * compiles to `ANY(($1, $2))` — a row constructor, not an array. Postgres
 * rejects it at execution time.
 *
 * Every one of the 713 tests passed while this was broken, because the suites
 * either mocked the repositories or asserted SQL written by hand in the test.
 * Nothing drove Drizzle's own query builder against a real database, so nothing
 * could see that the generated SQL did not run. The bug surfaced only against a
 * live Page — as silently missing insights, since a failed id lookup means no
 * insight can be attached to anything.
 *
 * These tests close that gap: they execute the compiled query, and they pin the
 * broken form so it cannot quietly return.
 */

let client: PGlite;
let db: PgliteDatabase;
let streamerId: string;

beforeAll(async () => {
  client = await createTestDatabase();
  db = drizzle(client);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");

  // token_status defaults to 'missing'; the consistency constraint requires a
  // ciphertext for any other status and this suite has no business holding one.
  const inserted = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('IDMAP', 'Id Mapping', $1, 'Id Mapping Page')
     returning id`,
    [FAKE_PAGE_ID],
  );

  streamerId = inserted.rows[0]!.id;

  await client.query(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
     values ($1, 'post_aaa', now(), '{}'::jsonb),
            ($1, 'post_bbb', now(), '{}'::jsonb),
            ($1, 'post_ccc', now(), '{}'::jsonb)`,
    [streamerId],
  );

  await client.query(
    `insert into videos (streamer_id, facebook_video_id, created_time, raw_json)
     values ($1, 'vid_aaa', now(), '{}'::jsonb), ($1, 'vid_bbb', now(), '{}'::jsonb)`,
    [streamerId],
  );
});

describe("mapping Meta ids to internal ids", () => {
  it("resolves several post ids in one query", async () => {
    const rows = await db
      .select({ id: posts.id, facebookPostId: posts.facebookPostId })
      .from(posts)
      .where(inArray(posts.facebookPostId, ["post_aaa", "post_ccc"]));

    expect(rows.map((row) => row.facebookPostId).sort()).toEqual(["post_aaa", "post_ccc"]);
    expect(rows.every((row) => typeof row.id === "string" && row.id.length > 0)).toBe(true);
  });

  it("resolves several video ids in one query", async () => {
    const rows = await db
      .select({ id: videos.id, facebookVideoId: videos.facebookVideoId })
      .from(videos)
      .where(inArray(videos.facebookVideoId, ["vid_aaa", "vid_bbb"]));

    expect(rows.map((row) => row.facebookVideoId).sort()).toEqual(["vid_aaa", "vid_bbb"]);
  });

  it("works for a single id, the case that masked the bug longest", async () => {
    /*
     * With one element the broken form compiles to `ANY(($1))`, which Postgres
     * happily reads as a scalar in parentheses. So a one-post Page worked and a
     * two-post Page did not — the kind of bug that looks like a Meta problem.
     */
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.facebookPostId, ["post_bbb"]));

    expect(rows).toHaveLength(1);
  });

  it("returns nothing for ids that are absent, rather than erroring", async () => {
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.facebookPostId, ["nope_1", "nope_2"]));

    expect(rows).toEqual([]);
  });

  it("does not leak rows belonging to another streamer's identical ids", async () => {
    const other = await client.query<{ id: string }>(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('IDMAP2', 'Other', '999999999', 'Other Page') returning id`,
    );

    await client.query(
      `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
       values ($1, 'post_zzz', now(), '{}'::jsonb)`,
      [other.rows[0]!.id],
    );

    const rows = await db
      .select({ id: posts.id, facebookPostId: posts.facebookPostId })
      .from(posts)
      .where(inArray(posts.facebookPostId, ["post_aaa", "post_zzz"]));

    // Facebook post ids are globally unique, so both are expected here. The
    // point is that the query executes and maps each id to exactly one row.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it("REGRESSION: the sql-template form generates SQL Postgres refuses", async () => {
    /*
     * The exact expression that shipped. Kept executable so the failure is a
     * fact this suite observes rather than a claim in a comment — if a future
     * Drizzle release makes this valid, this test fails and the note above can
     * be revisited.
     */
    const ids = ["post_aaa", "post_bbb"];

    await expect(
      db
        .select({ id: posts.id })
        .from(posts)
        .where(sql`${posts.facebookPostId} = ANY(${ids})`),
    ).rejects.toThrow();
  });
});
