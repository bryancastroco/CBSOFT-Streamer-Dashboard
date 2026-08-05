import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";

/**
 * Releasing a sweep that a platform kill left holding the lock.
 *
 * ## The failure this prevents, which had already happened
 *
 * A serverless function killed at `maxDuration` runs no `catch`, no `finally`
 * and no cleanup. It stops. The `sync_runs` row it opened stays `processing`.
 *
 * `sync_runs_one_active_sweep_idx` admits exactly one top-level run in `queued`
 * or `processing`, and the cron refuses to start while one is in flight. So one
 * killed invocation blocks *every* subsequent sweep — permanently, silently,
 * with nothing raised anywhere. Collection stops and the dashboard goes stale
 * while every screen still reports success.
 *
 * The run opened at 03:17 on 5 August was still `processing` eighteen hours
 * later, and would have refused every night after it.
 *
 * ## Why this is against a real Postgres
 *
 * The deadlock is a property of the partial unique index, not of the code
 * around it. A mock would happily accept a second insert and prove nothing.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

vi.mock("@/config/env", () => ({
  getServerEnv: () => ({
    CONTENT_SYNC_LOOKBACK_DAYS: 30,
    MAX_POSTS_PER_STREAMER: 100,
    MAX_VIDEOS_PER_STREAMER: 100,
    MAX_STREAMERS_PER_SYNC: 5,
    SYNC_FREQUENCY_HOURS: 6,
    AI_SUMMARIZATION_ENABLED: true,
    META_GRAPH_API_VERSION: "v25.0",
  }),
}));

const { openSyncAllRun, reclaimAbandonedSweeps, SweepAlreadyRunningError, SWEEP_ABANDONED_AFTER_MS } =
  await import("@/lib/services/sync-all");

let client: PGlite;

/** A top-level run left `processing`, as a killed invocation leaves it. */
async function seedAbandonedRun(ageMs: number): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into sync_runs (streamer_id, sync_type, trigger_source, status, started_at)
     values (null, 'automation', 'vercel_cron', 'processing', now() - ($1 || ' milliseconds')::interval)
     returning id`,
    [String(ageMs)],
  );

  return result.rows[0]!.id;
}

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from sync_runs");
});

describe("a run left open by a kill", () => {
  it("blocks the next sweep until it is reclaimed", async () => {
    /*
     * The bug, demonstrated at the database level. Without the reclaim the
     * partial unique index refuses the insert, and every night after it too.
     */
    await seedAbandonedRun(SWEEP_ABANDONED_AFTER_MS * 2);

    const direct = client.query(
      `insert into sync_runs (streamer_id, sync_type, status)
       values (null, 'automation', 'processing')`,
    );

    await expect(direct).rejects.toThrow();
  });

  it("is reclaimed once it is older than the threshold", async () => {
    const id = await seedAbandonedRun(SWEEP_ABANDONED_AFTER_MS + 60_000);

    expect(await reclaimAbandonedSweeps()).toBe(1);

    const row = await client.query<{ status: string; completed_at: string | null }>(
      `select status, completed_at from sync_runs where id = $1`,
      [id],
    );

    // `cancelled`, not `failed`: nothing went wrong, the clock ran out. A
    // failure would demand an error describing a fault that did not occur and
    // would show up on the health screens as something to investigate.
    expect(row.rows[0]?.status).toBe("cancelled");
    expect(row.rows[0]?.completed_at).not.toBeNull();
  });

  it("lets the next sweep start again", async () => {
    await seedAbandonedRun(SWEEP_ABANDONED_AFTER_MS * 2);

    // `openSyncAllRun` reclaims before inserting, so this is the whole
    // recovery path in one call.
    const id = await openSyncAllRun("vercel_cron");

    expect(id).toBeTruthy();
  });
});

describe("a sweep that is genuinely working", () => {
  it("is left alone", async () => {
    /*
     * A live run is advanced across several invocations and its `started_at`
     * does not move, so the threshold has to be well beyond one function
     * window — reclaiming a working sweep would start a second one against the
     * same Pages, doubling Graph spend and racing its upserts.
     */
    const id = await seedAbandonedRun(30_000);

    expect(await reclaimAbandonedSweeps()).toBe(0);

    const row = await client.query<{ status: string }>(
      `select status from sync_runs where id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe("processing");
  });

  it("still refuses a concurrent sweep", async () => {
    await seedAbandonedRun(30_000);

    // Overlap protection must survive the reclaim being added: two sweeps
    // against the same Pages double the quota spend and race each other.
    await expect(openSyncAllRun("vercel_cron")).rejects.toBeInstanceOf(SweepAlreadyRunningError);
  });
});

describe("what the reclaim does not touch", () => {
  it("leaves a streamer's child run alone", async () => {
    /*
     * Only top-level runs hold the sweep lock. A child row belongs to one
     * streamer and cannot block anything, so cancelling it would rewrite
     * history for no benefit.
     */
    const streamer = await client.query<{ id: string }>(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('CHILD', 'Child', '123456789012345', 'Child Page') returning id`,
    );

    await client.query(
      `insert into sync_runs (streamer_id, sync_type, status, started_at)
       values ($1, 'manual', 'processing', now() - interval '3 hours')`,
      [streamer.rows[0]!.id],
    );

    expect(await reclaimAbandonedSweeps()).toBe(0);
  });

  it("leaves a run that already finished alone", async () => {
    await client.query(
      `insert into sync_runs (streamer_id, sync_type, status, started_at, completed_at)
       values (null, 'automation', 'completed', now() - interval '2 days', now() - interval '2 days')`,
    );

    expect(await reclaimAbandonedSweeps()).toBe(0);
  });
});
