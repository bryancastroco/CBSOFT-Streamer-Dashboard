import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { CONTENT_SCOPES, type ContentScope } from "@/lib/filters/period";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * What the dashboard's cards count, under each Content scope.
 *
 * ## The bug this was written after
 *
 * `getDashboardMetrics` decided which tables to read with
 * `scope === "all" || scope === "videos"`. A fourth scope was added and that
 * line matched neither of its values, so selecting Livestreams skipped the
 * video aggregate entirely and the card reported **0** on a week holding six
 * broadcasts.
 *
 * It survived a full green test run, and it would survive another one written
 * carelessly, because zero is a plausible number. Nothing throws, nothing looks
 * malformed — the dashboard simply says there is no content and the reader
 * believes it.
 *
 * So this asserts every scope against a known fixture, including the scopes
 * that were already working. A test covering only the broken one would pass the
 * day someone adds a fifth.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { getDashboardMetrics, getStreamerOverview } = await import(
  "@/lib/repositories/metrics",
);

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

async function seedPost(handle: string, videoRowId: string | null): Promise<void> {
  await client.query(
    `insert into posts (streamer_id, facebook_post_id, created_time, message, video_id,
                        reaction_count, raw_json)
     values ($1, $2, now(), 'hello', $3, 5, '{}'::jsonb)`,
    [streamerId, `${PAGE}_${handle}`, videoRowId],
  );
}

const counts = async (scope: ContentScope) => {
  const metrics = await getDashboardMetrics({ scope });
  return {
    posts: metrics.postsCollected,
    videos: metrics.videosCollected,
    livestreams: metrics.livestreamsCollected,
  };
};

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

  // Two plain posts, one reel, one broadcast — and the broadcast's feed story,
  // which is a row in `posts` that is not a post.
  await seedPost("plain-1", null);
  await seedPost("plain-2", null);
  await seedVideo("reel-1", "video");
  const live = await seedVideo("live-1", "livestream");
  await seedPost("live-1", live);
});

describe("every scope counts the right things", () => {
  it("counts all content without the duplicate", async () => {
    // Five rows across the two tables; four items. The three figures partition
    // them, so adding the cards up is the whole selection and nothing twice.
    expect(await counts("all")).toEqual({ posts: 2, videos: 1, livestreams: 1 });
  });

  it("counts posts without the broadcast's feed story", async () => {
    // Three rows in `posts`, two of them posts. This builder was the one place
    // still counting the third.
    expect(await counts("posts")).toEqual({ posts: 2, videos: 0, livestreams: 0 });
  });

  it("counts videos without the broadcast", async () => {
    expect(await counts("videos")).toEqual({ posts: 0, videos: 1, livestreams: 0 });
  });

  it("counts the broadcast under livestreams, and not as a video", async () => {
    // Two regressions in one assertion: this reported 0 before the scope fix,
    // and would report the broadcast in both figures if the split were a sum.
    expect(await counts("livestreams")).toEqual({ posts: 0, videos: 0, livestreams: 1 });
  });

  it("never counts one item under two headings", async () => {
    const { posts, videos, livestreams } = await counts("all");

    // The property the old counts did not have.
    expect(posts + videos + livestreams).toBe(4);
  });

  it("reports a non-zero video count for every scope that includes videos", async () => {
    /*
     * Guards the shape of the bug rather than its instance. Any future scope
     * that reads videos and silently returns none fails here, whatever it is
     * called — which is what a test of only the four known values would miss.
     */
    for (const scope of CONTENT_SCOPES) {
      const { videos, livestreams } = await counts(scope);
      if (scope === "posts") expect(videos + livestreams).toBe(0);
      else expect(videos + livestreams).toBeGreaterThan(0);
    }
  });
});

/**
 * The per-streamer overview counts the same way the roster and the cards do.
 *
 * It briefly summed the two kinds, when it had one slot for them. Giving
 * broadcasts their own card there means the sum would count each one twice —
 * the arithmetic this file exists to keep honest, on a third screen.
 */
describe("the streamer overview", () => {
  it("splits uploads from broadcasts", async () => {
    const overview = await getStreamerOverview({ streamerId });

    expect(overview.videoCount).toBe(1);
    expect(overview.livestreamCount).toBe(1);
  });

  it("counts the feed story as neither a post nor a video", async () => {
    const overview = await getStreamerOverview({ streamerId });

    // Three rows in `posts`, two of them posts — the third is the broadcast's
    // feed story, already counted as a livestream.
    expect(overview.postCount).toBe(2);
    expect(overview.postCount + overview.videoCount + overview.livestreamCount).toBe(4);
  });
});
