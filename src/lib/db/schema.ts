import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Phase 2 schema.
 *
 * Notes that apply to every table:
 *   - `id` is uuid; application tables default to `gen_random_uuid()`.
 *   - `users.id` is NOT generated — it mirrors `auth.users.id`, which Supabase
 *     Auth owns. The foreign key lives in the RLS migration because Drizzle
 *     cannot reference a table outside the `public` schema.
 *   - All timestamps are `timestamptz`, always UTC.
 *   - RLS, column-level grants, triggers and the `auth.users` foreign key are
 *     applied by `drizzle/0001_phase2_security.sql`. Drizzle owns the tables;
 *     that migration owns the security posture.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Two roles, per the Phase 2 specification.
 *
 * `viewer` is the default for every newly provisioned account: a user who
 * signs in before an admin has granted anything gets read-only access, never
 * administrative access. Fail closed.
 */
export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);

/**
 * Health of a stored Facebook Page token.
 *
 * The six health values come from the Phase 3 specification. `missing` is
 * retained from Phase 2 for the distinct state "no token has ever been
 * stored" — it is not a health verdict, and it is what
 * `streamers_token_consistency_check` keys on. Note it is unrelated to
 * `missing_permission`, which means "the token works but lacks a scope".
 */
export const tokenStatusEnum = pgEnum("token_status", [
  "missing",
  "valid",
  "expiring",
  "expired",
  "invalid",
  "missing_permission",
  "unknown",
]);

/**
 * Why a run happened.
 *
 * `automation` was added in Phase 8 for runs an n8n workflow triggered. It is a
 * distinct value rather than a reuse of `full` because "did last night's
 * scheduled workflow run?" and "did somebody click Sync Posts?" are different
 * operational questions, and answering the first by filtering on `full` would
 * silently include a manual backfill.
 */
export const syncTypeEnum = pgEnum("sync_type", [
  "full",
  "incremental",
  "manual",
  "backfill",
  "token_check",
  "automation",
]);

/**
 * Outcome of one export request.
 *
 * Only two values: an export either produced its rows or it did not. Unlike a
 * sync there is no `partial` — a page that returns fewer rows than the limit is
 * the last page, not a failure.
 */
export const exportStatusEnum = pgEnum("export_status", ["succeeded", "failed"]);

/**
 * The lifecycle of one synchronisation run.
 *
 * Order matches the enum's physical order, which Phase 13's in-place renames
 * preserved — `cancelled` is the only genuinely new value and therefore sorts
 * last rather than alphabetically.
 *
 * `completed_with_errors` is the important one. A sweep where nine Pages of ten
 * succeeded is not a failure, and reporting it as one trains an operator to
 * ignore the status field entirely.
 */
export const syncStatusEnum = pgEnum("sync_status", [
  /** Created, not yet started. */
  "queued",
  /** Working. The only non-terminal state a run can sit in for long. */
  "processing",
  /** Everything attempted, everything succeeded. */
  "completed",
  /** Nothing usable was produced. */
  "failed",
  /** Some streamers or items succeeded and some did not. */
  "completed_with_errors",
  /** Stopped deliberately. Distinguishes "abandoned" from "still running". */
  "cancelled",
]);

/**
 * Who asked for a run.
 *
 * Deliberately separate from `sync_type`, which says what the run *did*. The
 * first question asked of a misbehaving run is who triggered it, and inferring
 * that from the type was guesswork.
 */
export const triggerSourceEnum = pgEnum("trigger_source", [
  "admin",
  "n8n",
  "vercel_cron",
  "system_retry",
]);

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    /** Mirrors `auth.users.id`. Not generated here — Supabase Auth owns it. */
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    role: userRoleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness: Supabase Auth already treats email as
    // case-insensitive, so storing `A@x.com` and `a@x.com` as two rows would
    // desynchronise this table from `auth.users`.
    uniqueIndex("users_email_lower_key").on(sql`lower(${table.email})`),
    index("users_role_idx").on(table.role),
    check("users_email_format_check", sql`position('@' in ${table.email}) > 1`),
  ],
);

// ---------------------------------------------------------------------------
// streamers
// ---------------------------------------------------------------------------

