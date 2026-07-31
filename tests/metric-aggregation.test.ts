import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The dashboard aggregate, executed against a real Postgres.
 *
 * Written this way because the risky parts of `getMetricTotals` are the parts
 * a unit test cannot reach: a `FILTER (WHERE …)` clause, JSONB path operators
 * reading `availability_json`, and a weighted mean computed in SQL. Each of
 * those either runs or does not, and TypeScript has no opinion either way.
 *
 * What the assertions protect is the honesty of the figures. A sum over the
 * subset Meta happened to report is not the roster's total, and every number
 * here is checked alongside the denominator that qualifies it.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { getMetricTotals } = await import("@/lib/repositories/canonical-metrics");

let client: PGlite;
let streamerId: string;

/** A canonical row, written directly so the shapes under test are exact. */
async function writeMetrics(params: {
  postId: string;
  views: number | null;
  viewers: number | null;
  averagePlayTime: number | null;
  likes: number | null;
  isVideoPost: boolean;
}): Promise<void> {
  const availability = {
    views: { status: params.isVideoPost ? "available" : "not_applicable" },
    reach: { status: "not_applicable" },
    reels_plays: { status: "not_applicable" },
  };

  await client.query(
    `insert into content_metrics_current
       (content_type, post_id, streamer_id, views, viewers, average_play_time_ms, likes,
        availability_json, graph_api_version, metric_hash, last_collected_at)
     values ('post', $1, $2, $3, $4, $5, $6, $7::jsonb, 'v25.0', $8, now())`,
    [
      params.postId,
      streamerId,
      params.views,
      params.viewers,
      params.averagePlayTime,
      params.likes,
      JSON.stringify(availability),
      `hash_${params.postId}`,
    ],
  );
}

async function seedPost(externalId: string, createdTime = "now()"): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
     values ($1, $2, ${createdTime}, '{}'::jsonb) returning id`,
    [streamerId, externalId],
  );

  return inserted.rows[0]!.id;
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

  const inserted = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('AGG', 'Aggregate', $1, 'Aggregate Page') returning id`,
    [FAKE_PAGE_ID],
  );

  streamerId = inserted.rows[0]!.id;
});

describe("sums carry their denominator", () => {
  it("counts only the content that reported the metric", async () => {
    const a = await seedPost("p1");
    const b = await seedPost("p2");
    const c = await seedPost("p3");

    await writeMetrics({
      postId: a,
      views: 500,
      viewers: 400,
      averagePlayTime: null,
      likes: 10,
      isVideoPost: true,
    });
    await writeMetrics({
      postId: b,
      views: 300,
      viewers: null,
      averagePlayTime: null,
      likes: 20,
      isVideoPost: true,
    });
    // A text post: views cannot apply to it at all.
    await writeMetrics({
      postId: c,
      views: null,
      viewers: null,
      averagePlayTime: null,
      likes: 5,
      isVideoPost: false,
    });

    const totals = await getMetricTotals({});

    expect(totals.metrics.views.value).toBe(800);
    expect(totals.metrics.views.reported).toBe(2);
    // Two video posts, not three items. The text post is not a gap in coverage.
    expect(totals.metrics.views.applicable).toBe(2);

    expect(totals.metrics.viewers.value).toBe(400);
    expect(totals.metrics.viewers.reported).toBe(1);

    expect(totals.metrics.likes.value).toBe(35);
    expect(totals.metrics.likes.reported).toBe(3);
  });

  it("returns null rather than zero when nothing reported a metric", async () => {
    const a = await seedPost("p1");
    await writeMetrics({
      postId: a,
      views: null,
      viewers: null,
      averagePlayTime: null,
      likes: 7,
      isVideoPost: false,
    });

    const totals = await getMetricTotals({});

    /*
     * The distinction the whole phase exists to preserve. A zero here would be
     * read as "nobody watched", which is a measurement nobody made.
     */
    expect(totals.metrics.views.value).toBeNull();
    expect(totals.metrics.views.reported).toBe(0);
  });
});

describe("average play time", () => {
  it("weights by views instead of averaging the averages", async () => {
    const small = await seedPost("small");
    const large = await seedPost("large");

    // 10 views at 2s, 990 views at 20s.
    await writeMetrics({
      postId: small,
      views: 10,
      viewers: 10,
      averagePlayTime: 2_000,
      likes: null,
      isVideoPost: true,
    });
    await writeMetrics({
      postId: large,
      views: 990,
      viewers: 990,
      averagePlayTime: 20_000,
      likes: null,
      isVideoPost: true,
    });

    const totals = await getMetricTotals({});

    // (10×2000 + 990×20000) / 1000 = 19,820ms.
    expect(totals.metrics.average_play_time.value).toBeCloseTo(19_820, 0);

    /*
     * A plain mean would be 11,000ms — giving a video nobody watched the same
     * say as one watched a thousand times. That is a fact about the roster's
     * videos, not about its viewers.
     */
    expect(totals.metrics.average_play_time.value).not.toBeCloseTo(11_000, 0);
  });

  it("is always marked calculated, because a roster-level average is derived", async () => {
    const a = await seedPost("p1");
    await writeMetrics({
      postId: a,
      views: 100,
      viewers: 90,
      averagePlayTime: 5_000,
      likes: null,
      isVideoPost: true,
    });

    const totals = await getMetricTotals({});

    expect(totals.metrics.average_play_time.calculated).toBe(true);
    // A sum is not.
    expect(totals.metrics.views.calculated).toBe(false);
  });

  it("stays null when no content reported an average", async () => {
    const a = await seedPost("p1");
    await writeMetrics({
      postId: a,
      views: 100,
      viewers: 90,
      averagePlayTime: null,
      likes: null,
      isVideoPost: true,
    });

    const totals = await getMetricTotals({});

    expect(totals.metrics.average_play_time.value).toBeNull();
  });
});

