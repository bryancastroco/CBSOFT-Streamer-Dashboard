import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import type { ContentScope } from "@/lib/filters/period";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * A livestream's comments reach the reader.
 *
 * ## The regression
 *
 * Facebook attaches a broadcast's comments to its Page feed story, not to the
 * video object — 800 against 34, in production. Excluding feed stories to stop
 * a broadcast being counted twice therefore also excluded the busiest
 * conversations on the Page from every comment reading, silently, because the
 * video row it left behind has almost nothing on it.
 *
 * Counting content and reading its comments are different questions, and the
 * answer to the second is: **the row that owns the comments represents the
 * item.** A livestream is its feed story; a reel is its video row; a post is
 * itself. One row each, comments intact.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { getCommentOverview } = await import("@/lib/repositories/comment-overview");

let client: PGlite;
let streamerId: string;

const PAGE = "102942398708927";

async function seedVideo(videoId: string, kind: "video" | "livestream"): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into videos (streamer_id, facebook_video_id, created_time, media_kind, raw_json)
     values ($1, $2, now(), $3, '{}'::jsonb) returning id`,
    [streamerId, videoId, kind],
  );
  return row.rows[0]!.id;
}

async function seedPost(handle: string, videoRowId: string | null): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, message, video_id, raw_json)
     values ($1, $2, now(), 'text', $3, '{}'::jsonb) returning id`,
    [streamerId, `${PAGE}_${handle}`, videoRowId],
  );
  return row.rows[0]!.id;
}

async function seedComment(parent: { postId?: string; videoId?: string }, message: string) {
  await client.query(
    `insert into comments
       (content_type, post_id, video_id, facebook_comment_id, message, content_hash, created_time)
     values ($1, $2, $3, $4, $5, md5($5), now())`,
    [
      parent.postId ? "post" : "video",
      parent.postId ?? null,
      parent.videoId ?? null,
      `c_${message}`,
      message,
    ],
  );
}

const filters = (scope: ContentScope) => ({
  period: { from: null, to: null },
  scope,
});

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");

  const streamer = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('STM-001', 'Bladz', $1, 'Bladz') returning id`,
    [FAKE_PAGE_ID],
  );
  streamerId = streamer.rows[0]!.id;

  // A plain post with one comment.
  const plain = await seedPost("plain", null);
  await seedComment({ postId: plain }, "on a post");

  // A reel with one comment of its own.
  const reel = await seedVideo("reel-1", "video");
  await seedComment({ videoId: reel }, "on a reel");

  /*
   * A broadcast: the video row carries one stray comment, its feed story
   * carries two. Production's ratio is far more lopsided than this; two against
   * one is enough to tell which row was read.
   */
  const live = await seedVideo("live-1", "livestream");
  const story = await seedPost("live-1", live);
  await seedComment({ videoId: live }, "stray on the video object");
  await seedComment({ postId: story }, "live one");
  await seedComment({ postId: story }, "live two");
});

describe("a broadcast's comments are not lost", () => {
  it("reads the feed story's comments under all content", async () => {
    const overview = await getCommentOverview(filters("all"));

    // 1 post + 1 reel + 2 on the story. The stray on the video object is not
    // read, because the story represents that item.
    expect(overview.analysed).toBe(4);
  });

  it("reads them when the scope is livestreams", async () => {
    const overview = await getCommentOverview(filters("livestreams"));

    // The regression returned 1 here — the stray — and reported a two-hour
    // broadcast as almost silent.
    expect(overview.analysed).toBe(2);
  });

  it("counts the broadcast as one item, not two", async () => {
    expect((await getCommentOverview(filters("livestreams"))).contentInScope).toBe(1);
    expect((await getCommentOverview(filters("all"))).contentInScope).toBe(3);
  });
});

describe("the other scopes stay narrow", () => {
  it("reads only standalone posts under posts", async () => {
    const overview = await getCommentOverview(filters("posts"));

    // Not the feed story, and not the video rows. Removing the branch switch
    // entirely made this 5.
    expect(overview.analysed).toBe(1);
  });

  it("reads only the reel under videos", async () => {
    const overview = await getCommentOverview(filters("videos"));

    expect(overview.analysed).toBe(1);
    expect(overview.contentInScope).toBe(1);
  });

  it("never double counts the broadcast in any scope", async () => {
    for (const scope of ["all", "posts", "videos", "livestreams"] as const) {
      const { contentInScope } = await getCommentOverview(filters(scope));
      expect(contentInScope).toBeLessThanOrEqual(3);
    }
  });
});