export const streamers = pgTable(
  "streamers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Human-readable business key, e.g. `CBS-014`. */
    streamerCode: text("streamer_code").notNull(),
    streamerName: text("streamer_name").notNull(),

    /** Meta Page ID. Public identifier — safe to display and export. */
    pageId: text("page_id").notNull(),
    pageName: text("page_name").notNull(),

    /**
     * AES-256-GCM ciphertext produced by `src/lib/crypto/tokens.ts`.
     * Never selectable by the `anon` or `authenticated` roles — see the
     * column-level REVOKE in the security migration.
     */
    encryptedPageToken: text("encrypted_page_token"),

    /** Last four characters of the PLAINTEXT token, for operator recognition. */
    pageTokenLastFour: varchar("page_token_last_four", { length: 4 }),

    tokenStatus: tokenStatusEnum("token_status").notNull().default("missing"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenScopes: text("token_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** When the token was last checked against the Meta Graph API. */
    tokenLastValidatedAt: timestamp("token_last_validated_at", { withTimezone: true }),
    /**
     * Why the last validation did not return `valid`, in operator-readable
     * form. Never contains token material — see `describeValidation()`.
     */
    tokenValidationError: text("token_validation_error"),

    active: boolean("active").notNull().default(true),
    notes: text("notes"),

    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete. A deleted streamer keeps its sync history. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Partial uniqueness: a code or Page may be reused after a soft delete,
    // but may never be duplicated among live rows.
    uniqueIndex("streamers_streamer_code_active_key")
      .on(table.streamerCode)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("streamers_page_id_active_key")
      .on(table.pageId)
      .where(sql`${table.deletedAt} is null`),

    index("streamers_active_idx")
      .on(table.active)
      .where(sql`${table.deletedAt} is null`),
    index("streamers_token_status_idx").on(table.tokenStatus),
    index("streamers_last_successful_sync_at_idx").on(table.lastSuccessfulSyncAt),

    check(
      "streamers_streamer_code_format_check",
      sql`${table.streamerCode} ~ '^[A-Z0-9][A-Z0-9-]*$'`,
    ),
    check("streamers_page_id_format_check", sql`${table.pageId} ~ '^[0-9]+$'`),
    check("streamers_last_four_length_check", sql`${table.pageTokenLastFour} ~ '^.{4}$'`),

    // A stored token must always carry its recognition suffix and a status
    // other than `missing`; an absent token must carry neither. This makes the
    // "is this Page connected?" question answerable from one column.
    check(
      "streamers_token_consistency_check",
      sql`(${table.encryptedPageToken} is null and ${table.pageTokenLastFour} is null and ${table.tokenStatus} = 'missing')
        or (${table.encryptedPageToken} is not null and ${table.pageTokenLastFour} is not null and ${table.tokenStatus} <> 'missing')`,
    ),

    // Ciphertext only. Guards against a plaintext token being written by a bug
    // in a future phase: the crypto envelope always starts with `v1.`.
    check(
      "streamers_token_is_ciphertext_check",
      sql`${table.encryptedPageToken} is null or ${table.encryptedPageToken} ~ '^v[0-9]+\\.'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// sync_runs
// ---------------------------------------------------------------------------

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Nullable: a roster-wide run belongs to no single streamer.
     * `on delete set null` keeps the run history after a hard delete.
     */
    streamerId: uuid("streamer_id").references(() => streamers.id, { onDelete: "set null" }),

    /**
     * The roster-wide run this one belongs to, for an automation sweep.
     *
     * `sync-all` opens one parent run and each streamer's post and video syncs
     * open their own children, so a workflow polling one id can be told the
     * state of the whole sweep. Self-referencing and nullable: a manual sync has
     * no parent, and `on delete set null` keeps a child's history if the parent
     * is ever removed.
     */
    parentSyncRunId: uuid("parent_sync_run_id").references((): AnyPgColumn => syncRuns.id, {
      onDelete: "set null",
    }),

    syncType: syncTypeEnum("sync_type").notNull(),
    /** Who asked. Nullable: rows predating Phase 13 genuinely do not know. */
    triggerSource: triggerSourceEnum("trigger_source"),
    status: syncStatusEnum("status").notNull().default("queued"),

    postsProcessed: integer("posts_processed").notNull().default(0),
    videosProcessed: integer("videos_processed").notNull().default(0),
    commentsProcessed: integer("comments_processed").notNull().default(0),
    summariesGenerated: integer("summaries_generated").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    errorMessage: text("error_message"),
    /** Structured failure detail. Must never contain token material. */
    errorDetailsJson: jsonb("error_details_json"),
  },
  (table) => [
    index("sync_runs_streamer_id_started_at_idx").on(table.streamerId, table.startedAt.desc()),
    index("sync_runs_status_idx").on(table.status),
    index("sync_runs_started_at_idx").on(table.startedAt.desc()),
    // Partial index for "what is running right now?" — the hot admin query.
    index("sync_runs_in_flight_idx")
      .on(table.startedAt.desc())
      .where(sql`${table.status} in ('pending', 'running')`),
    // The status endpoint's only query: "every child of this parent".
    index("sync_runs_parent_id_idx").on(table.parentSyncRunId),

    // A run cannot be its own parent. Cheap to state, and it makes an
    // accidental self-link a write error rather than an infinite walk.
    check("sync_runs_parent_not_self_check", sql`${table.parentSyncRunId} <> ${table.id}`),

    check(
      "sync_runs_counters_non_negative_check",
      sql`${table.postsProcessed} >= 0 and ${table.videosProcessed} >= 0
        and ${table.commentsProcessed} >= 0 and ${table.summariesGenerated} >= 0`,
    ),
    check(
      "sync_runs_completed_after_started_check",
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`,
    ),
    // A terminal run must be closed off; an open run must not be.
    check(
      "sync_runs_terminal_status_check",
      sql`(${table.status} in ('succeeded', 'failed', 'partial') and ${table.completedAt} is not null)
        or (${table.status} in ('pending', 'running') and ${table.completedAt} is null)`,
    ),
    check(
      "sync_runs_failure_has_message_check",
      sql`${table.status} <> 'failed' or ${table.errorMessage} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// export_runs
// ---------------------------------------------------------------------------

/**
 * One row per automation export request.
 *
 * Phase 9. The Settings page has to answer four questions an operator asks when
 * a spreadsheet looks stale — did the last export succeed, when, how many rows
 * did it move, and is n8n reaching us at all — and none of them can be answered
 * from `sync_runs`, which records *collection from Meta*, not *delivery to
 * Sheets*. A sweep can succeed perfectly while every export request is being
 * rejected on a rotated secret.
 *
 * Written on the read path, which is unusual. It is affordable because an
 * export is a coarse operation — seven branches, a handful of pages each, once
 * a night — and the alternative is having no idea whether the mirror is being
 * fed.
 */
export const exportRuns = pgTable(
  "export_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The dataset name, e.g. `posts`. Text, not an enum: the dataset list is
     * owned by the export contract in application code, and a database enum
     * would mean a migration every time one was added. */
    dataset: text("dataset").notNull(),

    /** `json`, `sheets` or `csv`. */
    format: text("format").notNull().default("json"),

    /** `n8n` for the automation surface, `browser` for the CSV fallback. */
    caller: text("caller").notNull().default("n8n"),

    status: exportStatusEnum("status").notNull(),

    /** Rows actually returned by this request. */
    rowCount: integer("row_count").notNull().default(0),
    /** Rows matching the filters in total, so partial pages are recognisable. */
    totalAvailable: integer("total_available"),

    /** The filters that were applied. Never contains a secret. */
    filtersJson: jsonb("filters_json"),

    /** Sanitised. Never a raw database or Meta message. */
    errorMessage: text("error_message"),

    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "What happened most recently?" — the only query the Settings page runs.
    index("export_runs_created_at_idx").on(table.createdAt.desc()),
    index("export_runs_dataset_created_at_idx").on(table.dataset, table.createdAt.desc()),
    // Partial index for "when did an export last succeed?", which is the
    // headline figure and would otherwise scan every failure.
    index("export_runs_succeeded_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.status} = 'succeeded'`),

    check("export_runs_row_count_non_negative_check", sql`${table.rowCount} >= 0`),
    check(
      "export_runs_failure_has_message_check",
      sql`${table.status} <> 'failed' or ${table.errorMessage} is not null`,
    ),
  ],
);

export type ExportRunRow = typeof exportRuns.$inferSelect;
export type NewExportRunRow = typeof exportRuns.$inferInsert;

// ---------------------------------------------------------------------------
// audit_logs
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Nullable so the trail survives user deletion, and so machine actors
     * (cron, n8n) can be recorded with no user at all.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /** Dotted action name, e.g. `user.role_changed`. See `src/lib/audit/actions.ts`. */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    /** Text rather than uuid — some entities are keyed by a Meta identifier. */
    entityId: text("entity_id"),

    /** Structured context. Must never contain token material or secrets. */
    metadataJson: jsonb("metadata_json")
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt.desc()),
    index("audit_logs_user_id_created_at_idx").on(table.userId, table.createdAt.desc()),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),

    check("audit_logs_action_format_check", sql`${table.action} ~ '^[a-z_]+\\.[a-z_]+$'`),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export type StreamerRow = typeof streamers.$inferSelect;
