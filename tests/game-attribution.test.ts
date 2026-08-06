import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  extractHashtags,
  normaliseHashtag,
  parseHashtagList,
  resolveGameFor,
  slugifyGameName,
} from "@/lib/games/hashtags";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * Which game a post is about, and the rule that decides it.
 *
 * ## The measurement that shaped this
 *
 * 102 of 1,624 posts carry any hashtag. Attribution by tag alone would leave
 * 94% of the roster unfilterable, so a streamer declares a primary game and
 * untagged content inherits it. A tag is evidence about *this post*; the
 * streamer's game is an assumption about their output in general — so the
 * specific beats the general, and `game_source` records which applied.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

// Imported after the mock, like `resolveContentGames`: both reach the database
// through `getDb`, and a static import would bind the real one.
const { resolveContentGames } = await import("@/lib/services/resolve-games");
const { listPosts } = await import("@/lib/repositories/posts");
const { getStreamerOverview } = await import("@/lib/repositories/metrics");
const { getGameFilterOptions, setGameFilterOptions } = await import(
  "@/lib/repositories/app-settings"
);
const { defaultGameSelection } = await import("@/lib/services/game-filter-view");
const { ANY_GAME, UNFILED_GAME } = await import("@/lib/filters/browse");

let client: PGlite;
let streamerId: string;
let mobileId: string;
let pcId: string;

async function seedPost(handle: string, message: string | null): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, message, raw_json)
     values ($1, $2, now(), $3, '{}'::jsonb) returning id`,
    [streamerId, handle, message],
  );
  return row.rows[0]!.id;
}

async function gameOf(postId: string) {
  const row = await client.query<{ game_id: string | null; game_source: string | null }>(
    `select game_id, game_source from posts where id = $1`,
    [postId],
  );
  return row.rows[0]!;
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
  await client.query("delete from games");

  const streamer = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ('GAME', 'Game', $1, 'Game Page') returning id`,
    [FAKE_PAGE_ID],
  );
  streamerId = streamer.rows[0]!.id;

  const mobile = await client.query<{ id: string }>(
    `insert into games (name, slug) values ('Cabal Mobile', 'cabal-mobile') returning id`,
  );
  mobileId = mobile.rows[0]!.id;

  const pc = await client.query<{ id: string }>(
    `insert into games (name, slug) values ('Cabal Online', 'cabal-online') returning id`,
  );
  pcId = pc.rows[0]!.id;

  await client.query(`insert into game_hashtags (game_id, tag) values ($1, 'cabalmobile')`, [
    mobileId,
  ]);
  await client.query(`insert into game_hashtags (game_id, tag) values ($1, 'cabalmsea')`, [
    mobileId,
  ]);
  await client.query(`insert into game_hashtags (game_id, tag) values ($1, 'cabalsea')`, [pcId]);
});

describe("reading tags out of text", () => {
  it("lower-cases, because Facebook does not care about case", () => {
    expect(extractHashtags("Live now! #CabalSEA #MMORPG")).toEqual(["cabalsea", "mmorpg"]);
  });

  it("stops a tag at a hyphen, as Facebook does", () => {
    // `#cabal-sea` is the tag `cabal` followed by text. Treating the whole
    // thing as one tag would never match anything.
    expect(extractHashtags("#cabal-sea")).toEqual(["cabal"]);
  });

  it("keeps the first occurrence and drops repeats", () => {
    expect(extractHashtags("#a #b #a")).toEqual(["a", "b"]);
  });

  it("finds nothing in text without tags, and in no text at all", () => {
    expect(extractHashtags("just a normal post")).toEqual([]);
    expect(extractHashtags(null)).toEqual([]);
  });

  it("accepts what an admin actually types", () => {
    expect(normaliseHashtag("#CabalSEA")).toBe("cabalsea");
    expect(normaliseHashtag("  cabalsea ")).toBe("cabalsea");
    expect(normaliseHashtag("##cabalsea")).toBe("cabalsea");
    expect(normaliseHashtag("cabal sea")).toBeNull();
    expect(normaliseHashtag("")).toBeNull();
  });

  it("takes a pasted list however it was separated", () => {
    const { tags, rejected } = parseHashtagList("#CabalSEA, cabalmobile\n#cabal-pc  cabalmsea");

    // One malformed entry must not discard the nine good ones pasted with it.
    expect(tags).toEqual(["cabalsea", "cabalmobile", "cabalmsea"]);
    expect(rejected).toEqual(["#cabal-pc"]);
  });

  it("makes a usable slug from a name", () => {
    expect(slugifyGameName("Cabal: Infinite Combo")).toBe("cabal-infinite-combo");
    expect(slugifyGameName("  Pokémon GO  ")).toBe("pokemon-go");
  });
});

