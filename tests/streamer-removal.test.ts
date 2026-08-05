import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { purgeConfirmationFor } from "@/lib/validation/streamers";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The three ways to stop using a streamer, and what each one costs.
 *
 * ## Why this is against a real database
 *
 * The difference between the two removals is entirely a matter of what the
 * database does to rows nobody named. Soft delete must leave every post,
 * comment and analysis exactly where it was; permanent deletion must take all
 * of them via cascade, and take the sync runs that `on delete set null` would
 * otherwise orphan. Neither claim can be checked without executing the actual
 * foreign keys — a mock would agree with whatever the code believed.
 *
 * The asymmetry is what makes this worth pinning: getting soft delete wrong
 * destroys data that was supposed to be kept, and there is no backup.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

vi.mock("@/config/env", () => ({
  getServerEnv: () => ({ TOKEN_ENCRYPTION_KEY: "0".repeat(64) }),
}));

const { countStreamerFootprint, purgeStreamer, softDeleteStreamer } = await import(
  "@/lib/repositories/streamers"
);

let client: PGlite;
let streamerId: string;
let otherStreamerId: string;
let actorId: string;

/** A streamer with one post, one video, comments, analyses and a sync run. */
async function seedStreamer(code: string, pageId: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name,
                            encrypted_page_token, page_token_last_four, token_status)
     values ($1, $1, $2, $1, 'v1.a.b.c', '1234', 'valid') returning id`,
    [code, pageId],
  );

  const id = inserted.rows[0]!.id;

  const post = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
     values ($1, $2, now(), '{}'::jsonb) returning id`,
    [id, `${code}_post`],
  );
  const postId = post.rows[0]!.id;

  const video = await client.query<{ id: string }>(
    `insert into videos (streamer_id, facebook_video_id, created_time, raw_json)
     values ($1, $2, now(), '{}'::jsonb) returning id`,
    [id, `${code}_video`],
  );
  const videoId = video.rows[0]!.id;

  await client.query(
    `insert into comments (content_type, post_id, facebook_comment_id, message,
                           created_time, content_hash)
     values ('post', $1, $2, 'nice', now(), $3)`,
    [postId, `${code}_c1`, `${code}_h1`],
  );
  await client.query(
    `insert into comments (content_type, video_id, facebook_comment_id, message,
                           created_time, content_hash)
     values ('video', $1, $2, 'good', now(), $3)`,
    [videoId, `${code}_c2`, `${code}_h2`],
  );

  await client.query(
    `insert into comment_summaries (content_type, post_id, source_hash, comment_count,
                                    status, summary)
     values ('post', $1, 'h', 1, 'completed', 'Positive.')`,
    [postId],
  );

  await client.query(
    `insert into post_insights (post_id, metric_name, period, value_json, raw_json)
     values ($1, 'post_impressions', 'lifetime', '10'::jsonb, '{}'::jsonb)`,
    [postId],
  );
  await client.query(
    `insert into video_insights (video_id, metric_name, period, value_json, raw_json)
     values ($1, 'total_video_views', 'lifetime', '20'::jsonb, '{}'::jsonb)`,
    [videoId],
  );

  // `sync_runs_terminal_status_check` requires a completion time on any
  // settled status — a run cannot claim to have finished without saying when.
  await client.query(
    `insert into sync_runs (streamer_id, sync_type, status, completed_at)
     values ($1, 'manual', 'completed', now())`,
    [id],
  );

  return id;
}

async function countRows(table: string): Promise<number> {
  const result = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });

  /*
   * Created once, and never removed between tests.
   *
   * Deleting the actor is not possible after it has written an audit entry:
   * `audit_logs.user_id` is `on delete set null`, and setting it null is an
   * UPDATE, which the append-only trigger refuses. That is the trail working as
   * intended — an actor cannot be erased out from under the record of what they
   * did — so the test works with it rather than around it.
   */
  const user = await client.query<{ id: string }>(
    `insert into auth.users (email) values ('removal-admin@example.com') returning id`,
  );
  actorId = user.rows[0]!.id;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from sync_runs");
  await client.query("delete from streamers");

  /*
   * `audit_logs` is deliberately not cleared — a trigger refuses DELETE on it,
   * which is the property that makes the trail trustworthy. Assertions below
   * scope to the streamer id under test instead, and every test seeds a fresh
   * one, so entries from earlier tests cannot be mistaken for this one's.
   */

  streamerId = await seedStreamer("GONE", FAKE_PAGE_ID);
  otherStreamerId = await seedStreamer("STAYS", "987654321098765");
});

describe("the footprint shown before deleting", () => {
  it("counts only this streamer's rows", async () => {
    const footprint = await countStreamerFootprint(streamerId);

    expect(footprint).toEqual({
      posts: 1,
      videos: 1,
      comments: 2,
      summaries: 1,
      postInsights: 1,
      videoInsights: 1,
      canonicalMetrics: 0,
      syncRuns: 1,
    });
  });

  it("is zero for a streamer with nothing collected", async () => {
    const empty = await seedStreamerWithNothing();

    const footprint = await countStreamerFootprint(empty);

    expect(Object.values(footprint).every((value) => value === 0)).toBe(true);
  });
});