export type NewStreamerRow = typeof streamers.$inferInsert;

export type SyncRunRow = typeof syncRuns.$inferSelect;
export type NewSyncRunRow = typeof syncRuns.$inferInsert;

/** The enum values, so callers can name a run type without a string literal. */
export type SyncRunType = (typeof syncTypeEnum.enumValues)[number];
export type SyncRunStatus = (typeof syncStatusEnum.enumValues)[number];

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;

// ---------------------------------------------------------------------------
// posts (Phase 4)
// ---------------------------------------------------------------------------

/**
 * A published Facebook Page post, as returned by `/{page-id}/published_posts`.
 *
 * Every count column is NULLABLE on purpose. Meta omits `shares` entirely from
 * a post with no shares, and omits summaries when a field is not permitted.
 * Storing 0 in those cases would be inventing data — null means "Meta did not
 * report this", which the UI renders as unavailable rather than as zero.
 */
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),

    /** Meta's own identifier, `{page-id}_{post-id}`. Globally unique. */
    facebookPostId: text("facebook_post_id").notNull(),

    message: text("message"),
    createdTime: timestamp("created_time", { withTimezone: true }).notNull(),
    permalinkUrl: text("permalink_url"),

    reactionCount: integer("reaction_count"),
    commentCount: integer("comment_count"),
    shareCount: integer("share_count"),

    /** The unmodified Graph response for this post, for later re-derivation. */
    rawJson: jsonb("raw_json").notNull(),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The external identifier is the upsert target, so a re-sync updates rather
    // than duplicates.
    uniqueIndex("posts_facebook_post_id_key").on(table.facebookPostId),

    index("posts_streamer_id_created_time_idx").on(table.streamerId, table.createdTime.desc()),
    index("posts_created_time_idx").on(table.createdTime.desc()),
    index("posts_last_synced_at_idx").on(table.lastSyncedAt.desc()),

    check(
      "posts_counts_non_negative_check",
      sql`(${table.reactionCount} is null or ${table.reactionCount} >= 0)
        and (${table.commentCount} is null or ${table.commentCount} >= 0)
        and (${table.shareCount} is null or ${table.shareCount} >= 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// post_insights (Phase 4)
// ---------------------------------------------------------------------------

/**
 * One metric returned by `/{post-id}/insights`.
 *
 * Deliberately schemaless in the metric dimension: `metric_name` and `period`
 * are plain text and nothing in the codebase enumerates them. Meta adds,
 * renames and retires post metrics regularly, and a hard-coded list would
 * silently drop whatever it did not anticipate.
 *
 * `value_json` is NULLABLE: Meta can return a metric with an empty `values`
 * array. That is "no value", not zero, and the distinction is preserved all
 * the way to the UI.
 */
export const postInsights = pgTable(
  "post_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),

    metricName: text("metric_name").notNull(),
    /** `lifetime`, `day`, `week`, `days_28`, … whatever Meta reports. */
    period: text("period"),

    /** The raw `value` from Meta — a number, an object of breakdowns, or null. */
    valueJson: jsonb("value_json"),
    endTime: timestamp("end_time", { withTimezone: true }),

    /** The unmodified insight entry, so nothing Meta sent is lost. */
    rawJson: jsonb("raw_json").notNull(),

    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Upsert key. `period` and `end_time` are coalesced because either may be
    // absent, and NULLs would otherwise defeat the uniqueness.
    uniqueIndex("post_insights_metric_key").on(
      table.postId,
      table.metricName,
      sql`coalesce(${table.period}, '')`,
      sql`coalesce(${table.endTime}, 'epoch'::timestamptz)`,
    ),

    index("post_insights_post_id_idx").on(table.postId),
    index("post_insights_metric_name_idx").on(table.metricName),
    index("post_insights_collected_at_idx").on(table.collectedAt.desc()),
  ],
);

export type PostRow = typeof posts.$inferSelect;
export type NewPostRow = typeof posts.$inferInsert;

export type PostInsightRow = typeof postInsights.$inferSelect;
export type NewPostInsightRow = typeof postInsights.$inferInsert;

// ---------------------------------------------------------------------------
// videos (Phase 6)
// ---------------------------------------------------------------------------

/**
 * A video published on a Facebook Page, from `/{page-id}/videos`.
 *
 * Deliberately NOT `/live_videos`: that edge can require separate Meta App
 * Review, and `/videos` returns broadcasts as VODs once they end. Reading the
 * general edge keeps the integration inside the permissions the Page token
 * already carries.
 */
export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    streamerId: uuid("streamer_id")
      .notNull()
      .references(() => streamers.id, { onDelete: "cascade" }),

    /** Meta's identifier for the video. Globally unique. */
    facebookVideoId: text("facebook_video_id").notNull(),

    title: text("title"),
    description: text("description"),

    /**
     * Meta reports `length` as fractional seconds, so this is stored as a
     * float. Rounding to whole seconds at ingestion would discard precision
     * the source actually provided.
     */
    lengthSeconds: doublePrecision("length_seconds"),

    createdTime: timestamp("created_time", { withTimezone: true }).notNull(),
    permalinkUrl: text("permalink_url"),

    /** The unmodified Graph response, for later re-derivation. */
    rawJson: jsonb("raw_json").notNull(),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The external identifier is the upsert target, so a re-sync updates rather
    // than duplicates.
    uniqueIndex("videos_facebook_video_id_key").on(table.facebookVideoId),

    index("videos_streamer_id_created_time_idx").on(table.streamerId, table.createdTime.desc()),
    index("videos_created_time_idx").on(table.createdTime.desc()),
    index("videos_last_synced_at_idx").on(table.lastSyncedAt.desc()),

    check(
      "videos_length_non_negative_check",
      sql`${table.lengthSeconds} is null or ${table.lengthSeconds} >= 0`,
    ),
  ],
);

/**
 * One metric returned by `/{video-id}/video_insights`.
 *
 * Schemaless in the metric dimension, exactly as `post_insights` is: nothing in
 * the codebase enumerates video metric names. `value_json` is `jsonb`, so a
 * value may be a number, a string, an array, an object, or arbitrarily nested
 * JSON — video insights routinely return breakdown objects and time series
 * where post insights return scalars.
 */
export const videoInsights = pgTable(
  "video_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    videoId: uuid("video_id")
      .notNull()
      .references(() => videos.id, { onDelete: "cascade" }),

    metricName: text("metric_name").notNull(),
    period: text("period"),

    /** Any JSON shape Meta returns. `null` means "reported, but no value". */
    valueJson: jsonb("value_json"),
    endTime: timestamp("end_time", { withTimezone: true }),

    rawJson: jsonb("raw_json").notNull(),

    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("video_insights_metric_key").on(
      table.videoId,
      table.metricName,
      sql`coalesce(${table.period}, '')`,
      sql`coalesce(${table.endTime}, 'epoch'::timestamptz)`,
    ),

    index("video_insights_video_id_idx").on(table.videoId),
    index("video_insights_metric_name_idx").on(table.metricName),
    index("video_insights_collected_at_idx").on(table.collectedAt.desc()),
  ],
);

export type VideoRow = typeof videos.$inferSelect;
export type NewVideoRow = typeof videos.$inferInsert;

export type VideoInsightRow = typeof videoInsights.$inferSelect;
export type NewVideoInsightRow = typeof videoInsights.$inferInsert;

// ---------------------------------------------------------------------------
// Comments and AI summaries (Phase 5)
// ---------------------------------------------------------------------------

/**
 * What a comment or summary is attached to.
 *
 * `video` exists from the start even though the videos table arrives in a later
 * phase — retrofitting a polymorphic key onto a populated table is far more
 * disruptive than carrying one nullable column.
 */
export const contentTypeEnum = pgEnum("content_type", ["post", "video"]);

/** Overall tone of a comment set, as judged by the AI. */
export const commentSentimentEnum = pgEnum("comment_sentiment", [
  "positive",
  "mixed",
  "negative",
  "neutral",
  "no_comments",
]);

/** Lifecycle of a summarisation attempt. */
export const summaryStatusEnum = pgEnum("summary_status", [
  "pending",
  "processing",
  "completed",
  "no_comments",
  "failed",
]);

/**
 * A comment on a Page post.
 *
 * **No commenter identity is stored.** The Graph request asks only for
 * `id,message,created_time,like_count,comment_count` — the `from` field is
 * never requested, so no name or profile id ever enters the system. There is
 * deliberately no author column for one to be written to, and no `raw_json`
 * column that could carry one in unparsed.
 */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    contentType: contentTypeEnum("content_type").notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").references(() => videos.id, { onDelete: "cascade" }),

    /** Meta's identifier. The dedupe key: a comment is stored at most once. */
    facebookCommentId: text("facebook_comment_id").notNull(),

    message: text("message"),
    createdTime: timestamp("created_time", { withTimezone: true }).notNull(),

    likeCount: integer("like_count"),
    /** Meta's `comment_count` on a comment — its number of replies. */
    replyCount: integer("reply_count"),

    /**
     * SHA-256 of this comment's identity and text. Changes when Meta reports an
     * edited message, which is what makes "have the comments changed?"
     * answerable without re-reading every row.
     */
    contentHash: text("content_hash").notNull(),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("comments_facebook_comment_id_key").on(table.facebookCommentId),

    index("comments_post_id_created_time_idx").on(table.postId, table.createdTime.desc()),
    index("comments_video_id_created_time_idx").on(table.videoId, table.createdTime.desc()),
    index("comments_content_type_idx").on(table.contentType),

    // Exactly one parent, and it must agree with content_type. Without this a
    // comment could be orphaned or claim to belong to two things at once.
    check(
      "comments_one_parent_check",
      sql`(${table.contentType} = 'post' and ${table.postId} is not null and ${table.videoId} is null)
        or (${table.contentType} = 'video' and ${table.videoId} is not null and ${table.postId} is null)`,
    ),
    check(
      "comments_counts_non_negative_check",
      sql`(${table.likeCount} is null or ${table.likeCount} >= 0)
        and (${table.replyCount} is null or ${table.replyCount} >= 0)`,
    ),
  ],
);

/**
 * The AI-generated analysis of one content item's comments.
 *
 * One row per post (or video): the current summary. `source_hash` records the
 * exact comment set it was derived from, which is what lets the service skip
 * the AI call when nothing has changed.
 */
export const commentSummaries = pgTable(
  "comment_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    contentType: contentTypeEnum("content_type").notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").references(() => videos.id, { onDelete: "cascade" }),

    /**
     * Deterministic SHA-256 over the comment ids and messages this summary was
     * built from. Equality means "the same comments" — the gate on re-billing.
     */
    sourceHash: text("source_hash").notNull(),
    commentCount: integer("comment_count").notNull().default(0),

    summary: text("summary"),
    sentiment: commentSentimentEnum("sentiment"),

    positivePointsJson: jsonb("positive_points_json"),
    concernsJson: jsonb("concerns_json"),
    suggestionsJson: jsonb("suggestions_json"),
    questionsJson: jsonb("questions_json"),
    urgentIssuesJson: jsonb("urgent_issues_json"),

    aiProvider: text("ai_provider"),
    model: text("model"),

    status: summaryStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),

    /** The unmodified provider response, for debugging a bad summary. */
    rawAiResponse: jsonb("raw_ai_response"),

    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One current summary per content item. Partial rather than composite
    // because exactly one of the two columns is non-null.
    uniqueIndex("comment_summaries_post_key")
      .on(table.postId)
      .where(sql`${table.postId} is not null`),
    uniqueIndex("comment_summaries_video_key")
      .on(table.videoId)
      .where(sql`${table.videoId} is not null`),

    index("comment_summaries_status_idx").on(table.status),
    index("comment_summaries_generated_at_idx").on(table.generatedAt.desc()),

    check(
      "comment_summaries_one_parent_check",
      sql`(${table.contentType} = 'post' and ${table.postId} is not null and ${table.videoId} is null)
        or (${table.contentType} = 'video' and ${table.videoId} is not null and ${table.postId} is null)`,
    ),
    check("comment_summaries_comment_count_check", sql`${table.commentCount} >= 0`),
    // A failed run must say why; a completed one must carry a summary.
    check(
      "comment_summaries_status_consistency_check",
      sql`(${table.status} <> 'failed' or ${table.errorMessage} is not null)
        and (${table.status} <> 'completed' or ${table.summary} is not null)`,
    ),
  ],
);

export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;

export type CommentSummaryRow = typeof commentSummaries.$inferSelect;
export type NewCommentSummaryRow = typeof commentSummaries.$inferInsert;
