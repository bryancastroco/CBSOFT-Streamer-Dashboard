import { z } from "zod";

/** Input contracts for the Phase 4 post endpoints. */

export const syncPostsSchema = z.object({
  /** Only fetch posts published after this instant. Omit for a full walk. */
  since: z.iso.datetime().optional(),
  /** Safety valve against an unbounded backfill. */
  maxPages: z.coerce.number().int().min(1).max(100).optional(),
  concurrency: z.coerce.number().int().min(1).max(8).optional(),
});

export type SyncPostsInput = z.infer<typeof syncPostsSchema>;

export const listPostsQuerySchema = z.object({
  streamerId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const postIdSchema = z.uuid("A valid post id is required");
