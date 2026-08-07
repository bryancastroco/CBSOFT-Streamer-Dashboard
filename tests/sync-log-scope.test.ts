import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";

/**
 * What "Whole roster · N streamers" counts.
 *
 * It counted child runs. A sweep opens one child per streamer *per phase* —
 * posts, then videos — so the screen reported eight streamers on a roster of
 * four, and would have reported twelve had a third phase ever been added.
 *
 * Nothing could catch that from the inside: the number was real, plausible, and
 * only wrong against a fact the query never had. So this seeds a known roster
 * and asserts the label against it.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { listSyncLogs } = await import("@/lib/repositories/sync-logs");

let client: PGlite;

async function seedStreamer(code: string, pageId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ($1, $2, $3, $4) returning id`,
    [code, code, pageId, `${code} Page`],
  );
  return row.rows[0]!.id;
}

async function seedParent(): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into sync_runs (sync_type, status, completed_at)
     values ('automation', 'completed', now()) returning id`,
  );
  return row.rows[0]!.id;
}

async function seedChild(parentId: string, streamerId: string): Promise<void> {
  await client.query(
    `insert into sync_runs (sync_type, status, streamer_id, parent_sync_run_id, completed_at)
     values ('automation', 'completed', $1, $2, now())`,
    [streamerId, parentId],
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
  await client.query("delete from sync_runs");
  await client.query("delete from streamers");
});

describe("the scope column counts streamers", () => {
  it("counts a streamer once even though it opened two child runs", async () => {
    // The production shape exactly: four streamers, a posts phase and a videos
    // phase each, which read as eight.
    const parent = await seedParent();

    for (let index = 0; index < 4; index += 1) {
      const streamerId = await seedStreamer(`CBS-${index}`, `1000000000000${index}`);
      await seedChild(parent, streamerId); // posts
      await seedChild(parent, streamerId); // videos
    }

    const [row] = await listSyncLogs(10);

    expect(row?.streamerCount).toBe(4);
  });

  it("does not change when a run gains another phase", async () => {
    const parent = await seedParent();
    const streamerId = await seedStreamer("CBS-1", "10000000000010");

    await seedChild(parent, streamerId);
    expect((await listSyncLogs(10))[0]?.streamerCount).toBe(1);

    await seedChild(parent, streamerId);
    await seedChild(parent, streamerId);

    // Three child rows, still one streamer. Under the old count this rose to 3.
    expect((await listSyncLogs(10))[0]?.streamerCount).toBe(1);
  });

  it("reports zero for a run that spawned nothing", async () => {
    await seedParent();

    // A single-streamer manual run has no children, and the screen relies on
    // this being zero to omit the suffix entirely rather than print "0".
    expect((await listSyncLogs(10))[0]?.streamerCount).toBe(0);
  });

  it("keeps each parent's count to its own children", async () => {
    const first = await seedParent();
    const second = await seedParent();

    const a = await seedStreamer("CBS-A", "10000000000020");
    const b = await seedStreamer("CBS-B", "10000000000021");

    await seedChild(first, a);
    await seedChild(second, a);
    await seedChild(second, b);

    const rows = await listSyncLogs(10);
    const byId = new Map(rows.map((row) => [row.id, row.streamerCount]));

    expect(byId.get(first)).toBe(1);
    expect(byId.get(second)).toBe(2);
  });
});
