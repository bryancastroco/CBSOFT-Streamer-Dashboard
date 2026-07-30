/**
 * Canonical audit action names.
 *
 * Pure module so both the writer and the UI (which labels them) share one list.
 * The database enforces the `namespace.verb` shape with a check constraint.
 */

export const AUDIT_ACTIONS = {
  // Phase 2 — identity
  userRoleChanged: "user.role_changed",
  userSignedIn: "user.signed_in",
  userSignedOut: "user.signed_out",
  userSignInFailed: "user.sign_in_failed",
  /** Phase 10: refused by the login throttle before credentials were checked. */
  userSignInThrottled: "user.sign_in_throttled",

  // Phase 3 — streamer administration
  streamerCreated: "streamer.created",
  streamerUpdated: "streamer.updated",
  streamerDisabled: "streamer.disabled",
  streamerEnabled: "streamer.enabled",
  streamerDeleted: "streamer.deleted",
  streamerSyncRequested: "streamer.sync_requested",

  // Phase 4 — synchronisation
  postsSynced: "posts.synced",

  // Phase 5 — comments and AI summaries
  commentsSynced: "comments.synced",
  commentsSummarized: "comments.summarized",

  // Phase 6 — video synchronisation
  videosSynced: "videos.synced",

  // Phase 8 — n8n automation. Recorded with a null user: n8n is a machine
  // actor, and attributing a sweep to a person would corrupt the trail's
  // answer to "who did this?".
  automationSyncStarted: "automation.sync_started",
  automationSyncCompleted: "automation.sync_completed",

  // Phase 3 — Page tokens. Separate from streamer.* so a credential change is
  // never buried inside a routine field edit in the trail.
  tokenAdded: "token.added",
  tokenReplaced: "token.replaced",
  tokenValidated: "token.validated",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ENTITY_TYPES = {
  user: "user",
  streamer: "streamer",
  syncRun: "sync_run",
  post: "post",
  video: "video",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  [AUDIT_ACTIONS.userRoleChanged]: "Role changed",
  [AUDIT_ACTIONS.userSignedIn]: "Signed in",
  [AUDIT_ACTIONS.userSignedOut]: "Signed out",
  [AUDIT_ACTIONS.userSignInFailed]: "Sign-in failed",
  [AUDIT_ACTIONS.userSignInThrottled]: "Sign-in throttled",

  [AUDIT_ACTIONS.streamerCreated]: "Streamer created",
  [AUDIT_ACTIONS.streamerUpdated]: "Streamer updated",
  [AUDIT_ACTIONS.streamerDisabled]: "Streamer disabled",
  [AUDIT_ACTIONS.streamerEnabled]: "Streamer enabled",
  [AUDIT_ACTIONS.streamerDeleted]: "Streamer deleted",
  [AUDIT_ACTIONS.streamerSyncRequested]: "Manual sync requested",
  [AUDIT_ACTIONS.postsSynced]: "Posts synchronised",
  [AUDIT_ACTIONS.commentsSynced]: "Comments synchronised",
  [AUDIT_ACTIONS.commentsSummarized]: "Comments summarised",
  [AUDIT_ACTIONS.videosSynced]: "Videos synchronised",
  [AUDIT_ACTIONS.automationSyncStarted]: "Automation sweep started",
  [AUDIT_ACTIONS.automationSyncCompleted]: "Automation sweep completed",

  [AUDIT_ACTIONS.tokenAdded]: "Token added",
  [AUDIT_ACTIONS.tokenReplaced]: "Token replaced",
  [AUDIT_ACTIONS.tokenValidated]: "Token validated",
};
