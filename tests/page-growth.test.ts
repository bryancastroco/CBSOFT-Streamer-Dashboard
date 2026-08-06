import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { normalizePageGrowth, PAGE_GROWTH_METRICS } from "@/lib/meta/page-metrics";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * Audience growth: what Meta gives, and what the figures mean.
 *
 * ## The distinction this exists to protect
 *
 * `followers` is a running total; `new_follows` is that day's arrivals. They
 * are not the same measurement and neither can be derived from the other,
 * because unfollows are invisible on this edge — a day with seven arrivals and
 * three departures moves the total by four while `new_follows` says seven.
 *
 * Someone will eventually "simplify" one into the other. These tests are the
 * reason not to.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { getPageGrowth, getRosterGrowth } = await import("@/lib/repositories/page-growth");

let client: PGlite;
let streamerId: string;

/** Meta's shape: one object per metric, each with its own daily series. */
function insight(name: string, points: { value: number; endTime: string }[]) {
  return {
    name,
    period: "day",
    values: points.map((point) => ({ value: point.value, end_time: point.endTime })),
  };
}

async function seedDay(day: string, followers: number | null, newFollows: number | null) {
  await client.query(
    `insert into page_metrics_daily (streamer_id, metric_date, followers, new_follows)
     values ($1, $2, $3, $4)`,
    [streamerId, day, followers, newFollows],
  );
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

  const row = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('GROW', 'Grow', $1, 'Grow Page') returning id`,
    [FAKE_PAGE_ID],
  );

  streamerId = row.rows[0]!.id;
});

describe("reading Meta's response", () => {
  it("pivots separate metric series onto one row per day", async () => {
    const days = normalizePageGrowth([
      insight("page_follows", [
        { value: 40_000, endTime: "2026-08-02T07:00:00+0000" },
        { value: 40_007, endTime: "2026-08-03T07:00:00+0000" },
      ]),
      insight("page_daily_follows", [
        { value: 5, endTime: "2026-08-02T07:00:00+0000" },
        { value: 7, endTime: "2026-08-03T07:00:00+0000" },
      ]),
    ]);

    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ followers: 40_000, newFollows: 5 });
    expect(days[1]).toMatchObject({ followers: 40_007, newFollows: 7 });
  });

  it("labels a value with the day it describes, not the day after", () => {
    /*
     * `end_time` is the *boundary* after the day being reported — Meta returns
     * midnight of the following day. Taking the date part verbatim would label
     * every figure one day late, which is invisible in a total and obvious in a
     * chart that ends tomorrow.
     */
    const days = normalizePageGrowth([
      insight("page_follows", [{ value: 100, endTime: "2026-08-03T07:00:00+0000" }]),
    ]);

    expect(days[0]?.metricDate).toBe("2026-08-02");
  });

  it("keeps a day where only one metric was reported", () => {
    // A gap in one series is not a gap in the others, and dropping the day
    // would put a hole in the follower line for no reason.
    const days = normalizePageGrowth([
      insight("page_follows", [{ value: 40_000, endTime: "2026-08-02T07:00:00+0000" }]),
      insight("page_daily_follows", []),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ followers: 40_000, newFollows: null });
  });

  it("ignores a metric it was not asked for", () => {
    // Meta sometimes returns extra series. An unrecognised name must not land
    // in a column it does not belong to.
    const days = normalizePageGrowth([
      insight("page_impressions", [{ value: 999, endTime: "2026-08-02T07:00:00+0000" }]),
    ]);

    expect(days).toHaveLength(0);
  });

  it("treats a nonsense value as absent rather than as zero", () => {
    const days = normalizePageGrowth([
      insight("page_follows", [
        { value: -1 as number, endTime: "2026-08-02T07:00:00+0000" },
        { value: Number.NaN, endTime: "2026-08-03T07:00:00+0000" },
      ]),
    ]);

    expect(days.every((day) => day.followers === null)).toBe(true);
  });

  it("only requests metrics that were probed", () => {
    /*
     * One invalid name fails the entire insights request. `page_fans`,
     * `page_fan_adds` and `page_impressions` are all rejected on v25 despite
     * appearing throughout Meta's documentation — adding one here would take
     * down the two that work.
     */
    expect([...PAGE_GROWTH_METRICS]).toEqual([
      "page_follows",
      "page_daily_follows",
      "page_views_total",
    ]);
  });
});

describe("growth over a window", () => {
  it("measures the change between the first and last day that carry a count", async () => {
    await seedDay("2026-08-01", 40_000, 5);
    await seedDay("2026-08-02", 40_007, 7);
    await seedDay("2026-08-03", 40_020, 13);

    const growth = await getPageGrowth({ streamerId });

    expect(growth.followers).toBe(40_020);
    expect(growth.change).toBe(20);
    expect(growth.from).toBe("2026-08-01");
    expect(growth.to).toBe("2026-08-03");
  });

  it("reports the window it actually covered, not the one requested", async () => {
    /*
     * A period can start before collection did. Anchoring to the requested
     * dates would compare a real figure against nothing; stating the covered
     * window is what makes the number auditable.
     */
    await seedDay("2026-08-02", 40_000, 5);
    await seedDay("2026-08-03", 40_010, 10);

    const growth = await getPageGrowth({
      streamerId,
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-08-31T00:00:00Z"),
    });

    expect(growth.from).toBe("2026-08-02");
    expect(growth.to).toBe("2026-08-03");
  });

  it("keeps new follows separate from the change in total", async () => {
    // Seven arrived, three left: the total moved by four. Deriving either
    // figure from the other would be wrong, and both are worth knowing.
    await seedDay("2026-08-02", 40_000, 0);
    await seedDay("2026-08-03", 40_004, 7);

    const growth = await getPageGrowth({ streamerId });

    expect(growth.change).toBe(4);
    expect(growth.newFollows).toBe(7);
  });

  it("refuses to report a percentage from a base of zero", async () => {
    // "Grew by ∞%" is not a fact anyone can act on.
    await seedDay("2026-08-02", 0, 0);
    await seedDay("2026-08-03", 50, 50);

    const growth = await getPageGrowth({ streamerId });

    expect(growth.change).toBe(50);
    expect(growth.changePercent).toBeNull();
  });

  it("declines to state a change from a single day", async () => {
    await seedDay("2026-08-03", 40_000, 5);

    const growth = await getPageGrowth({ streamerId });

    expect(growth.followers).toBe(40_000);
    expect(growth.change).toBeNull();
  });

  it("returns an empty shape rather than failing when nothing is collected", async () => {
    const growth = await getPageGrowth({ streamerId });

    expect(growth.series).toEqual([]);
    expect(growth.followers).toBeNull();
    expect(growth.newFollows).toBe(0);
  });

  it("keeps a day with no count in the series, so the chart shows the gap", async () => {
    await seedDay("2026-08-01", 40_000, 5);
    await seedDay("2026-08-02", null, 7);
    await seedDay("2026-08-03", 40_020, 8);

    const growth = await getPageGrowth({ streamerId });

    expect(growth.series).toHaveLength(3);
    expect(growth.series[1]?.followers).toBeNull();
    // The endpoints skip the gap rather than treating it as zero.
    expect(growth.change).toBe(20);
  });

  it("obeys the period bounds", async () => {
    await seedDay("2026-07-01", 39_000, 1);
    await seedDay("2026-08-02", 40_000, 5);
    await seedDay("2026-08-03", 40_010, 10);

    const growth = await getPageGrowth({
      streamerId,
      from: new Date("2026-08-01T00:00:00Z"),
      to: null,
    });

    expect(growth.series).toHaveLength(2);
    expect(growth.change).toBe(10);
  });
});

describe("across the roster", () => {
  it("sums followers per day before comparing endpoints", async () => {
    const second = await client.query<{ id: string }>(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('GROW2', 'Grow Two', '987654321098765', 'Grow Two Page') returning id`,
    );

    await seedDay("2026-08-02", 40_000, 5);
    await seedDay("2026-08-03", 40_010, 10);

    for (const [day, followers, gained] of [
      ["2026-08-02", 1_000, 2],
      ["2026-08-03", 1_050, 50],
    ] as const) {
      await client.query(
        `insert into page_metrics_daily (streamer_id, metric_date, followers, new_follows)
         values ($1, $2, $3, $4)`,
        [second.rows[0]!.id, day, followers, gained],
      );
    }

    const roster = await getRosterGrowth({});

    expect(roster.followers).toBe(41_060);
    expect(roster.change).toBe(60);
    expect(roster.newFollows).toBe(67);
  });
});
