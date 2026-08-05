import { z } from "zod";

/**
 * Input contracts for streamer administration.
 *
 * Shared by the Server Actions, the API routes and the tests, so the browser
 * form and an n8n-style HTTP caller are held to exactly the same rules. The
 * database check constraints enforce the same shapes a second time.
 */

/** `CBS-014` — uppercase alphanumeric, may contain internal hyphens. */
export const streamerCodeSchema = z
  .string()
  .trim()
  .min(2, "Streamer code must be at least 2 characters")
  .max(32, "Streamer code must be 32 characters or fewer")
  .regex(
    /^[A-Z0-9][A-Z0-9-]*$/,
    "Use uppercase letters, digits and hyphens only, starting with a letter or digit",
  );

/** Meta Page IDs are numeric strings, typically 15–16 digits. */
export const pageIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9]+$/, "Facebook Page ID must be numeric")
  .min(5, "Facebook Page ID looks too short")
  .max(32, "Facebook Page ID looks too long");

/**
 * A Page access token.
 *
 * Only shape is checked — length and absence of whitespace. Whether it *works*
 * is decided by Meta, not by a regex, and pretending otherwise would reject
 * valid tokens when Meta changes its format.
 */
export const pageTokenSchema = z
  .string()
  .trim()
  .min(20, "That does not look like a Page access token")
  .max(1000, "Token is implausibly long")
  .refine((value) => !/\s/.test(value), "Token must not contain whitespace");

export const createStreamerSchema = z.object({
  streamerName: z.string().trim().min(1, "Streamer name is required").max(120),
  streamerCode: streamerCodeSchema,
  pageId: pageIdSchema,
  pageName: z.string().trim().min(1, "Page name is required").max(120),
  /** Optional at creation: a streamer can be added before its token exists. */
  pageAccessToken: pageTokenSchema.optional().or(z.literal("")),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
  active: z.boolean().default(true),
});

export type CreateStreamerInput = z.infer<typeof createStreamerSchema>;

/**
 * Edits. Every field optional — PATCH semantics.
 * The token is deliberately NOT editable here; it has its own endpoint so that
 * replacing a credential is always a distinct, separately audited act.
 */
export const updateStreamerSchema = z
  .object({
    streamerName: z.string().trim().min(1).max(120).optional(),
    streamerCode: streamerCodeSchema.optional(),
    pageId: pageIdSchema.optional(),
    pageName: z.string().trim().min(1).max(120).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes were supplied");

export type UpdateStreamerInput = z.infer<typeof updateStreamerSchema>;

export const replaceTokenSchema = z.object({
  pageAccessToken: pageTokenSchema,
});

export type ReplaceTokenInput = z.infer<typeof replaceTokenSchema>;

export const streamerIdSchema = z.uuid("A valid streamer id is required");

export const listStreamersQuerySchema = z.object({
  /** Soft-deleted rows are excluded unless explicitly requested. */
  includeDeleted: z.coerce.boolean().default(false),
  activeOnly: z.coerce.boolean().default(false),
  search: z.string().trim().max(120).optional(),
});

export type ListStreamersQuery = z.infer<typeof listStreamersQuerySchema>;

/**
 * The phrase that must be typed to destroy a streamer and all of its data.
 *
 * Deliberately not the streamer code on its own — that is what the reversible
 * removal already asks for. Two irreversible-looking fields accepting the same
 * six characters is how the wrong one gets filled in from muscle memory, and
 * only one of the two can be undone. This one names the consequence.
 *
 * Lives here rather than beside the action because a `"use server"` module may
 * export only async functions; a plain one throws at module evaluation.
 */
export function purgeConfirmationFor(streamerCode: string): string {
  return `DELETE ALL ${streamerCode}`;
}