describe("REGRESSION: each metric uses its own denominator", () => {
  it("never reports coverage above 100%", async () => {
    /*
     * Found by running the aggregate against production, not by this suite.
     * Three-second views reported "127 of 121" — it had borrowed the `views`
     * denominator, and `views` applies to video posts while three-second views
     * applies to video posts *and* video objects. Six videos counted in the
     * numerator and excluded from the denominator. Watch time was understated
     * the same way, 81 of 121 where the truth was 81 of 184.
     *
     * A ratio above one is the cheapest possible signal that a denominator has
     * been shared, so it is asserted across every metric rather than only the
     * two that were wrong.
     */
    const post = await seedPost("video-post");
    await writeMetrics({
      postId: post,
      views: 100,
      viewers: 90,
      averagePlayTime: 5_000,
      likes: 3,
      isVideoPost: true,
    });

    // A video object: three-second views and watch time apply, `views` does not.
    const video = await client.query<{ id: string }>(
      `insert into videos (streamer_id, facebook_video_id, created_time, raw_json)
       values ($1, 'vid1', now(), '{}'::jsonb) returning id`,
      [streamerId],
    );

    await client.query(
      `insert into content_metrics_current
         (content_type, video_id, streamer_id, three_second_views, watch_time_ms,
          availability_json, graph_api_version, metric_hash, last_collected_at)
       values ('video', $1, $2, 55, 9000, $3::jsonb, 'v25.0', 'vhash', now())`,
      [
        video.rows[0]!.id,
        streamerId,
        JSON.stringify({
          views: { status: "not_applicable" },
          three_second_views: { status: "available" },
          watch_time: { status: "available" },
        }),
      ],
    );

    const totals = await getMetricTotals({});

    for (const metric of Object.values(totals.metrics)) {
      expect(
        metric.reported,
        `${metric.key} reported ${metric.reported} of ${metric.applicable} — a metric cannot be reported by more content than it applies to`,
      ).toBeLessThanOrEqual(metric.applicable);
    }

    // Both the video post and the video object can carry three-second views.
    expect(totals.metrics.three_second_views.applicable).toBe(2);
    // Only the video post can carry `views`.
    expect(totals.metrics.views.applicable).toBe(1);
  });
});

describe("the rollup gap is visible", () => {
  it("counts content that has been synced but not rolled up", async () => {
    const rolled = await seedPost("rolled");
    await seedPost("not-rolled-1");
    await seedPost("not-rolled-2");

    await writeMetrics({
      postId: rolled,
      views: 10,
      viewers: 10,
      averagePlayTime: null,
      likes: 1,
      isVideoPost: true,
    });

    const totals = await getMetricTotals({});

    expect(totals.contentCount).toBe(1);
    /*
     * Two items are absent from every figure above. A reader has no way to
     * know that from the numbers themselves, so the count is surfaced.
     */
    expect(totals.withoutMetrics).toBe(2);
  });
});

describe("filters", () => {
  it("limits the aggregate to one streamer", async () => {
    const mine = await seedPost("mine");
    await writeMetrics({
      postId: mine,
      views: 100,
      viewers: 100,
      averagePlayTime: null,
      likes: 1,
      isVideoPost: true,
    });

    const other = await client.query<{ id: string }>(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('OTHER', 'Other', '999', 'Other Page') returning id`,
    );
    const otherStreamer = other.rows[0]!.id;

    const theirPost = await client.query<{ id: string }>(
      `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
       values ($1, 'theirs', now(), '{}'::jsonb) returning id`,
      [otherStreamer],
    );

    await client.query(
      `insert into content_metrics_current
         (content_type, post_id, streamer_id, views, availability_json,
          graph_api_version, metric_hash, last_collected_at)
       values ('post', $1, $2, 9999, '{}'::jsonb, 'v25.0', 'other', now())`,
      [theirPost.rows[0]!.id, otherStreamer],
    );

    const totals = await getMetricTotals({ streamerId });

    expect(totals.metrics.views.value).toBe(100);
    expect(totals.contentCount).toBe(1);
  });

  it("filters by publication time, not collection time", async () => {
    /*
     * `last_collected_at` is when we asked Meta. Filtering a date range by it
     * would move content between periods every time the rollup ran, which is
     * the kind of drift nobody notices until a monthly report changes on its
     * own.
     */
    const old = await seedPost("old", "'2020-01-01T00:00:00Z'");
    const recent = await seedPost("recent", "now()");

    for (const [id, views] of [
      [old, 111],
      [recent, 222],
    ] as const) {
      await writeMetrics({
        postId: id,
        views,
        viewers: null,
        averagePlayTime: null,
        likes: null,
        isVideoPost: true,
      });
    }

    const totals = await getMetricTotals({
      period: { from: new Date("2024-01-01T00:00:00Z"), to: null },
    });

    // Both rows were collected just now; only one was published in the window.
    expect(totals.metrics.views.value).toBe(222);
    expect(totals.contentCount).toBe(1);
  });
});