describe("removing from the roster keeps the data", () => {
  it("leaves every post, comment and analysis in place", async () => {
    const before = await countStreamerFootprint(streamerId);

    const outcome = await softDeleteStreamer({ actorId, id: streamerId });
    expect(outcome.ok).toBe(true);

    // The whole reason this option exists: a departed streamer's history still
    // belongs in a report.
    expect(await countStreamerFootprint(streamerId)).toEqual(before);
  });

  it("destroys the token but keeps the row", async () => {
    await softDeleteStreamer({ actorId, id: streamerId });

    const row = await client.query<{
      deleted_at: string | null;
      active: boolean;
      page_token_last_four: string | null;
    }>(`select deleted_at, active, page_token_last_four from streamers where id = $1`, [streamerId]);

    expect(row.rows[0]?.deleted_at).not.toBeNull();
    expect(row.rows[0]?.active).toBe(false);
    // No reason to retain a live credential for something out of the roster.
    expect(row.rows[0]?.page_token_last_four).toBeNull();
  });

  it("refuses to do it twice", async () => {
    await softDeleteStreamer({ actorId, id: streamerId });

    const second = await softDeleteStreamer({ actorId, id: streamerId });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_deleted");
  });
});

describe("permanent deletion takes everything", () => {
  it("removes the streamer and all of its content", async () => {
    const outcome = await purgeStreamer({ actorId, id: streamerId });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.destroyed.comments).toBe(2);

    // One streamer's worth of everything is gone; the other's is untouched.
    expect(await countRows("streamers")).toBe(1);
    expect(await countRows("posts")).toBe(1);
    expect(await countRows("videos")).toBe(1);
    expect(await countRows("comments")).toBe(2);
    expect(await countRows("comment_summaries")).toBe(1);
    expect(await countRows("post_insights")).toBe(1);
    expect(await countRows("video_insights")).toBe(1);
  });

  it("takes the sync runs rather than orphaning them", async () => {
    /*
     * `sync_runs.streamer_id` is `on delete set null`, so a cascade alone would
     * leave this streamer's runs looking exactly like top-level automation
     * sweeps — which is what the null column means everywhere else.
     */
    await purgeStreamer({ actorId, id: streamerId });

    const orphans = await client.query<{ n: number }>(
      `select count(*)::int as n from sync_runs where streamer_id is null`,
    );

    expect(orphans.rows[0]?.n).toBe(0);
    expect(await countRows("sync_runs")).toBe(1);
  });

  it("leaves the other streamer entirely alone", async () => {
    await purgeStreamer({ actorId, id: streamerId });

    expect(await countStreamerFootprint(otherStreamerId)).toEqual({
      posts: 1,
      videos: 1,
      comments: 2,
      summaries: 1,
      postInsights: 1,
      videoInsights: 1,
      canonicalMetrics: 0,
      syncRuns: 1,
    });
  });

  it("keeps an audit entry naming what was destroyed", async () => {
    /*
     * The only evidence the streamer ever existed. `audit_logs.entity_id` has
     * no foreign key precisely so the trail outlives the record — "who removed
     * this and how much went with it" has to stay answerable afterwards.
     */
    await purgeStreamer({ actorId, id: streamerId });

    const logs = await client.query<{ action: string; metadata_json: Record<string, unknown> }>(
      `select action, metadata_json from audit_logs
        where action = 'streamer.purged' and entity_id = $1`,
      [streamerId],
    );

    expect(logs.rows).toHaveLength(1);

    const metadata = logs.rows[0]!.metadata_json as {
      streamerCode: string;
      destroyed: { comments: number; posts: number };
    };

    expect(metadata.streamerCode).toBe("GONE");
    expect(metadata.destroyed.posts).toBe(1);
    expect(metadata.destroyed.comments).toBe(2);
  });

  it("works on a streamer already removed from the roster", async () => {
    // The order an operator actually reaches this in: remove first, decide to
    // delete properly later.
    await softDeleteStreamer({ actorId, id: streamerId });

    const outcome = await purgeStreamer({ actorId, id: streamerId });

    expect(outcome.ok).toBe(true);
    expect(await countRows("posts")).toBe(1);
  });

  it("reports a streamer that is already gone rather than throwing", async () => {
    await purgeStreamer({ actorId, id: streamerId });

    const second = await purgeStreamer({ actorId, id: streamerId });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("not_found");
  });
});

describe("the confirmation phrase", () => {
  it("is not the streamer code the reversible removal asks for", () => {
    /*
     * Two irreversible-looking fields accepting the same six characters is how
     * the wrong one gets filled in from muscle memory — and only one of the two
     * can be undone.
     */
    expect(purgeConfirmationFor("CBS-014")).not.toBe("CBS-014");
    expect(purgeConfirmationFor("CBS-014")).toBe("DELETE ALL CBS-014");
  });

  it("names the streamer, so one page's phrase cannot confirm another", () => {
    expect(purgeConfirmationFor("CBS-001")).not.toBe(purgeConfirmationFor("CBS-002"));
  });
});

async function seedStreamerWithNothing(): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('EMPTY', 'Empty', '111222333444555', 'Empty Page') returning id`,
  );
  return inserted.rows[0]!.id;
}