describe("the resolution rule, in isolation", () => {
  const hashtagToGame = new Map([["cabalmobile", "game-mobile"]]);

  it("prefers a tag over the streamer's game", () => {
    const result = resolveGameFor({
      text: "stream tonight #CabalMobile",
      hashtagToGame,
      primaryGameId: "game-pc",
    });

    expect(result).toEqual({ gameId: "game-mobile", source: "hashtag" });
  });

  it("falls back to the streamer's game when nothing matches", () => {
    const result = resolveGameFor({
      text: "stream tonight",
      hashtagToGame,
      primaryGameId: "game-pc",
    });

    expect(result).toEqual({ gameId: "game-pc", source: "streamer" });
  });

  it("ignores a tag that belongs to no game", () => {
    const result = resolveGameFor({
      text: "#mmorpg #hardcorerpg",
      hashtagToGame,
      primaryGameId: "game-pc",
    });

    expect(result.source).toBe("streamer");
  });

  it("leaves content unattributed when there is nothing to go on", () => {
    const result = resolveGameFor({ text: "hello", hashtagToGame, primaryGameId: null });

    expect(result).toEqual({ gameId: null, source: null });
  });

  it("uses the first recognised tag when several match", () => {
    // A post that opens #CabalMobile and later lists other channels is about
    // the mobile game.
    const both = new Map([
      ["cabalmobile", "game-mobile"],
      ["cabalsea", "game-pc"],
    ]);

    const result = resolveGameFor({
      text: "#CabalMobile stream — also on #CabalSEA",
      hashtagToGame: both,
      primaryGameId: null,
    });

    expect(result.gameId).toBe("game-mobile");
  });
});

describe("resolving the stored roster", () => {
  it("attributes by tag, and records that it was a tag", async () => {
    const post = await seedPost("tagged", "Live now #CabalMobile");
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );

    await resolveContentGames();

    expect(await gameOf(post)).toEqual({ game_id: mobileId, game_source: "hashtag" });
  });

  it("falls back to the primary game, and says it assumed", async () => {
    const post = await seedPost("untagged", "no tags here");
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );

    await resolveContentGames();

    expect(await gameOf(post)).toEqual({ game_id: pcId, game_source: "streamer" });
  });

  it("leaves content alone when the streamer has no primary game", async () => {
    const post = await seedPost("orphan", "no tags here");
    // Assigned, but not primary — so there is nothing to assume.
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, false)`,
      [streamerId, pcId],
    );

    const summary = await resolveContentGames();

    expect(await gameOf(post)).toEqual({ game_id: null, game_source: null });
    expect(summary.unattributed).toBe(1);
  });

  it("re-files history when a hashtag is added to a game", async () => {
    /*
     * The reason this is a re-runnable pass rather than a trigger. An admin
     * adding `#cabalpcsea` to Cabal Online expects the posts that already
     * mention it to move, not just future ones.
     */
    const post = await seedPost("later", "throwback #CabalPCSEA");
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, mobileId],
    );

    await resolveContentGames();
    expect((await gameOf(post)).game_source).toBe("streamer");

    await client.query(`insert into game_hashtags (game_id, tag) values ($1, 'cabalpcsea')`, [pcId]);
    await resolveContentGames();

    expect(await gameOf(post)).toEqual({ game_id: pcId, game_source: "hashtag" });
  });

  it("re-files when the primary game moves", async () => {
    const post = await seedPost("untagged", "no tags");
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );
    await resolveContentGames();
    expect((await gameOf(post)).game_id).toBe(pcId);

    await client.query(`delete from streamer_games where streamer_id = $1`, [streamerId]);
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, mobileId],
    );
    await resolveContentGames();

    expect((await gameOf(post)).game_id).toBe(mobileId);
  });

  it("changes nothing at all when no games are configured", async () => {
    /*
     * The state on the first run. Clearing every attribution would be a
     * destructive answer to "nothing has been set up yet".
     */
    await client.query(`delete from games`);
    const post = await seedPost("any", "#CabalMobile");

    const summary = await resolveContentGames();

    expect(summary.postsUpdated).toBe(0);
    expect((await gameOf(post)).game_id).toBeNull();
  });

  it("writes only the rows whose answer moved", async () => {
    await seedPost("a", "#CabalMobile");
    await seedPost("b", "#CabalMobile");
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );

    const first = await resolveContentGames();
    expect(first.postsUpdated).toBe(2);

    // Nothing changed in between, so the second pass should be a no-op.
    const second = await resolveContentGames();
    expect(second.postsUpdated).toBe(0);
  });

  it("survives a game being deleted, keeping the posts", async () => {
    // `on delete set null`: the content is the record, the game is a label.
    const post = await seedPost("tagged", "#CabalMobile");
    await resolveContentGames();
    expect((await gameOf(post)).game_id).toBe(mobileId);

    await client.query(`delete from games where id = $1`, [mobileId]);

    const still = await client.query<{ n: number }>(`select count(*)::int as n from posts`);
    expect(still.rows[0]?.n).toBe(1);
    expect((await gameOf(post)).game_id).toBeNull();
  });
});

