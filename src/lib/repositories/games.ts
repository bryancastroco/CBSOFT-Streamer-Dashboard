import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { getDb } from "@/lib/db";
import { resultRows } from "@/lib/db/params";
import { auditLogs, gameHashtags, games, streamerGames, streamers } from "@/lib/db/schema";
import { normaliseHashtag } from "@/lib/games/hashtags";
import type { GameOption, GameRow, StreamerGameAssignment } from "@/lib/ui/game-shapes";

/**
 * The games registry.
 *
 * A game is a label applied to content, so nothing here deletes content — see
 * `on delete set null` in migration 0017. Removing a game unfiles its posts; it
 * does not remove them.
 */

/*
 * Declared in `lib/ui/game-shapes.ts` and re-exported here, because the forms
 * that render them are Client Components and this module imports `server-only`.
 */
export type { GameOption, GameRow, StreamerGameAssignment };

export type GameOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "not_found" | "duplicate_name" | "duplicate_slug" | "duplicate_tag"; message: string };

/**
 * Every game with its tags and how much is filed under it.
 *
 * The counts are the point of the screen: a game with no hashtags and no
 * streamers is configured but inert, and that is invisible from the name alone.
 */
export async function listGames(): Promise<GameRow[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: games.id,
      name: games.name,
      slug: games.slug,
      active: games.active,
      notes: games.notes,
      streamerCount: sql<number>`(
        select count(*) from ${streamerGames} sg where sg.game_id = ${games.id}
      )::int`,
      postCount: sql<number>`(select count(*) from posts p where p.game_id = ${games.id})::int`,
      videoCount: sql<number>`(select count(*) from videos v where v.game_id = ${games.id})::int`,
    })
    .from(games)
    .orderBy(asc(games.name));

  if (rows.length === 0) return [];

  const tags = await db
    .select({ gameId: gameHashtags.gameId, tag: gameHashtags.tag })
    .from(gameHashtags)
    .where(
      inArray(
        gameHashtags.gameId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(gameHashtags.tag));

  const byGame = new Map<string, string[]>();
  for (const tag of tags) {
    byGame.set(tag.gameId, [...(byGame.get(tag.gameId) ?? []), tag.tag]);
  }

  return rows.map((row) => ({ ...row, hashtags: byGame.get(row.id) ?? [] }));
}

export async function getGame(id: string): Promise<GameRow | null> {
  const all = await listGames();
  return all.find((game) => game.id === id) ?? null;
}

/**
 * Create or update a game and replace its hashtag set in one transaction.
 *
 * Replace rather than merge: the admin form shows the full list, so what is
 * submitted *is* the intended set, and a tag removed from the textarea is a tag
 * the operator meant to remove. Merging would make deletion impossible from the
 * only screen that offers it.
 */
export async function saveGame(params: {
  actorId: string;
  id?: string | undefined;
  name: string;
  slug: string;
  active: boolean;
  notes: string | null;
  hashtags: readonly string[];
}): Promise<GameOutcome<{ id: string }>> {
  const db = getDb();

  const tags = [
    ...new Set(
      params.hashtags
        .map((tag) => normaliseHashtag(tag))
        .filter((tag): tag is string => tag !== null),
    ),
  ];

  return db.transaction(async (tx) => {
    /*
     * Checked before writing, so the operator gets "that tag is already on
     * Cabal Online" rather than a unique-violation stack trace. The index is
     * still the authority — this is a better error, not the guarantee.
     */
    if (tags.length > 0) {
      const clash = await tx
        .select({ tag: gameHashtags.tag, gameId: gameHashtags.gameId })
        .from(gameHashtags)
        .where(inArray(gameHashtags.tag, tags));

      const foreign = clash.filter((row) => row.gameId !== params.id);

      if (foreign.length > 0) {
        const names = await tx
          .select({ id: games.id, name: games.name })
          .from(games)
          .where(
            inArray(
              games.id,
              foreign.map((row) => row.gameId),
            ),
          );

        const owner = names[0]?.name ?? "another game";

        return {
          ok: false as const,
          reason: "duplicate_tag" as const,
          message: `#${foreign[0]?.tag} is already assigned to ${owner}. A hashtag can only name one game.`,
        };
      }
    }

    let gameId = params.id;

    try {
      if (gameId) {
        const [updated] = await tx
          .update(games)
          .set({
            name: params.name,
            slug: params.slug,
            active: params.active,
            notes: params.notes,
            updatedAt: new Date(),
          })
          .where(eq(games.id, gameId))
          .returning({ id: games.id });

        if (!updated) {
          return { ok: false as const, reason: "not_found" as const, message: "That game no longer exists." };
        }
      } else {
        const [created] = await tx
          .insert(games)
          .values({
            name: params.name,
            slug: params.slug,
            active: params.active,
            notes: params.notes,
          })
          .returning({ id: games.id });

        gameId = created!.id;
      }
    } catch (cause) {
      if (isUniqueViolation(cause, "games_slug_key")) {
        return { ok: false as const, reason: "duplicate_slug" as const, message: "That slug is already in use." };
      }
      if (isUniqueViolation(cause, "games_name_lower_key")) {
        return { ok: false as const, reason: "duplicate_name" as const, message: "A game with that name already exists." };
      }
      throw cause;
    }

    await tx.delete(gameHashtags).where(eq(gameHashtags.gameId, gameId));

    if (tags.length > 0) {
      await tx.insert(gameHashtags).values(tags.map((tag) => ({ gameId: gameId!, tag })));
    }

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: params.id ? AUDIT_ACTIONS.gameUpdated : AUDIT_ACTIONS.gameCreated,
      entityType: AUDIT_ENTITY_TYPES.game,
      entityId: gameId,
      metadataJson: { name: params.name, slug: params.slug, hashtags: tags },
    });

    return { ok: true as const, data: { id: gameId } };
  });
}

