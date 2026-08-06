/**
 * Canonical audit action names.
 *
 * Pure module so both the writer and the UI (which labels them) share one list.
 * The database enforces the `namespace.verb` shape with a check constraint.
 */

export const AUDIT_ACTIONS = {
  // Phase 2 — identity
  userInvited: "user.invited",
  userDeactivated: "user.deactivated",
  userReactivated: "user.reactivated",
  userRoleChanged: "user.role_changed",
  userSignedIn: "user.signed_in",
  /** An invitee chose their first password. Never records the password. */
  userPasswordSet: "user.password_set",
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
  /**
   * Irreversible removal of a streamer and everything collected for it.
   *
   * Distinct from `streamer.deleted`, which retires a record and keeps the
   * content. This entry is the only remaining evidence that the streamer ever
   * existed, so its metadata carries the identity and the destroyed counts.
   */
  streamerPurged: "streamer.purged",
  streamerSyncRequested: "streamer.sync_requested",

  /**
   * The games registry, and which streamer covers what.
   *
   * Separate from `streamer.updated` because attribution changes what every
   * report says a post was about — a silent edit to a hashtag re-files history,
   * and "why did last month's Cabal Mobile numbers change" has to be answerable.
   */
  gameCreated: "game.created",
  gameUpdated: "game.updated",
  gameDeleted: "game.deleted",
  streamerGamesChanged: "streamer.games_changed",

  /**
   * A workspace preference changed from the interface.
   *
   * Worth recording even though nothing it controls changes a stored number.
   * Hiding an option from a filter changes what every later reader sees by
   * default, and "the dashboard has been showing a fraction of the archive
   * since Tuesday" needs a Tuesday to point at.
   */
  settingUpdated: "setting.updated",

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

  /**
   * The unattended comment backfill, kept distinct from a sweep.
   *
   * The two run on separate schedules and fail for separate reasons, and the
   * trail's usefulness depends on being able to ask "was the drain running last
   * week?" without a sweep's entries drowning the answer.
   */
  commentBackfillStarted: "automation.comment_backfill_started",

  // Phase 3 — Page tokens. Separate from streamer.* so a credential change is
  // never buried inside a routine field edit in the trail.
  tokenAdded: "token.added",
  tokenReplaced: "token.replaced",
  tokenValidated: "token.validated",
  /** A stored Page token was swapped for a longer-lived one from Meta. */
  tokenExtended: "token.extended",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ENTITY_TYPES = {
  user: "user",
  streamer: "streamer",
  syncRun: "sync_run",
  post: "post",
  video: "video",
  game: "game",
  setting: "setting",
} as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[keyof typeof AUDIT_ENTITY_TYPES];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  [AUDIT_ACTIONS.userInvited]: "User invited",
  [AUDIT_ACTIONS.userDeactivated]: "User deactivated",
  [AUDIT_ACTIONS.userReactivated]: "User reactivated",
  [AUDIT_ACTIONS.userRoleChanged]: "Role changed",
  [AUDIT_ACTIONS.userSignedIn]: "Signed in",
  [AUDIT_ACTIONS.userPasswordSet]: "Password set",
  [AUDIT_ACTIONS.userSignedOut]: "Signed out",
  [AUDIT_ACTIONS.userSignInFailed]: "Sign-in failed",
  [AUDIT_ACTIONS.userSignInThrottled]: "Sign-in throttled",

  [AUDIT_ACTIONS.streamerCreated]: "Streamer created",
  [AUDIT_ACTIONS.streamerUpdated]: "Streamer updated",
  [AUDIT_ACTIONS.streamerDisabled]: "Streamer disabled",
  [AUDIT_ACTIONS.streamerEnabled]: "Streamer enabled",
  [AUDIT_ACTIONS.streamerDeleted]: "Streamer removed from roster",
  [AUDIT_ACTIONS.streamerPurged]: "Streamer permanently deleted",
  [AUDIT_ACTIONS.streamerSyncRequested]: "Manual sync requested",
  [AUDIT_ACTIONS.gameCreated]: "Game added",
  [AUDIT_ACTIONS.gameUpdated]: "Game updated",
  [AUDIT_ACTIONS.gameDeleted]: "Game deleted",
  [AUDIT_ACTIONS.streamerGamesChanged]: "Streamer games changed",
  [AUDIT_ACTIONS.settingUpdated]: "Setting changed",
  [AUDIT_ACTIONS.postsSynced]: "Posts synchronised",
  [AUDIT_ACTIONS.commentsSynced]: "Comments synchronised",
  [AUDIT_ACTIONS.commentsSummarized]: "Comments summarised",
  [AUDIT_ACTIONS.videosSynced]: "Videos synchronised",
  [AUDIT_ACTIONS.automationSyncStarted]: "Automation sweep started",
  [AUDIT_ACTIONS.automationSyncCompleted]: "Automation sweep completed",
  [AUDIT_ACTIONS.commentBackfillStarted]: "Comment backfill started",

  [AUDIT_ACTIONS.tokenAdded]: "Token added",
  [AUDIT_ACTIONS.tokenReplaced]: "Token replaced",
  [AUDIT_ACTIONS.tokenValidated]: "Token validated",
  [AUDIT_ACTIONS.tokenExtended]: "Token extended",
};