describe("the database's own guarantees", () => {
  it("refuses the same hashtag on two games", async () => {
    // Ambiguity would leave the resolver guessing which game a post is about.
    const duplicate = client.query(
      `insert into game_hashtags (game_id, tag) values ($1, 'cabalmobile')`,
      [pcId],
    );

    await expect(duplicate).rejects.toThrow();
  });

  it("refuses a second primary game for one streamer", async () => {
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );

    const second = client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, mobileId],
    );

    await expect(second).rejects.toThrow();
  });

  it("allows many non-primary games for one streamer", async () => {
    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, true)`,
      [streamerId, pcId],
    );

    const second = client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, false)`,
      [streamerId, mobileId],
    );

    await expect(second).resolves.toBeDefined();
  });

  it("refuses a hashtag that could never match", async () => {
    const bad = client.query(`insert into game_hashtags (game_id, tag) values ($1, '#CabalSEA')`, [
      pcId,
    ]);

    await expect(bad).rejects.toThrow();
  });
});

/**
 * The filter, against a real Postgres.
 *
 * `gameClause` is three lines and one of them is the interesting one. A
 * selection of "no game" has to become `is null` and "every registered game"
 * `is not null`; compared against the sentinel string either would error, or
 * worse match nothing and read as an empty result rather than a broken filter.
 * All four cases are pinned together, because the bug this guards against is
 * one of them silently behaving like another — and the pair most likely to
 * collapse, "no filter" and "any game", differ by 1,617 rows on real data.
 */
describe("filtering by game", () => {
  beforeEach(async () => {
    await client.query("delete from posts");

    await client.query(
      `insert into streamer_games (streamer_id, game_id, is_primary) values ($1, $2, false)`,
      [streamerId, mobileId],
    );

    await seedPost("filter-tagged", "Ranked grind #CabalSEA");
    await seedPost("filter-other", "Boss run #CabalMobile");
    await seedPost("filter-plain", "Good morning everyone");

    await resolveContentGames();
  });

  const codes = async (gameId: string | undefined) => {
    const { items, total } = await listPosts({ gameId, limit: 25, offset: 0 });
    // `total` is computed by a second query over the same predicate, so a
    // filter applied to one and not the other shows up here rather than in
    // a pagination bug three screens away.
    expect(total).toBe(items.length);
    return items.map((item) => item.facebookPostId).sort();
  };

  it("selects one game", async () => {
    expect(await codes(pcId)).toEqual(["filter-tagged"]);
  });

  it("selects content filed under nothing, rather than everything", async () => {
    // The streamer has a non-primary assignment, so the plain post inherits
    // nothing — which is the state this sentinel exists to find.
    expect(await codes(UNFILED_GAME)).toEqual(["filter-plain"]);
  });

  it("selects every registered game together, excluding the rest", async () => {
    expect(await codes(ANY_GAME)).toEqual(["filter-other", "filter-tagged"]);
  });

  it("selects everything when no game is given", async () => {
    expect(await codes(undefined)).toEqual(["filter-other", "filter-plain", "filter-tagged"]);
  });

  it("keeps no filter and every-registered-game apart", async () => {
    // The two read alike in a dropdown and are not the same set. Conflating
    // them is how a default silently stops showing unattributed content.
    const everything = await codes(undefined);
    const registered = await codes(ANY_GAME);
    const unregistered = await codes(UNFILED_GAME);

    expect(registered).not.toEqual(everything);
    // And the two halves partition the whole, with nothing lost between them.
    expect([...registered, ...unregistered].sort()).toEqual(everything);
  });

  it("reports the game and how it was decided on each row", async () => {
    const { items } = await listPosts({ gameId: mobileId, limit: 25, offset: 0 });

    expect(items).toHaveLength(1);
    expect(items[0]!.gameName).toBe("Cabal Mobile");
    expect(items[0]!.gameSource).toBe("hashtag");
  });
});

/**
 * The streamer Overview tab.
 *
 * Its figures come from `metrics.ts` aggregates rather than from `listPosts`,
 * so "the filter works on the table" is not evidence that it works here. This
 * is the case where a missed clause is least visible: the counts stay
 * plausible, they just describe more content than the reader selected.
 */