export async function deleteGame(params: {
  actorId: string;
  id: string;
}): Promise<GameOutcome<{ name: string }>> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: games.id, name: games.name })
      .from(games)
      .where(eq(games.id, params.id));

    if (!existing) {
      return { ok: false as const, reason: "not_found" as const, message: "That game no longer exists." };
    }

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.gameDeleted,
      entityType: AUDIT_ENTITY_TYPES.game,
      entityId: params.id,
      metadataJson: { name: existing.name },
    });

    // Cascades to hashtags and assignments; posts keep their rows and lose the
    // label, because `posts.game_id` is `on delete set null`.
    await tx.delete(games).where(eq(games.id, params.id));

    return { ok: true as const, data: { name: existing.name } };
  });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function listStreamerGames(streamerId: string): Promise<StreamerGameAssignment[]> {
  const db = getDb();

  return db
    .select({
      gameId: games.id,
      name: games.name,
      slug: games.slug,
      isPrimary: streamerGames.isPrimary,
    })
    .from(streamerGames)
    .innerJoin(games, eq(games.id, streamerGames.gameId))
    .where(eq(streamerGames.streamerId, streamerId))
    .orderBy(asc(games.name));
}

/**
 * Replace a streamer's game assignments.
 *
 * The whole set is rewritten because the form submits the whole set. A partial
 * update would need a diff the operator never expressed.
 *
 * The primary is validated rather than trusted: a primary that is not in the
 * selected list would leave untagged content attributed to a game the streamer
 * is no longer marked as covering.
 */
export async function setStreamerGames(params: {
  actorId: string;
  streamerId: string;
  gameIds: readonly string[];
  primaryGameId: string | null;
}): Promise<GameOutcome<{ count: number }>> {
  const db = getDb();

  const unique = [...new Set(params.gameIds)];
  const primary = params.primaryGameId && unique.includes(params.primaryGameId)
    ? params.primaryGameId
    : null;

  return db.transaction(async (tx) => {
    const [streamer] = await tx
      .select({ id: streamers.id, code: streamers.streamerCode })
      .from(streamers)
      .where(eq(streamers.id, params.streamerId));

    if (!streamer) {
      return { ok: false as const, reason: "not_found" as const, message: "That streamer no longer exists." };
    }

    await tx.delete(streamerGames).where(eq(streamerGames.streamerId, params.streamerId));

    if (unique.length > 0) {
      await tx.insert(streamerGames).values(
        unique.map((gameId) => ({
          streamerId: params.streamerId,
          gameId,
          isPrimary: gameId === primary,
        })),
      );
    }

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.streamerGamesChanged,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.streamerId,
      metadataJson: { streamerCode: streamer.code, games: unique.length, primaryGameId: primary },
    });

    return { ok: true as const, data: { count: unique.length } };
  });
}

/**
 * Content that reached no game at all.
 *
 * Surfaced on the admin screen rather than left to be discovered. A registry
 * that looks configured while most of the archive falls outside it is the
 * failure mode here, and the number is the only way to see it — the games
 * themselves each show a healthy count regardless.
 */
export async function countUnattributedContent(): Promise<number> {
  const db = getDb();

  // `resultRows`, because postgres.js hands back an array and PGlite hands back
  // `{ rows }` — destructuring one of them throws under the other.
  const result = await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from posts  where game_id is null) +
      (select count(*) from videos where game_id is null)
    )::int as n
  `);

  return Number(resultRows<{ n: number }>(result)[0]?.n ?? 0);
}

/** Games that may be offered in a filter: active, and worth filtering by. */
export async function listGameOptions(): Promise<GameOption[]> {
  const db = getDb();

  return db
    .select({ id: games.id, name: games.name, slug: games.slug })
    .from(games)
    .where(eq(games.active, true))
    .orderBy(asc(games.name));
}

/** Resolve a slug from a URL to an id, or null when it names nothing. */
export async function findGameBySlug(slug: string): Promise<{ id: string; name: string } | null> {
  const db = getDb();

  const [row] = await db
    .select({ id: games.id, name: games.name })
    .from(games)
    .where(and(eq(games.slug, slug), eq(games.active, true)))
    .limit(1);

  return row ?? null;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object") {
      const record = candidate as { code?: string; constraint_name?: string; message?: string };
      if (record.code !== "23505") continue;
      if (record.constraint_name === constraint) return true;
      if (record.message?.includes(constraint)) return true;
    }
  }
  return false;
}
