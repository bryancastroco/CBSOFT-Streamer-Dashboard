import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The rollup, driven against a real Postgres, counting the queries it issues.
 *
 * ## Why this suite exists
 *
 * The first rollup ran one insights query and two writes per post. Every unit
 * test passed — the resolver is pure and was covered thirty-three ways — because
 * nothing measured how many round trips the service made. At nine posts nobody
 * could tell. At 1,624 the backfill ran for ten minutes, wrote 711 rows and was
 * killed, leaving the canonical table two-fifths full.
 *
 * A correctness suite cannot catch that. So this one counts: the harness hooks
 * Drizzle's logger, and the assertions are about the *shape* of the query load
 * rather than the values it returns. An N+1 reintroduced here fails the build
 * instead of surfacing as a timeout in production.
 *
 * The rest of the file pins the properties a resumable backfill needs and which
 * are easy to lose in a rewrite: it must be idempotent, it must survive being
 * stopped anywhere, and it must never replace a known value with a null.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { rollUpMetrics, countUnrolledContent } = await import("@/lib/services/metric-rollup");

let client: PGlite;
let streamerId: string;
let queries: string[] = [];

/** Every metric the resolver can read off a video post, for one post. */
const INSIGHTS: readonly { metric: string; value: unknown }[] = [
  { metric: "post_activity_by_action_type", value: { like: 10, comment: 4, share: 2 } },
  { metric: "post_reactions_by_type_total", value: { like: 8, love: 2 } },
  { metric: "post_video_views", value: 500 },
  { metric: "post_video_views_unique", value: 420 },
  { metric: "post_video_view_time", value: 1_800_000 },
  { metric: "post_video_avg_time_watched", value: 9_476 },
];

async function seedPosts(count: number): Promise<void> {
  const values = Array.from({ length: count }, (_, index) => `($1, 'post_${index}', now(), 12, 3, 1, '{}'::jsonb)`);

  await client.query(
    `insert into posts (streamer_id, facebook_post_id, created_time, reaction_count,
                        comment_count, share_count, raw_json)
     values ${values.join(", ")}`,
    [streamerId],
  );

  const ids = await client.query<{ id: string }>("select id from posts");

  for (const row of ids.rows) {
    for (const insight of INSIGHTS) {
      await client.query(
        `insert into post_insights (post_id, metric_name, period, value_json, raw_json)
         values ($1, $2, 'lifetime', $3::jsonb, '{}'::jsonb)`,
        [row.id, insight.metric, JSON.stringify(insight.value)],
      );
    }
  }
}

