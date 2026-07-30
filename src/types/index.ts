/**
 * Shared domain types. Kept deliberately small in Phase 1 — the authoritative
 * types will be inferred from the Drizzle schema once tables exist (Phase 2+).
 */

export type AppRole = "admin" | "manager" | "streamer";

export type SyncStatus = "pending" | "running" | "succeeded" | "failed" | "partial";

export type PageConnectionStatus =
  "connected" | "token_expired" | "permissions_revoked" | "disconnected";

/** Shape every placeholder endpoint returns while unimplemented. */
export type NotImplementedResponse = {
  error: "not_implemented";
  phase: number;
  endpoint: string;
  message: string;
};
