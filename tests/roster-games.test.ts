import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { ALL_CONTENT, ANY_GAME, UNFILED_GAME } from "@/lib/filters/browse";

import { createTestDatabase } from "./helpers/test-database";

/**
 * Filtering the roster by game.
 *
 * The predicate is not the one content uses. A post carries `game_id`; a
 * streamer carries an assignment in `streamer_games`, so "who covers Cabal" and
 * "what is filed under Cabal" are different questions over different tables.
 *
 * The distinction matters most in the week a streamer publishes nothing: they
 * are still on the title, and a roster that dropped them would be answering
 * "who was active" while appearing to answer "who is on this game".
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { listStreamerRoster } = await import("@/lib/repositories/metrics");

let client: PGlite;
let cabalId: string;
let robloxId: string;

async function seedStreamer(code: string, pageId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ($1, $2, $3, $2) returning id`,
    [code, code, pageId],
  );
  return row.rows[0]!.id;
}

async function assign(streamerId: string, gameId: string, primary: boolean): Promise<void> {
  await client.query(
    `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, $3)`,
    [streamerId, gameId, primary],
  );
}

const codes = async (gameId?: string) =>
  (await listStreamerRoster({ gameId })).map((row) => row.streamerCode).sort();

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");
  await client.query("delete from games");

  const cabal = await client.query<{ id: string }>(
    `insert into games (name, slug) values ('Cabal', 'cabal') returning id`,
  );
  cabalId = cabal.rows[0]!.id;

  const roblox = await client.query<{ id: string }>(
    `insert into games (name, slug) values ('Roblox', 'roblox') returning id`,
  );
  robloxId = roblox.rows[0]!.id;

  // Production in miniature: two assigned, one on both, one on nothing.
  const bladz = await seedStreamer("STM-001", "10000000000001");
  const vamp = await seedStreamer("STM-002", "10000000000002");
  await seedStreamer("STM-003", "10000000000003");

  await assign(bladz, cabalId, true);
  await assign(vamp, cabalId, false);
  await assign(vamp, robloxId, true);
});

describe("filtering the roster by game", () => {
  it("returns everyone when nothing is chosen", async () => {
    expect(await codes()).toEqual(["STM-001", "STM-002", "STM-003"]);
    expect(await codes(ALL_CONTENT)).toEqual(["STM-001", "STM-002", "STM-003"]);
  });

  it("returns the streamers assigned that game", async () => {
    expect(await codes(cabalId)).toEqual(["STM-001", "STM-002"]);
    expect(await codes(robloxId)).toEqual(["STM-002"]);
  });

  it("returns each streamer once even when they cover several games", async () => {
    // The join would duplicate; the predicate is an EXISTS for this reason.
    const all = await listStreamerRoster({ gameId: ANY_GAME });
    const vamp = all.filter((row) => row.streamerCode === "STM-002");

    expect(vamp).toHaveLength(1);
  });

  it("finds the streamers nobody has assigned a game to", async () => {
    // The useful one on this screen: it answers "whose setup is unfinished",
    // which is the question behind most content that cannot be filtered.
    expect(await codes(UNFILED_GAME)).toEqual(["STM-003"]);
  });

  it("keeps a streamer in a game filter through a week they published nothing", async () => {
    // No posts or videos are seeded at all. The roster is about who covers
    // what, not who was busy.
    expect(await codes(cabalId)).toContain("STM-001");
  });
});

describe("the games column", () => {
  it("lists a streamer's titles, primary first", async () => {
    const [vamp] = (await listStreamerRoster({})).filter((row) => row.streamerCode === "STM-002");

    expect(vamp?.games.map((game) => game.name)).toEqual(["Roblox", "Cabal"]);
    expect(vamp?.games[0]?.isPrimary).toBe(true);
    expect(vamp?.games[1]?.isPrimary).toBe(false);
  });

  it("is an empty list, not null, for a streamer with none", async () => {
    // The cell renders "None assigned" from `length === 0`; a null would crash
    // it, and a missing key would read as "not loaded".
    const [orphan] = (await listStreamerRoster({})).filter((row) => row.streamerCode === "STM-003");

    expect(orphan?.games).toEqual([]);
  });
});
