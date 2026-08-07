import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The dashboard's daily buckets, against real Postgres.
 *
 * ## Why this file exists
 *
 * The display-zone change shipped with the zone interpolated into the SQL
 * template. Drizzle turns an interpolated value into a bind parameter and
 * numbers each use separately, so the same expression reached Postgres as `$1`
 * in the SELECT list and `$2` in the GROUP BY. Grouping expressions are matched
 * syntactically, so Postgres rejected the query with
 *
 *     column "posts.created_time" must appear in the GROUP BY clause
 *
 * — a message that names a column already in the GROUP BY and never mentions
 * time zones. The dashboard was down until somebody read the database log.
 *
 * Nothing in the suite could have caught it. It type-checks; the unit tests
 * mock `getDb`, so no SQL is ever generated; and the obvious manual check —
 * running the query by hand with the zone typed out — passes, because two
 * identical literals *do* match where two parameters do not.
 *
 * So this executes the real function against a real Postgres. The assertions
 * about which day a post lands on matter, but the load-bearing part is simply
 * that the query runs at all.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { getTimeSeries } = await import("@/lib/repositories/dashboard");

let client: PGlite;
let streamerId: string;

/** `at` is an absolute instant, written in UTC. */
async function seedPost(handle: string, at: string, reactions = 1): Promise<void> {
  await client.query(
    `insert into posts (streamer_id, facebook_post_id, created_time, reaction_count, raw_json)
     values ($1, $2, $3::timestamptz, $4, '{}'::jsonb)`,
    [streamerId, handle, at, reactions],
  );
}

async function seedVideo(handle: string, at: string): Promise<void> {
  await client.query(
    `insert into videos (streamer_id, facebook_video_id, created_time, raw_json)
     values ($1, $2, $3::timestamptz, '{}'::jsonb)`,
    [streamerId, handle, at],
  );
}

const ALL_TIME = { period: { from: null, to: null }, scope: "all" as const };

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
     values ('TZ', 'Zone', $1, 'Zone Page') returning id`,
    [FAKE_PAGE_ID],
  );
  streamerId = streamer.rows[0]!.id;
});

describe("the grouped query survives contact with Postgres", () => {
  it("runs at all — the regression this file was written for", async () => {
    await seedPost("p1", "2026-08-06T09:00:00Z");

    // A throw here is the bug: `column ... must appear in the GROUP BY clause`.
    await expect(getTimeSeries(ALL_TIME)).resolves.toBeDefined();
  });

  it("runs for each scope, since each builds its own grouped statement", async () => {
    await seedPost("p1", "2026-08-06T09:00:00Z");
    await seedVideo("v1", "2026-08-06T09:00:00Z");

    for (const scope of ["all", "posts", "videos"] as const) {
      await expect(getTimeSeries({ ...ALL_TIME, scope })).resolves.toBeDefined();
    }
  });
});

describe("which day a post is counted under", () => {
  it("files a UTC morning under that same display-zone day", async () => {
    // 09:00 UTC is 17:00 in Manila — same date either way.
    await seedPost("p1", "2026-08-06T09:00:00Z");

    const series = await getTimeSeries(ALL_TIME);

    expect(series).toHaveLength(1);
    expect(series[0]?.day).toBe("2026-08-06");
  });

  it("files a late UTC evening under the following display-zone day", async () => {
    // 16:30 UTC is 00:30 the next morning here. Under UTC bucketing this landed
    // on the 6th while the table beside it printed the 7th.
    await seedPost("p1", "2026-08-06T16:30:00Z");

    const series = await getTimeSeries(ALL_TIME);

    expect(series).toHaveLength(1);
    expect(series[0]?.day).toBe("2026-08-07");
  });

  it("splits two posts either side of local midnight into two days", async () => {
    await seedPost("before", "2026-08-06T15:59:00Z", 10);
    await seedPost("after", "2026-08-06T16:01:00Z", 20);

    const series = await getTimeSeries(ALL_TIME);
    const byDay = new Map(series.map((point) => [point.day, point]));

    expect(byDay.get("2026-08-06")?.reactions).toBe(10);
    expect(byDay.get("2026-08-07")?.reactions).toBe(20);
  });

  it("sums a day rather than emitting a row per post", async () => {
    await seedPost("a", "2026-08-06T01:00:00Z", 3);
    await seedPost("b", "2026-08-06T05:00:00Z", 4);

    const series = await getTimeSeries(ALL_TIME);

    expect(series).toHaveLength(1);
    expect(series[0]?.reactions).toBe(7);
    expect(series[0]?.postCount).toBe(2);
  });

  it("merges a post and a video published the same display-zone day", async () => {
    // Different UTC dates, one Manila date — so the merge only holds if both
    // sides bucket the same way.
    await seedPost("p1", "2026-08-06T16:30:00Z");
    await seedVideo("v1", "2026-08-07T02:00:00Z");

    const series = await getTimeSeries(ALL_TIME);

    expect(series).toHaveLength(1);
    expect(series[0]?.day).toBe("2026-08-07");
    expect(series[0]?.postCount).toBe(1);
    expect(series[0]?.videoCount).toBe(1);
  });
});
