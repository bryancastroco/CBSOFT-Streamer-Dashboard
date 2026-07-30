import { z } from "zod";

/** Input contracts for the Phase 6 video endpoints. */

export const syncVideosSchema = z.object({
  /** Only fetch videos published after this instant. Omit for a full walk. */
  since: z.iso.datetime().optional(),
  maxPages: z.coerce.number().int().min(1).max(100).optional(),
  concurrency: z.coerce.number().int().min(1).max(8).optional(),
});

export type SyncVideosInput = z.infer<typeof syncVideosSchema>;

export const listVideosQuerySchema = z.object({
  streamerId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListVideosQuery = z.infer<typeof listVideosQuerySchema>;

export const videoIdSchema = z.uuid("A valid video id is required");
