import "server-only";

import { eq, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { getDb } from "@/lib/db";
import { appSettings, auditLogs } from "@/lib/db/schema";
import {
  GAME_FILTER_OPTIONS_DEFAULT,
  GAME_FILTER_OPTIONS_KEY,
  parseGameFilterOptions,
  type GameFilterOptions,
} from "@/lib/settings/game-filter";

/**
 * Workspace preferences set from the interface.
 *
 * Every read parses through the setting's own Zod schema, so a missing row, a
 * row written by an older version, or a hand-edited one all degrade to the
 * documented default. Nothing here throws: these decide what a dropdown offers,
 * which is never worth failing a page render over.
 */

export async function getGameFilterOptions(): Promise<GameFilterOptions> {
  const db = getDb();

  const [row] = await db
    .select({ value: appSettings.valueJson })
    .from(appSettings)
    .where(eq(appSettings.key, GAME_FILTER_OPTIONS_KEY))
    .limit(1);

  // No row is the common case and the correct one — a workspace that has never
  // opened the setting gets the default rather than an error.
  if (!row) return GAME_FILTER_OPTIONS_DEFAULT;

  return parseGameFilterOptions(row.value);
}

/**
 * Write the preference and record who changed it, in one transaction.
 *
 * The audit entry carries both halves of the change. Nothing this controls
 * alters a stored number, but it does alter what every later reader sees by
 * default — "the dashboard has been showing a fraction of the archive since
 * Tuesday" needs a Tuesday to point at, and a name beside it.
 */
export async function setGameFilterOptions(params: {
  actorId: string;
  options: GameFilterOptions;
}): Promise<GameFilterOptions> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [previousRow] = await tx
      .select({ value: appSettings.valueJson })
      .from(appSettings)
      .where(eq(appSettings.key, GAME_FILTER_OPTIONS_KEY))
      .limit(1);

    const previous = previousRow
      ? parseGameFilterOptions(previousRow.value)
      : GAME_FILTER_OPTIONS_DEFAULT;

    await tx
      .insert(appSettings)
      .values({
        key: GAME_FILTER_OPTIONS_KEY,
        valueJson: params.options,
        updatedBy: params.actorId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          valueJson: sql`excluded.value_json`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`now()`,
        },
      });

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.settingUpdated,
      entityType: AUDIT_ENTITY_TYPES.setting,
      /*
       * The key, not a uuid. `entity_id` is a text column precisely so a
       * non-uuid identity can be recorded — a setting has no row id worth
       * pointing at, and the key is what someone reading the trail would search
       * for.
       */
      entityId: GAME_FILTER_OPTIONS_KEY,
      metadataJson: { key: GAME_FILTER_OPTIONS_KEY, previous, next: params.options },
    });

    return params.options;
  });
}