describe("the streamer overview honours a game", () => {
  beforeEach(async () => {
    await client.query("delete from posts");

    await seedPost("ov-pc", "Ranked grind #CabalSEA");
    await seedPost("ov-mobile-a", "Boss run #CabalMobile");
    await seedPost("ov-mobile-b", "Another run #CabalMSEA");

    await resolveContentGames();
  });

  it("counts only the selected game's posts", async () => {
    const filtered = await getStreamerOverview({ streamerId, gameId: mobileId });
    const all = await getStreamerOverview({ streamerId });

    expect(filtered.postCount).toBe(2);
    expect(all.postCount).toBe(3);
  });

  it("counts the unattributed as its own selection, not as everything", async () => {
    await seedPost("ov-plain", "Good morning");
    await resolveContentGames();

    const unfiled = await getStreamerOverview({ streamerId, gameId: UNFILED_GAME });

    expect(unfiled.postCount).toBe(1);
  });
});

/**
 * The workspace preference behind the two wide filter entries.
 *
 * Worth testing against a real Postgres rather than mocking the read, because
 * the interesting cases are all about a row that is absent or wrong — and those
 * are exactly what a mock would paper over.
 */
describe("the game filter preference", () => {
  let actorId: string;

  beforeAll(async () => {
    /*
     * Through `auth.users`, not `public.users`. The public row is created by
     * the `handle_new_auth_user` trigger and its id is a foreign key to the
     * auth table, so inserting directly there fails the constraint.
     *
     * Created once rather than per test, because `audit_logs` refuses DELETE —
     * the append-only trigger is the property that makes the trail worth having
     * — and a user that has written an entry can no longer be removed.
     */
    const user = await client.query<{ id: string }>(
      `insert into auth.users (email) values ('settings-admin@example.test') returning id`,
    );
    actorId = user.rows[0]!.id;
  });

  beforeEach(async () => {
    await client.query("delete from app_settings");
  });

  it("defaults to hiding both when nothing has been saved", async () => {
    // The common case: a workspace that has never opened the setting. It must
    // read as the documented default rather than as an error.
    expect(await getGameFilterOptions()).toEqual({
      showAllContent: false,
      showUnregistered: false,
    });
  });

  it("round-trips a saved preference", async () => {
    await setGameFilterOptions({
      actorId,
      options: { showAllContent: true, showUnregistered: false },
    });

    expect(await getGameFilterOptions()).toEqual({
      showAllContent: true,
      showUnregistered: false,
    });
  });

  it("overwrites rather than accumulating rows", async () => {
    await setGameFilterOptions({
      actorId,
      options: { showAllContent: true, showUnregistered: true },
    });
    await setGameFilterOptions({
      actorId,
      options: { showAllContent: false, showUnregistered: false },
    });

    const rows = await client.query<{ n: number }>(`select count(*)::int as n from app_settings`);

    expect(rows.rows[0]!.n).toBe(1);
    expect(await getGameFilterOptions()).toEqual({
      showAllContent: false,
      showUnregistered: false,
    });
  });

  it("degrades to the default on a row it cannot read", async () => {
    // A row written by another version, or edited by hand. A dropdown is not
    // worth a 500, so the unreadable preference reads as the safe one.
    await client.query(
      `insert into app_settings (key, value_json)
       values ('game_filter.options', '{"showAllContent":"yes"}'::jsonb)`,
    );

    expect(await getGameFilterOptions()).toEqual({
      showAllContent: false,
      showUnregistered: false,
    });
  });

  it("records the change with both halves of it", async () => {
    await setGameFilterOptions({
      actorId,
      options: { showAllContent: true, showUnregistered: true },
    });

    // Newest first, and not asserted to be the only one: the trail is
    // append-only, so earlier tests in this file have left their own entries.
    const entry = await client.query<{ entity_id: string; metadata_json: unknown }>(
      `select entity_id, metadata_json from audit_logs
        where action = 'setting.updated'
        order by created_at desc limit 1`,
    );

    expect(entry.rows[0]!.entity_id).toBe("game_filter.options");

    // Before and after, because "who turned this off, and from what" is
    // answerable only if the trail records the previous value too.
    const metadata = entry.rows[0]!.metadata_json as { previous: unknown; next: unknown };
    expect(metadata.previous).toEqual({ showAllContent: false, showUnregistered: false });
    expect(metadata.next).toEqual({ showAllContent: true, showUnregistered: true });
  });
});

/**
 * The one rule that is not a preference.
 *
 * With an empty catalogue, defaulting to "every registered game" selects
 * nothing — so every screen would render empty on a fresh workspace, with
 * nothing visible resembling a cause. Pinned here because it is the kind of
 * safety clause a later simplification removes for looking redundant.
 */
describe("the default selection", () => {
  it("is the catalogue once a game exists", () => {
    expect(defaultGameSelection(1)).toBe(ANY_GAME);
    expect(defaultGameSelection(12)).toBe(ANY_GAME);
  });

  it("is no filter at all when nothing is registered", () => {
    expect(defaultGameSelection(0)).toBeUndefined();
  });
});
