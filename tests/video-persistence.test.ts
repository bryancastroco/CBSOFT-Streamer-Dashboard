import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import type { NormalizedVideo } from "@/lib/meta/videos";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * `upsertVideos` against a real Postgres.
 *
 * ## The bug this was written after
 *
 * The function pre-queries which of the incoming videos already have a feed
 * story, because `classifyVideo` needs that signal. It asked with:
 *
 *     split_part(facebook_post_id, '_', 2) = any(${facebookIds}::text[])
 *
 * Interpolating a JavaScript array into a `sql` template does not bind one
 * array parameter — Drizzle expands it to `$2, $3, …`, so Postgres received
 * `any(($2, $3, …)::text[])`, a row constructor cast to an array, and answered
 * `cannot cast type record to text[]`.
 *
 * Every video sync in production had been failing on it for a day. Nothing
 * looked wrong: the sweep isolates each streamer, so runs finished
 * `completed_with_errors` with honest post counts and videos at 0, and a
 * dashboard reporting no new broadcasts is indistinguishable from a week with
 * no broadcasts.
 *
 * It shipped because **nothing called `upsertVideos`**. 1,779 tests passed over
 * a repository function that could not execute a single statement. So this
 * exercises the function itself rather than the SQL it is supposed to emit —
 * a test asserting on a query string would have been just as green.
 *
 * The batch below is deliberately more than one video: a single-element array
 * emits `any(($2)::text[])`, which is a parenthesised scalar and fails for a
 * different reason. Two is what reproduces the shape that ran in production.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { upsertVideos, linkFeedPostsToVideos } = await import("@/lib/repositories/videos");

let client: PGlite;
let streamerId: string;

/** Long enough to be inferred a broadcast when a feed story backs it up. */
const LONG = 40 * 60;

function video(facebookVideoId: string, overrides: Partial<NormalizedVideo> = {}): NormalizedVideo {
  return {
    facebookVideoId,
    title: `video ${facebookVideoId}`,
    description: null,
    lengthSeconds: 90,
    createdTime: new Date("2026-08-01T12:00:00Z"),
    permalinkUrl: `https://facebook.com/${FAKE_PAGE_ID}/videos/${facebookVideoId}`,
    liveStatus: null,
    raw: {} as NormalizedVideo["raw"],
    ...overrides,
  };
}

/** A feed story for a video: the post id's object half is the video id. */
async function seedFeedStory(facebookVideoId: string): Promise<void> {
  await client.query(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
     values ($1, $2, '2026-08-01T12:00:00Z', '{}'::jsonb)`,
    [streamerId, `${FAKE_PAGE_ID}_${facebookVideoId}`],
  );
}

async function storedKind(facebookVideoId: string) {
  const result = await client.query<{ media_kind: string; media_kind_source: string }>(
    `select media_kind, media_kind_source from videos where facebook_video_id = $1`,
    [facebookVideoId],
  );
  return result.rows[0];
}

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
});

describe("upsertVideos executes", () => {
  it("writes a multi-video batch without a cast error", async () => {
    // The regression. Before the fix this threw
    // `cannot cast type record to text[]` and wrote nothing at all.
    const result = await upsertVideos({
      streamerId,
      videos: [video("1001"), video("1002"), video("1003")],
    });

    expect(result.written).toBe(3);
  });

  it("writes a single-video batch too", async () => {
    // One element takes a different path through the placeholder expansion, so
    // a fix verified only on a batch could still leave this broken.
    const result = await upsertVideos({ streamerId, videos: [video("2001")] });

    expect(result.written).toBe(1);
  });

  it("re-syncing updates in place rather than duplicating", async () => {
    await upsertVideos({ streamerId, videos: [video("3001"), video("3002")] });
    await upsertVideos({
      streamerId,
      videos: [video("3001", { title: "renamed" }), video("3002")],
    });

    const { rows } = await client.query<{ count: number }>(
      `select count(*)::int as count from videos where streamer_id = $1`,
      [streamerId],
    );
    expect(rows[0]?.count).toBe(2);

    const { rows: titles } = await client.query<{ title: string }>(
      `select title from videos where facebook_video_id = '3001'`,
    );
    expect(titles[0]?.title).toBe("renamed");
  });
});

/**
 * The feed-story lookup is the whole reason that query exists. If it silently
 * returned nothing — the failure mode a `try/catch` around it would have
 * produced — every broadcast would be filed as an ordinary upload and counted
 * twice, once here and once as its own feed story.
 */
describe("classification uses the feed-story signal", () => {
  it("calls a long video with a feed story a livestream", async () => {
    await seedFeedStory("4001");

    await upsertVideos({
      streamerId,
      videos: [video("4001", { lengthSeconds: LONG }), video("4002")],
    });

    expect(await storedKind("4001")).toMatchObject({
      media_kind: "livestream",
      media_kind_source: "inferred",
    });
  });

  it("leaves a long video with no feed story an ordinary upload", async () => {
    // Length alone is not evidence. A forty-minute upload is a normal thing to
    // post, and calling it a broadcast would put it on the wrong screen.
    await upsertVideos({
      streamerId,
      videos: [video("5001", { lengthSeconds: LONG }), video("5002")],
    });

    expect(await storedKind("5001")).toMatchObject({ media_kind: "video" });
  });

  it("trusts Meta's live_status over the inference", async () => {
    await upsertVideos({
      streamerId,
      videos: [video("6001", { liveStatus: "VOD" }), video("6002")],
    });

    expect(await storedKind("6001")).toMatchObject({
      media_kind: "livestream",
      media_kind_source: "live_status",
    });
  });
});

describe("feed stories are tied to their video", () => {
  it("points posts.video_id at the video the story describes", async () => {
    await seedFeedStory("7001");

    await upsertVideos({
      streamerId,
      videos: [video("7001", { lengthSeconds: LONG }), video("7002")],
    });

    const { rows } = await client.query<{ video_id: string | null }>(
      `select video_id from posts where facebook_post_id = $1`,
      [`${FAKE_PAGE_ID}_7001`],
    );

    // Null here is what made a broadcast count twice on the dashboard.
    expect(rows[0]?.video_id).not.toBeNull();
  });

  it("links a story that arrived after its video", async () => {
    // The two edges are synced separately and either can be first, which is
    // why the link is attempted from both sides.
    await upsertVideos({ streamerId, videos: [video("8001"), video("8002")] });
    await seedFeedStory("8001");

    expect(await linkFeedPostsToVideos(streamerId)).toBe(1);
  });

  it("leaves an ordinary post unlinked", async () => {
    await client.query(
      `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
       values ($1, $2, '2026-08-01T12:00:00Z', '{}'::jsonb)`,
      [streamerId, `${FAKE_PAGE_ID}_notavideo`],
    );

    await upsertVideos({ streamerId, videos: [video("9001"), video("9002")] });

    const { rows } = await client.query<{ video_id: string | null }>(
      `select video_id from posts where facebook_post_id = $1`,
      [`${FAKE_PAGE_ID}_notavideo`],
    );
    expect(rows[0]?.video_id).toBeNull();
  });
});