beforeAll(async () => {
  client = await createTestDatabase();

  holder.db = drizzle(client, {
    schema,
    // The instrument. Every statement Drizzle sends lands here.
    logger: { logQuery: (query) => queries.push(query) },
  });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");
  queries = [];

  const inserted = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('ROLLUP', 'Rollup', $1, 'Rollup Page') returning id`,
    [FAKE_PAGE_ID],
  );

  streamerId = inserted.rows[0]!.id;
});

describe("query load", () => {
  it("does not grow with the number of posts", async () => {
    await seedPosts(60);
    queries = [];

    const summary = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 20 });

    expect(summary.processed).toBe(60);
    expect(summary.succeeded).toBe(60);

    /*
     * Three full batches, one empty select to find the posts exhausted, one
     * more to find no videos. Five queries per batch is the contract; the
     * generous ceiling here leaves room for an extra bookkeeping statement
     * without leaving room for a per-item one.
     */
    expect(summary.queries).toBeLessThanOrEqual(summary.batches * 5 + 4);
    expect(summary.queries).toBeLessThan(20);
  });

  it("costs five queries per batch whether the batch holds 10 posts or 100", async () => {
    await seedPosts(100);

    const small = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 10 });

    await client.query("delete from content_metrics_current");
    await client.query("delete from content_metric_snapshots");

    const large = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 100 });

    // Five per batch, plus the two selects that find each stage exhausted.
    expect(small.queries).toBe(small.batches * 5 + 2);
    expect(large.queries).toBe(large.batches * 5 + 2);

    // Same work, and a tenth of the round trips. This is the whole point.
    expect(small.processed).toBe(large.processed);
    expect(large.queries).toBeLessThan(small.queries / 5);
  });

  it("issues one insert per batch, not one per post", async () => {
    await seedPosts(40);
    queries = [];

    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 20 });

    const inserts = queries.filter((query) => query.startsWith("insert into"));

    // Two batches × (one current upsert + one snapshot insert).
    expect(inserts).toHaveLength(4);
  });

  it("skips the stored-values read when nothing can be retained", async () => {
    await seedPosts(20);
    queries = [];

    /*
     * `only_missing` guarantees every item is unrolled, so the retention read
     * would be a guaranteed empty scan. Not issuing it is worth a query per
     * batch across a backfill.
     */
    const backfill = await rollUpMetrics({
      graphApiVersion: "v25.0",
      batchSize: 20,
      onlyMissing: true,
    });

    expect(backfill.succeeded).toBe(20);
    // Four per batch rather than five: no read of stored values.
    expect(backfill.queries).toBe(backfill.batches * 4 + 2);

    const refresh = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 20 });

    expect(refresh.queries).toBe(refresh.batches * 5 + 2);
  });
});

describe("resumability", () => {
  it("stops at the batch limit and hands back a usable cursor", async () => {
    await seedPosts(50);

    const first = await rollUpMetrics({
      graphApiVersion: "v25.0",
      batchSize: 10,
      maxBatches: 2,
    });

    expect(first.finished).toBe(false);
    expect(first.processed).toBe(20);
    expect(first.cursor).toMatchObject({ stage: "posts" });
    expect(first.cursor?.after).toEqual(expect.any(String));

    const second = await rollUpMetrics({
      graphApiVersion: "v25.0",
      batchSize: 10,
      cursor: first.cursor,
    });

    expect(second.finished).toBe(true);
    expect(second.processed).toBe(30);

    await expect(countUnrolledContent()).resolves.toEqual({ posts: 0, videos: 0 });
  });

  it("finishes an interrupted backfill without a cursor, using only_missing", async () => {
    await seedPosts(50);

    const first = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 10, maxBatches: 2 });
    expect(first.finished).toBe(false);

    // No cursor carried across — the gap in the data is the progress record.
    const second = await rollUpMetrics({
      graphApiVersion: "v25.0",
      batchSize: 10,
      onlyMissing: true,
    });

    expect(second.processed).toBe(30);
    await expect(countUnrolledContent()).resolves.toEqual({ posts: 0, videos: 0 });
  });

  it("commits each batch, so an interrupted sweep keeps what it finished", async () => {
    await seedPosts(50);

    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 10, maxBatches: 3 });

    const written = await client.query<{ n: number }>(
      "select count(*)::int as n from content_metrics_current",
    );

    // Not zero, which is what a single wrapping transaction would have left.
    expect(written.rows[0]!.n).toBe(30);
  });
});

describe("idempotency", () => {
  it("writes the same values on a second pass and no duplicate snapshots", async () => {
    await seedPosts(30);

    const first = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 10 });
    expect(first.snapshotsWritten).toBe(30);

    const before = await client.query<{ hash: string; views: number }>(
      "select metric_hash as hash, views from content_metrics_current order by post_id",
    );

    const second = await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 10 });

    expect(second.succeeded).toBe(30);
    // The values did not move, so no snapshot should be recorded for them.
    expect(second.snapshotsWritten).toBe(0);
    expect(second.snapshotsSkipped).toBe(30);

    const after = await client.query<{ hash: string; views: number }>(
      "select metric_hash as hash, views from content_metrics_current order by post_id",
    );

    expect(after.rows).toEqual(before.rows);

    const rows = await client.query<{ n: number }>(
      "select count(*)::int as n from content_metrics_current",
    );
    expect(rows.rows[0]!.n).toBe(30);
  });

  it("keeps exactly one current row per post however often it runs", async () => {
    await seedPosts(15);

    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 5 });
    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 7 });
    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 15 });

    const duplicates = await client.query<{ n: number }>(
      `select count(*)::int as n from (
         select post_id from content_metrics_current group by post_id having count(*) > 1
       ) duplicated`,
    );

    expect(duplicates.rows[0]!.n).toBe(0);
  });
});

describe("a null never replaces a known value", () => {
  it("keeps the stored figure when Meta stops reporting the metric", async () => {
    await seedPosts(1);
    await rollUpMetrics({ graphApiVersion: "v25.0" });

    const before = await client.query<{ views: number | null; viewers: number | null }>(
      "select views, viewers from content_metrics_current",
    );
    expect(before.rows[0]).toEqual({ views: 500, viewers: 420 });

    // Meta stops returning the viewers metric. The raw record loses it, which
    // is correct — it records what arrived.
    await client.query("delete from post_insights where metric_name = 'post_video_views_unique'");

    const summary = await rollUpMetrics({ graphApiVersion: "v25.0" });
    expect(summary.retained).toBe(1);

    const after = await client.query<{
      views: number | null;
      viewers: number | null;
      availability_json: Record<string, { status?: string; retained?: boolean }>;
    }>("select views, viewers, availability_json from content_metrics_current");

    expect(after.rows[0]!.viewers).toBe(420);
    expect(after.rows[0]!.views).toBe(500);

    // Retained, and saying so. A reader must be able to tell this figure was
    // not re-measured on this pass.
    expect(after.rows[0]!.availability_json["viewers"]).toMatchObject({
      status: "available",
      retained: true,
      notReportedThisRun: "unavailable",
    });
  });

  it("does not resurrect a value the content can no longer have", async () => {
    await seedPosts(1);
    await rollUpMetrics({ graphApiVersion: "v25.0" });

    /*
     * Every video signal goes away, so the post resolves as an ordinary post
     * and the video metrics become `not_applicable`. That is a correction, not
     * a gap: the stored view count was wrong about what this content is, and
     * retaining it would preserve the error.
     */
    await client.query("delete from post_insights where metric_name like 'post_video_%'");

    await rollUpMetrics({ graphApiVersion: "v25.0" });

    const after = await client.query<{ views: number | null; viewers: number | null }>(
      "select views, viewers from content_metrics_current",
    );

    expect(after.rows[0]).toEqual({ views: null, viewers: null });
  });

  it("leaves the raw insight tables untouched", async () => {
    await seedPosts(10);

    const before = await client.query<{ n: number }>(
      "select count(*)::int as n from post_insights",
    );

    await rollUpMetrics({ graphApiVersion: "v25.0", batchSize: 3 });

    const after = await client.query<{ n: number }>("select count(*)::int as n from post_insights");

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
