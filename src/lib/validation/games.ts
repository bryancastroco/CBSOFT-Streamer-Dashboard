import { z } from "zod";

import { parseHashtagList, slugifyGameName } from "@/lib/games/hashtags";

/**
 * Input contracts for the games registry — a PURE module.
 *
 * Shared by the Server Action and its tests. The form does no validation the
 * server does not repeat.
 */

export const gameIdSchema = z.uuid("A valid game is required");

/**
 * The slug is derived when left blank rather than demanded.
 *
 * Somebody adding "Cabal: Infinite Combo" should not have to think about URLs,
 * but somebody who cares about the link should be able to set it. Generated
 * from the name only when the field is empty, so an explicit slug is never
 * silently rewritten by a later rename.
 */
export const gameFormSchema = z
  .object({
    id: gameIdSchema.optional(),
    name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
    slug: z.string().trim().max(60, "Slug is too long").optional().default(""),
    notes: z.string().trim().max(2000, "Notes are too long").optional().default(""),
    active: z.boolean().default(true),
    /** Free text: commas, spaces and newlines all separate. */
    hashtags: z.string().max(4000, "That is a lot of hashtags").optional().default(""),
  })
  .transform((value) => {
    const parsed = parseHashtagList(value.hashtags);

    return {
      ...value,
      slug: value.slug.length > 0 ? value.slug : slugifyGameName(value.name),
      notes: value.notes.length > 0 ? value.notes : null,
      hashtags: parsed.tags,
      rejectedHashtags: parsed.rejected,
    };
  })
  .refine((value) => /^[a-z0-9][a-z0-9-]*$/.test(value.slug), {
    message: "Slug may contain only lower-case letters, digits and hyphens",
    path: ["slug"],
  });

export type GameFormInput = z.infer<typeof gameFormSchema>;

/**
 * A streamer's game assignments.
 *
 * `primaryGameId` is optional because a streamer may cover games without any
 * of them being the assumption for untagged content — the repository drops a
 * primary that is not in the selected set rather than trusting the form.
 */
export const streamerGamesSchema = z.object({
  streamerId: z.uuid("A valid streamer is required"),
  gameIds: z.array(gameIdSchema).max(50, "That is too many games"),
  primaryGameId: gameIdSchema.nullable().optional(),
});

export type StreamerGamesInput = z.infer<typeof streamerGamesSchema>;
