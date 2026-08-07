import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  CONTENT_SCOPES,
  scopeIncludesPosts,
  scopeIncludesVideos,
  scopeVideoKind,
} from "@/lib/filters/period";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * Post, Video and Livestream as a filter, against real Postgres.
 *
 * ## What this is really guarding
 *
 * A livestream arrives from Meta twice — once on `/videos` and once as a Page
 * feed story — and both were stored. Thirty-three of 286 posts were a second
 * copy of a video: content counts inflated, one broadcast split across two rows
 * with the comments on one and the watch time on the other, and a two-hour
 * stream sitting in the Posts list where nobody expected it.
 *
 * So the assertions here are mostly about what a scope does *not* return. Those
 * are the ones that fail silently: a query missing the predicate gives back
 * rows that look entirely reasonable, and the only symptom is a number being
 * bigger than it should be.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { listPosts } = await import("@/lib/repositories/posts");
const { listVideos } = await import("@/lib/repositories/videos");

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

/** A plain post: no video behind it. */
async function seedPost(handle: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, message, raw_json)
     values ($1, $2, now(), 'hello', '{}'::jsonb) returning id`,
    [streamerId, `${PAGE}_${handle}`],
  );
  return row.rows[0]!.id;
}

/** The feed story Facebook publishes alongside a broadcast. */
async function seedFeedStory(videoRowId: string, videoId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, message, video_id, raw_json)
     values ($1, $2, now(), 'live now', $3, '{}'::jsonb) returning id`,
    [streamerId, `${PAGE}_${videoId}`, videoRowId],
  );
  return row.rows[0]!.id;
}

const PAGING = { limit: 50, offset: 0 };

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

  // Production in miniature: one ordinary post, one reel, one broadcast that
  // exists as both a video row and a feed story.
  await seedPost("plain");
  await seedVideo("reel-1", "video");
  const live = await seedVideo("live-1", "livestream");
  await seedFeedStory(live, "live-1");
});

describe("the four scopes", () => {
  it("offers exactly the four the product asks for", () => {
    expect([...CONTENT_SCOPES]).toEqual(["all", "posts", "videos", "livestreams"]);
  });

  it("routes each scope to the right tables", () => {
    expect(scopeIncludesPosts("all")).toBe(true);
    expect(scopeIncludesPosts("posts")).toBe(true);
    expect(scopeIncludesPosts("videos")).toBe(false);
    expect(scopeIncludesPosts("livestreams")).toBe(false);

    // Livestreams live in `videos`, so the video table is read for both.
    expect(scopeIncludesVideos("videos")).toBe(true);
    expect(scopeIncludesVideos("livestreams")).toBe(true);
    expect(scopeIncludesVideos("posts")).toBe(false);
  });

  it("leaves 'all' unrestricted rather than listing today's kinds", () => {
    expect(scopeVideoKind("all")).toBeNull();
    expect(scopeVideoKind("videos")).toBe("video");
    expect(scopeVideoKind("livestreams")).toBe("livestream");
  });
});

describe("a broadcast is one item, not two", () => {
  it("keeps the feed story out of the posts list", async () => {
    const { items, total } = await listPosts(PAGING);

    // One plain post. The feed story is present in the table and deliberately
    // absent here — this is the assertion that stops the double count.
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe("hello");
  });

  it("returns the broadcast once, under livestreams", async () => {
    const { items, total } = await listVideos({ ...PAGING, scope: "livestreams" });

    expect(total).toBe(1);
    expect(items[0]?.facebookVideoId).toBe("live-1");
  });

  it("does not return the broadcast under videos", async () => {
    const { items, total } = await listVideos({ ...PAGING, scope: "videos" });

    expect(total).toBe(1);
    expect(items[0]?.facebookVideoId).toBe("reel-1");
  });

  it("returns both kinds when the scope does not narrow", async () => {
    const unscoped = await listVideos(PAGING);
    const all = await listVideos({ ...PAGING, scope: "all" });

    expect(unscoped.total).toBe(2);
    expect(all.total).toBe(2);
  });

  it("counts three items across the whole selection, not four", async () => {
    // A post, a reel, a broadcast. The fourth row exists — it is the feed
    // story — and must not be counted as content in its own right.
    const posts = await listPosts(PAGING);
    const videos = await listVideos({ ...PAGING, scope: "all" });

    expect(posts.total + videos.total).toBe(3);
  });
});
