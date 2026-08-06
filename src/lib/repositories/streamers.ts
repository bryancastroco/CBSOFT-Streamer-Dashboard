import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getServerEnv } from "@/config/env";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { encryptToken, decryptToken, lastFourOf, maskFromLastFour } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";
import { resultRows } from "@/lib/db/params";
import { auditLogs, streamers, syncRuns } from "@/lib/db/schema";
import { extendPageToken, type TokenExtension } from "@/lib/meta/token-extension";
import { validatePageToken } from "@/lib/meta/token-validation";
import type { TokenStatus, TokenValidation } from "@/lib/meta/token-status";
import type {
  CreateStreamerInput,
  ListStreamersQuery,
  UpdateStreamerInput,
} from "@/lib/validation/streamers";

/**
 * Streamer administration data access.
 *
 * Uses the service-role connection, so RLS does not apply. Every exported
 * function assumes the caller has ALREADY proven it is an admin via
 * `assertAdmin()`. Do not call these from anywhere that has not.
 *
 * ## The one rule this file exists to enforce
 *
 * `encrypted_page_token` is selected in exactly ONE place — `loadTokenFor()` —
 * and its return value never leaves the module. Every other query uses
 * `PUBLIC_COLUMNS`, an explicit allow-list. There is no `select *` anywhere,
 * so no future field can leak by being added to the table.
 *
 * `StreamerView`, the only shape returned to callers, has no field capable of
 * holding a token: just `pageTokenLastFour` and the `maskedToken` derived from
 * it.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Explicit allow-list. `encryptedPageToken` is deliberately absent. */
const PUBLIC_COLUMNS = {
  id: streamers.id,
  streamerCode: streamers.streamerCode,
  streamerName: streamers.streamerName,
  pageId: streamers.pageId,
  pageName: streamers.pageName,
  pageTokenLastFour: streamers.pageTokenLastFour,
  tokenStatus: streamers.tokenStatus,
  tokenExpiresAt: streamers.tokenExpiresAt,
  tokenScopes: streamers.tokenScopes,
  tokenLastValidatedAt: streamers.tokenLastValidatedAt,
  tokenValidationError: streamers.tokenValidationError,
  active: streamers.active,
  notes: streamers.notes,
  lastSuccessfulSyncAt: streamers.lastSuccessfulSyncAt,
  lastSyncError: streamers.lastSyncError,
  createdAt: streamers.createdAt,
  updatedAt: streamers.updatedAt,
  deletedAt: streamers.deletedAt,
} as const;

type StreamerRowPublic = {
  id: string;
  streamerCode: string;
  streamerName: string;
  pageId: string;
  pageName: string;
  pageTokenLastFour: string | null;
  tokenStatus: TokenStatus;
  tokenExpiresAt: Date | null;
  tokenScopes: string[];
  tokenLastValidatedAt: Date | null;
  tokenValidationError: string | null;
  active: boolean;
  notes: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** The only streamer shape permitted to leave the server. */
export type StreamerView = StreamerRowPublic & {
  /** `••••••••••••ABCD`, or bullets alone when no token is stored. */
  maskedToken: string;
  hasToken: boolean;
};

function toView(row: StreamerRowPublic): StreamerView {
  return {
    ...row,
    maskedToken: maskFromLastFour(row.pageTokenLastFour),
    hasToken: row.pageTokenLastFour !== null,
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type StreamerFailure =
  | "not_found"
  | "duplicate_code"
  | "duplicate_page"
  | "no_token"
  | "token_rejected"
  | "already_deleted";

export type StreamerOutcome<T> =
  { ok: true; data: T } | { ok: false; reason: StreamerFailure; message: string };

function fail(
  reason: StreamerFailure,
  message: string,
): { ok: false; reason: StreamerFailure; message: string } {
  return { ok: false, reason, message };
}

/** Postgres unique-violation SQLSTATE, however drizzle happens to wrap it. */
function uniqueViolationOn(error: unknown): "code" | "page" | null {
  const candidates = [error, (error as { cause?: unknown })?.cause];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as { code?: string; constraint_name?: string; message?: string };
    if (record.code !== "23505") continue;

    const detail = `${record.constraint_name ?? ""} ${record.message ?? ""}`;
    if (detail.includes("streamer_code")) return "code";
    if (detail.includes("page_id")) return "page";
    return "code";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listStreamers(query: ListStreamersQuery): Promise<StreamerView[]> {
  const db = getDb();
  const filters: SQL[] = [];

  if (!query.includeDeleted) filters.push(isNull(streamers.deletedAt));
  if (query.activeOnly) filters.push(eq(streamers.active, true));

  if (query.search) {
    const term = `%${query.search}%`;
    const match = or(
      ilike(streamers.streamerName, term),
      ilike(streamers.streamerCode, term),
      ilike(streamers.pageName, term),
      ilike(streamers.pageId, term),
    );
    if (match) filters.push(match);
  }

  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(streamers)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(streamers.streamerCode));

  return rows.map(toView);
}

/**
 * Identity only, for filter dropdowns and roster links.
 *
 * Unlike `listStreamers`, this one is safe for **any signed-in user**: the
 * select list is three identity columns and a flag, so there is no token field
 * for a viewer-facing screen to render by accident. Phase 2 grants viewers
 * `streamers.view` and explicitly withholds anything about tokens, and the shape
 * returned here is what makes that structural rather than a rule to remember.
 */
export type StreamerOption = {
  id: string;
  streamerCode: string;
  streamerName: string;
  active: boolean;
};

/**
 * Streamers an automation sweep should process.
 *
 * Three conditions, and each excludes a streamer for a different reason:
 * deleted rows are gone, inactive rows were switched off deliberately, and a
 * row without a stored token has nothing to authenticate with. Ordered by code
 * so a sweep processes the roster in a predictable, reproducible order — useful
 * when reading two nights' logs side by side.
 */
export async function listSyncableStreamers(): Promise<StreamerOption[]> {
  const db = getDb();

  return db
    .select({
      id: streamers.id,
      streamerCode: streamers.streamerCode,
      streamerName: streamers.streamerName,
      active: streamers.active,
    })
    .from(streamers)
    .where(
      and(
        isNull(streamers.deletedAt),
        eq(streamers.active, true),
        isNotNull(streamers.pageTokenLastFour),
      ),
    )
    .orderBy(asc(streamers.streamerCode));
}

/**
 * The streamers a given sweep has not reached yet.
 *
 * ## Why a sweep needs this
 *
 * On Vercel a function is killed at `maxDuration`, and work handed to `after()`
 * is bounded by the same ceiling. A roster large enough to outlast one window
 * would previously be truncated silently — the parent run closed as complete
 * while streamers at the end of the list were never touched.
 *
 * So a sweep processes a bounded slice per invocation and is resumed by its
 * caller. "Already done" is derived from the child runs themselves rather than
 * from a cursor column: every streamer sweep opens a `sync_runs` row carrying
 * `parentSyncRunId`, so a streamer with such a row has been attempted under this
 * parent and must not be attempted twice.
 *
 * Deriving it this way means there is no separate progress field that can
 * disagree with reality, and a crash mid-slice loses at most the streamer in
 * flight — its child run exists, so the resume skips it rather than repeating
 * expensive Graph work.
 */
export async function listPendingStreamersForRun(
  parentSyncRunId: string,
): Promise<StreamerOption[]> {
  const db = getDb();

  const attempted = db
    .select({ streamerId: syncRuns.streamerId })
    .from(syncRuns)
    .where(eq(syncRuns.parentSyncRunId, parentSyncRunId));

  return db
    .select({
      id: streamers.id,
      streamerCode: streamers.streamerCode,
      streamerName: streamers.streamerName,
      active: streamers.active,
    })
    .from(streamers)
    .where(
      and(
        isNull(streamers.deletedAt),
        eq(streamers.active, true),
        isNotNull(streamers.pageTokenLastFour),
        notInArray(streamers.id, attempted),
      ),
    )
    .orderBy(asc(streamers.streamerCode));
}

export async function listStreamerOptions(): Promise<StreamerOption[]> {
  const db = getDb();

  return db
    .select({
      id: streamers.id,
      streamerCode: streamers.streamerCode,
      streamerName: streamers.streamerName,
      active: streamers.active,
    })
    .from(streamers)
    .where(isNull(streamers.deletedAt))
    .orderBy(asc(streamers.streamerCode));
}

/**
 * One streamer's identity, for a viewer-facing detail page.
 *
 * Same reasoning as `listStreamerOptions`: a viewer may see who the streamer is
 * and which Page they broadcast on — both public facts — and nothing about the
 * credential. Admin screens use `getStreamerById`, which additionally carries
 * token health and the masked suffix.
 */
export type StreamerIdentity = StreamerOption & {
  pageId: string;
  pageName: string;
  notes: string | null;
  lastSuccessfulSyncAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export async function getStreamerIdentity(id: string): Promise<StreamerIdentity | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: streamers.id,
      streamerCode: streamers.streamerCode,
      streamerName: streamers.streamerName,
      active: streamers.active,
      pageId: streamers.pageId,
      pageName: streamers.pageName,
      notes: streamers.notes,
      lastSuccessfulSyncAt: streamers.lastSuccessfulSyncAt,
      createdAt: streamers.createdAt,
      deletedAt: streamers.deletedAt,
    })
    .from(streamers)
    .where(eq(streamers.id, id))
    .limit(1);

  return row ?? null;
}

export async function getStreamerById(id: string): Promise<StreamerView | null> {
  const db = getDb();

  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(streamers)
    .where(eq(streamers.id, id))
    .limit(1);

  return row ? toView(row) : null;
}

/**
 * Decrypt the stored token for a single outbound Graph call.
 *
 * The ONLY function in the codebase that reads `encrypted_page_token`. Its
 * result is consumed immediately by the caller within this module and is never
 * returned outside it.
 */
async function loadTokenFor(id: string): Promise<string | null> {
  const db = getDb();

  const [row] = await db
    .select({ encrypted: streamers.encryptedPageToken })
    .from(streamers)
    .where(eq(streamers.id, id))
    .limit(1);

  if (!row?.encrypted) return null;
  return decryptToken(row.encrypted);
}

/**
 * Lend a streamer's plaintext token to a callback.
 *
 * The token is never returned, so it cannot be stored in a variable by the
 * caller, put in a response, or accidentally logged — it exists only for the
 * duration of `fn`. This is how the sync engine reaches Meta while decryption
 * stays confined to this module (asserted by `tests/token-containment.test.ts`).
 */
export async function withStreamerToken<T>(
  streamerId: string,
  fn: (token: string) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "no_token" }> {
  const token = await loadTokenFor(streamerId);
  if (!token) return { ok: false, reason: "no_token" };

  return { ok: true, value: await fn(token) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createStreamer(params: {
  actorId: string;
  input: CreateStreamerInput;
}): Promise<StreamerOutcome<{ streamer: StreamerView; validation: TokenValidation | null }>> {
  const db = getDb();
  const { input, actorId } = params;

  const rawToken = input.pageAccessToken?.trim() ?? "";
  let validation: TokenValidation | null = null;
  let encrypted: string | null = null;
  let lastFour: string | null = null;
  let status: TokenStatus = "missing";

  if (rawToken.length > 0) {
    validation = await validatePageToken({ token: rawToken, expectedPageId: input.pageId });

    // `invalid` covers the case that matters most: the token belongs to a
    // different Page. Storing it would silently attach the wrong credential,
    // so it is refused outright. Every other status is recorded, because an
    // expired or under-scoped token is still the right token — it just needs
    // attention, and the admin needs to see it in the list to act on it.
    if (validation.status === "invalid") {
      return fail("token_rejected", validation.message);
    }

    encrypted = encryptToken(rawToken);
    lastFour = lastFourOf(rawToken);
    status = validation.status;
  }

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(streamers)
        .values({
          streamerCode: input.streamerCode,
          streamerName: input.streamerName,
          pageId: input.pageId,
          pageName: input.pageName,
          encryptedPageToken: encrypted,
          pageTokenLastFour: lastFour,
          tokenStatus: status,
          tokenExpiresAt: validation?.expiresAt ?? null,
          tokenScopes: validation?.scopes ?? [],
          tokenLastValidatedAt: validation ? new Date() : null,
          tokenValidationError:
            validation && validation.status !== "valid" ? validation.message : null,
          notes: input.notes && input.notes.length > 0 ? input.notes : null,
          active: input.active,
        })
        .returning(PUBLIC_COLUMNS);

      if (!created) throw new Error("Insert returned no row");

      await tx.insert(auditLogs).values({
        userId: actorId,
        action: AUDIT_ACTIONS.streamerCreated,
        entityType: AUDIT_ENTITY_TYPES.streamer,
        entityId: created.id,
        metadataJson: {
          streamerCode: created.streamerCode,
          streamerName: created.streamerName,
          pageId: created.pageId,
          active: created.active,
          withToken: encrypted !== null,
        },
      });

      if (encrypted !== null) {
        await tx.insert(auditLogs).values({
          userId: actorId,
          action: AUDIT_ACTIONS.tokenAdded,
          entityType: AUDIT_ENTITY_TYPES.streamer,
          entityId: created.id,
          // Four characters and a status. No token, no ciphertext.
          metadataJson: {
            pageId: created.pageId,
            lastFour,
            tokenStatus: status,
          },
        });
      }

      return { ok: true as const, data: { streamer: toView(created), validation } };
    });
  } catch (error) {
    const conflict = uniqueViolationOn(error);
    if (conflict === "code") {
      return fail("duplicate_code", `Streamer code ${input.streamerCode} is already in use.`);
    }
    if (conflict === "page") {
      return fail(
        "duplicate_page",
        `Facebook Page ${input.pageId} is already assigned to another streamer.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateStreamer(params: {
  actorId: string;
  id: string;
  input: UpdateStreamerInput;
}): Promise<StreamerOutcome<StreamerView>> {
  const db = getDb();
  const { actorId, id, input } = params;

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select(PUBLIC_COLUMNS)
        .from(streamers)
        .where(eq(streamers.id, id))
        .for("update");

      if (!existing) return fail("not_found", "That streamer no longer exists.");
      if (existing.deletedAt) return fail("already_deleted", "That streamer has been deleted.");

      const patch: Record<string, unknown> = {};
      const changed: Record<string, { from: unknown; to: unknown }> = {};

      const assign = <K extends keyof UpdateStreamerInput>(key: K, column: string) => {
        const next = input[key];
        if (next === undefined) return;
        const current = (existing as Record<string, unknown>)[key as string];
        const normalised = next === "" ? null : next;
        if (current === normalised) return;
        patch[column] = normalised;
        changed[key as string] = { from: current, to: normalised };
      };

      assign("streamerName", "streamerName");
      assign("streamerCode", "streamerCode");
      assign("pageId", "pageId");
      assign("pageName", "pageName");
      assign("notes", "notes");
      assign("active", "active");

      if (Object.keys(patch).length === 0) {
        return { ok: true as const, data: toView(existing) };
      }

      const [updated] = await tx
        .update(streamers)
        .set(patch)
        .where(eq(streamers.id, id))
        .returning(PUBLIC_COLUMNS);

      if (!updated) return fail("not_found", "That streamer no longer exists.");

      // `active` toggling gets its own action so "who disabled this streamer,
      // and when" is answerable without reading field diffs.
      const activeChanged = changed["active"];
      const action = activeChanged
        ? activeChanged.to === false
          ? AUDIT_ACTIONS.streamerDisabled
          : AUDIT_ACTIONS.streamerEnabled
        : AUDIT_ACTIONS.streamerUpdated;

      await tx.insert(auditLogs).values({
        userId: actorId,
        action,
        entityType: AUDIT_ENTITY_TYPES.streamer,
        entityId: id,
        metadataJson: {
          streamerCode: updated.streamerCode,
          changed: Object.keys(changed),
          ...(activeChanged ? { active: updated.active } : {}),
        },
      });

      return { ok: true as const, data: toView(updated) };
    });
  } catch (error) {
    const conflict = uniqueViolationOn(error);
    if (conflict === "code") return fail("duplicate_code", "That streamer code is already in use.");
    if (conflict === "page")
      return fail("duplicate_page", "That Facebook Page is already assigned.");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

/**
 * Soft-delete a streamer.
 *
 * The row is retained so `sync_runs` history stays meaningful, and the partial
 * unique indexes free the code and Page ID for reuse. The token is destroyed
 * outright rather than kept alongside a deleted record — there is no reason to
 * retain a live credential for something no longer in the roster.
 */
export async function softDeleteStreamer(params: {
  actorId: string;
  id: string;
}): Promise<StreamerOutcome<{ id: string; streamerCode: string }>> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select(PUBLIC_COLUMNS)
      .from(streamers)
      .where(eq(streamers.id, params.id))
      .for("update");

    if (!existing) return fail("not_found", "That streamer no longer exists.");
    if (existing.deletedAt) return fail("already_deleted", "That streamer is already deleted.");

    await tx
      .update(streamers)
      .set({
        deletedAt: new Date(),
        active: false,
        // Clearing all three together satisfies streamers_token_consistency_check.
        encryptedPageToken: null,
        pageTokenLastFour: null,
        tokenStatus: "missing",
        tokenExpiresAt: null,
        tokenScopes: [],
        tokenValidationError: null,
      })
      .where(eq(streamers.id, params.id));

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.streamerDeleted,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.id,
      metadataJson: {
        streamerCode: existing.streamerCode,
        pageId: existing.pageId,
        tokenDestroyed: existing.pageTokenLastFour !== null,
      },
    });

    return { ok: true as const, data: { id: params.id, streamerCode: existing.streamerCode } };
  });
}

// ---------------------------------------------------------------------------
// Permanent deletion
// ---------------------------------------------------------------------------

export type StreamerFootprint = {
  posts: number;
  videos: number;
  comments: number;
  summaries: number;
  postInsights: number;
  videoInsights: number;
  canonicalMetrics: number;
  syncRuns: number;
};

/**
 * Everything a permanent delete would destroy, counted.
 *
 * Shown next to the confirmation field. "Delete this streamer" and "delete
 * eighteen months of collected engagement data that cannot be re-fetched from
 * Meta beyond its retention window" are the same click, and only one of those
 * is what the wording suggests. The counts are what make the second reading
 * visible before the decision rather than after it.
 */
export async function countStreamerFootprint(id: string): Promise<StreamerFootprint> {
  const db = getDb();

  const rows = await db.execute<Record<keyof StreamerFootprint, number>>(sql`
    select
      (select count(*) from posts where streamer_id = ${id})::int as posts,
      (select count(*) from videos where streamer_id = ${id})::int as videos,
      (select count(*) from comments c
        where exists (select 1 from posts p where p.id = c.post_id and p.streamer_id = ${id})
           or exists (select 1 from videos v where v.id = c.video_id and v.streamer_id = ${id})
      )::int as comments,
      (select count(*) from comment_summaries s
        where exists (select 1 from posts p where p.id = s.post_id and p.streamer_id = ${id})
           or exists (select 1 from videos v where v.id = s.video_id and v.streamer_id = ${id})
      )::int as summaries,
      (select count(*) from post_insights i
        where exists (select 1 from posts p where p.id = i.post_id and p.streamer_id = ${id})
      )::int as post_insights,
      (select count(*) from video_insights i
        where exists (select 1 from videos v where v.id = i.video_id and v.streamer_id = ${id})
      )::int as video_insights,
      (select count(*) from content_metrics_current where streamer_id = ${id})::int
        as canonical_metrics,
      (select count(*) from sync_runs where streamer_id = ${id})::int as sync_runs
  `);

  const row = resultRows<Record<string, number>>(rows)[0];

  return {
    posts: row?.["posts"] ?? 0,
    videos: row?.["videos"] ?? 0,
    comments: row?.["comments"] ?? 0,
    summaries: row?.["summaries"] ?? 0,
    postInsights: row?.["post_insights"] ?? 0,
    videoInsights: row?.["video_insights"] ?? 0,
    canonicalMetrics: row?.["canonical_metrics"] ?? 0,
    syncRuns: row?.["sync_runs"] ?? 0,
  };
}

export type StreamerRemovalView = {
  id: string;
  streamerCode: string;
  active: boolean;
  deletedAt: Date | null;
  postCount: number;
  videoCount: number;
  footprint: StreamerFootprint;
};

/**
 * Everything the removal card needs, in one call.
 *
 * Exists so the two screens offering removal fetch identically. The card itself
 * is a presentational component taking props — data access lives in `page.tsx`
 * by project convention, and a shared component importing repositories would
 * sit outside the server-only allow-list for good reason. Putting the *query*
 * in one place gets the same anti-drift property without weakening that rule:
 * each page calls this and passes the result through, and TypeScript refuses a
 * caller that supplies less.
 *
 * Returns null rather than throwing, so a caller that has already resolved the
 * streamer can decide what a missing row means for its own layout.
 */
export async function getStreamerRemovalView(id: string): Promise<StreamerRemovalView | null> {
  const [streamer, footprint] = await Promise.all([
    getStreamerById(id),
    countStreamerFootprint(id),
  ]);

  if (!streamer) return null;

  return {
    id: streamer.id,
    streamerCode: streamer.streamerCode,
    active: streamer.active,
    deletedAt: streamer.deletedAt,
    postCount: footprint.posts,
    videoCount: footprint.videos,
    footprint,
  };
}

/**
 * Delete a streamer and everything collected for it. Irreversible.
 *
 * ## How this differs from `softDeleteStreamer`
 *
 * The soft delete retires a streamer: the row stays, its posts, videos,
 * comments and analyses stay, and the sync history stays meaningful. It is the
 * right choice almost always, and it is what "remove" means for a person who
 * has left the roster but whose past performance still belongs in a report.
 *
 * This is for the other case — a Page added by mistake, a test entry, a
 * withdrawal request. It takes the content with it, and none of it can be
 * recovered: Meta will not re-serve insights beyond its own retention window,
 * so a post collected last year is gone for good.
 *
 * ## What survives, and why
 *
 * The audit entry. `audit_logs.entity_id` is a plain column with no foreign key
 * precisely so the trail outlives the record it describes — "who removed
 * CBS-014, when, and how much went with it" has to remain answerable after the
 * row is gone. It is written inside the same transaction, before the delete, so
 * a failed delete cannot leave a log claiming otherwise.
 *
 * ## What is deleted explicitly
 *
 * Posts, videos and canonical metrics cascade from the streamer row; comments,
 * summaries and insights cascade from those. `sync_runs.streamer_id` is
 * `on delete set null`, which would leave this streamer's child runs orphaned
 * and shaped exactly like top-level automation runs — so they are removed
 * outright rather than left to be misread as sweeps that never ended.
 */
export async function purgeStreamer(params: {
  actorId: string;
  id: string;
}): Promise<
  StreamerOutcome<{ id: string; streamerCode: string; destroyed: StreamerFootprint }>
> {
  const db = getDb();

  // Counted outside the transaction: it is eight aggregate reads over the
  // largest tables in the schema, and holding a row lock across them buys
  // nothing. A concurrent sync could add a post between here and the delete;
  // that post is deleted too, and the recorded count is off by one — which is a
  // better trade than serialising the sweep behind an administrative action.
  const destroyed = await countStreamerFootprint(params.id);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select(PUBLIC_COLUMNS)
      .from(streamers)
      .where(eq(streamers.id, params.id))
      .for("update");

    if (!existing) return fail("not_found", "That streamer no longer exists.");

    // Before the delete, and in the same transaction. An audit row written
    // afterwards can describe a deletion that was rolled back.
    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.streamerPurged,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.id,
      metadataJson: {
        streamerCode: existing.streamerCode,
        streamerName: existing.streamerName,
        pageId: existing.pageId,
        pageName: existing.pageName,
        wasSoftDeleted: existing.deletedAt !== null,
        destroyed,
      },
    });

    await tx.delete(syncRuns).where(eq(syncRuns.streamerId, params.id));
    await tx.delete(streamers).where(eq(streamers.id, params.id));

    return {
      ok: true as const,
      data: { id: params.id, streamerCode: existing.streamerCode, destroyed },
    };
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function replaceStreamerToken(params: {
  actorId: string;
  id: string;
  token: string;
}): Promise<StreamerOutcome<{ streamer: StreamerView; validation: TokenValidation }>> {
  const db = getDb();

  const existing = await getStreamerById(params.id);
  if (!existing) return fail("not_found", "That streamer no longer exists.");
  if (existing.deletedAt) return fail("already_deleted", "That streamer has been deleted.");

  const validation = await validatePageToken({
    token: params.token,
    expectedPageId: existing.pageId,
  });

  if (validation.status === "invalid") {
    return fail("token_rejected", validation.message);
  }

  const hadToken = existing.hasToken;
  const encrypted = encryptToken(params.token);
  const lastFour = lastFourOf(params.token);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(streamers)
      .set({
        encryptedPageToken: encrypted,
        pageTokenLastFour: lastFour,
        tokenStatus: validation.status,
        tokenExpiresAt: validation.expiresAt,
        tokenScopes: validation.scopes,
        tokenLastValidatedAt: new Date(),
        tokenValidationError: validation.status === "valid" ? null : validation.message,
      })
      .where(eq(streamers.id, params.id))
      .returning(PUBLIC_COLUMNS);

    if (!updated) return fail("not_found", "That streamer no longer exists.");

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: hadToken ? AUDIT_ACTIONS.tokenReplaced : AUDIT_ACTIONS.tokenAdded,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.id,
      metadataJson: {
        streamerCode: updated.streamerCode,
        pageId: updated.pageId,
        // Both suffixes, so a rotation is traceable without either token.
        previousLastFour: existing.pageTokenLastFour,
        lastFour,
        tokenStatus: validation.status,
      },
    });

    return { ok: true as const, data: { streamer: toView(updated), validation } };
  });
}

/**
 * Re-check the stored token against Meta and record the verdict.
 *
 * Decrypts, calls the Graph API, writes the resulting health back, and audits
 * the check. The plaintext exists only for the duration of the Graph call.
 */
export async function validateStreamerToken(params: {
  /** Null for a machine actor — an automation sweep has no user behind it. */
  actorId: string | null;
  id: string;
}): Promise<StreamerOutcome<{ streamer: StreamerView; validation: TokenValidation }>> {
  const db = getDb();

  const existing = await getStreamerById(params.id);
  if (!existing) return fail("not_found", "That streamer no longer exists.");
  if (existing.deletedAt) return fail("already_deleted", "That streamer has been deleted.");
  if (!existing.hasToken) {
    return fail("no_token", "This streamer has no Page token to validate. Add one first.");
  }

  const token = await loadTokenFor(params.id);
  if (!token) {
    return fail("no_token", "This streamer has no Page token to validate. Add one first.");
  }

  const validation = await validatePageToken({ token, expectedPageId: existing.pageId });

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(streamers)
      .set({
        tokenStatus: validation.status,
        tokenExpiresAt: validation.expiresAt,
        tokenScopes: validation.scopes,
        tokenLastValidatedAt: new Date(),
        tokenValidationError: validation.status === "valid" ? null : validation.message,
      })
      .where(eq(streamers.id, params.id))
      .returning(PUBLIC_COLUMNS);

    if (!updated) return fail("not_found", "That streamer no longer exists.");

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.tokenValidated,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.id,
      metadataJson: {
        streamerCode: updated.streamerCode,
        pageId: updated.pageId,
        lastFour: updated.pageTokenLastFour,
        previousStatus: existing.tokenStatus,
        tokenStatus: validation.status,
        missingRequiredScopes: validation.missingRequiredScopes,
      },
    });

    return { ok: true as const, data: { streamer: toView(updated), validation } };
  });
}

/**
 * Swap a stored Page token for a longer-lived one, in place.
 *
 * The only self-service remedy for token expiry that exists. Meta will hand
 * back a non-expiring Page token when asked for the Page's own `access_token`
 * field — but only while the current token still works, so this is worth
 * running well before the deadline rather than at it.
 *
 * Idempotent by construction: a token that already has no expiry returns
 * `unchanged` and nothing is written. That matters because this runs on every
 * automation sweep, and rotating a credential nightly for no reason would bury
 * the real rotations in audit noise.
 *
 * Note what is NOT recorded. The audit row carries both last-four suffixes so a
 * rotation is traceable, and neither token. Nothing here returns plaintext to a
 * caller either — the replacement goes straight into `encryptToken`.
 */
export async function extendStreamerToken(params: {
  /** Null for a machine actor — an automation sweep has no user behind it. */
  actorId: string | null;
  id: string;
}): Promise<
  StreamerOutcome<{
    streamer: StreamerView;
    outcome: TokenExtension;
  }>
> {
  const db = getDb();

  const existing = await getStreamerById(params.id);
  if (!existing) return fail("not_found", "That streamer no longer exists.");
  if (existing.deletedAt) return fail("already_deleted", "That streamer has been deleted.");
  if (!existing.hasToken) {
    return fail("no_token", "This streamer has no Page token to extend. Add one first.");
  }

  const token = await loadTokenFor(params.id);
  if (!token) return fail("no_token", "This streamer has no Page token to extend. Add one first.");

  const env = getServerEnv();

  const outcome = await extendPageToken({
    token,
    pageId: existing.pageId,
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
  });

  /*
   * No token to rotate — but the record may still be wrong.
   *
   * `token_expires_at` is a cache written at the last validation, and it drifts:
   * this roster had a Page whose column read "28 September" while Meta already
   * treated the token as permanent. The UI kept counting down to a deadline
   * that did not exist, and the sweep would have acted on it. Correcting the
   * column is not a credential change, so it needs no audit entry — the token
   * itself is untouched.
   */
  if (outcome.status !== "extended") {
    const observed = outcome.status === "unchanged" ? outcome.expiresAt : undefined;

    if (observed !== undefined && observed?.getTime() !== existing.tokenExpiresAt?.getTime()) {
      const [corrected] = await db
        .update(streamers)
        .set({ tokenExpiresAt: observed, tokenLastValidatedAt: new Date() })
        .where(eq(streamers.id, params.id))
        .returning(PUBLIC_COLUMNS);

      if (corrected) {
        return { ok: true as const, data: { streamer: toView(corrected), outcome } };
      }
    }

    return { ok: true as const, data: { streamer: existing, outcome } };
  }

  const encrypted = encryptToken(outcome.token);
  const lastFour = lastFourOf(outcome.token);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(streamers)
      .set({
        encryptedPageToken: encrypted,
        pageTokenLastFour: lastFour,
        tokenStatus: "valid",
        tokenExpiresAt: outcome.expiresAt,
        tokenLastValidatedAt: new Date(),
        tokenValidationError: null,
      })
      .where(eq(streamers.id, params.id))
      .returning(PUBLIC_COLUMNS);

    if (!updated) return fail("not_found", "That streamer no longer exists.");

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.tokenExtended,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: params.id,
      metadataJson: {
        streamerCode: updated.streamerCode,
        pageId: updated.pageId,
        previousLastFour: existing.pageTokenLastFour,
        lastFour,
        previousExpiresAt: existing.tokenExpiresAt?.toISOString() ?? null,
        // Null is the outcome worth having, and it should read as such.
        newExpiresAt: outcome.expiresAt?.toISOString() ?? "never",
      },
    });

    return { ok: true as const, data: { streamer: toView(updated), outcome } };
  });
}

// ---------------------------------------------------------------------------
// Manual sync
// ---------------------------------------------------------------------------

/**
 * Queue a manual sync.
 *
 * Phase 3 records the request as a `pending` row in `sync_runs`; the engine
 * that picks it up is built in Phase 5. Writing the row now means the audit
 * trail and the admin UI are complete, and nothing has to be retrofitted.
 */
export async function requestManualSync(params: {
  actorId: string;
  id: string;
}): Promise<StreamerOutcome<{ syncRunId: string }>> {
  const db = getDb();

  const existing = await getStreamerById(params.id);
  if (!existing) return fail("not_found", "That streamer no longer exists.");
  if (existing.deletedAt) return fail("already_deleted", "That streamer has been deleted.");
  if (!existing.hasToken) {
    return fail("no_token", "This streamer has no Page token, so there is nothing to sync yet.");
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(syncRuns)
      .values({
        streamerId: params.id,
        syncType: "manual",
        status: "queued",
      })
      .returning({ id: syncRuns.id });

    if (!run) throw new Error("Insert returned no sync run");

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.streamerSyncRequested,
      entityType: AUDIT_ENTITY_TYPES.syncRun,
      entityId: run.id,
      metadataJson: {
        streamerId: params.id,
        streamerCode: existing.streamerCode,
        syncType: "manual",
      },
    });

    return { ok: true as const, data: { syncRunId: run.id } };
  });
}

/**
 * Recent sync runs for one streamer, newest first.
 *
 * The per-run counters are included because the Sync History tab is where an
 * operator answers "did last night's run actually collect anything?" — a
 * `succeeded` status that processed nothing is a different situation from one
 * that processed four hundred posts, and status alone cannot tell them apart.
 */
export async function listSyncRunsForStreamer(id: string, limit = 10) {
  const db = getDb();

  return db
    .select({
      id: syncRuns.id,
      syncType: syncRuns.syncType,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      completedAt: syncRuns.completedAt,
      errorMessage: syncRuns.errorMessage,
      postsProcessed: syncRuns.postsProcessed,
      videosProcessed: syncRuns.videosProcessed,
      commentsProcessed: syncRuns.commentsProcessed,
      summariesGenerated: syncRuns.summariesGenerated,
    })
    .from(syncRuns)
    .where(eq(syncRuns.streamerId, id))
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);
}

export type SyncRunRow = Awaited<ReturnType<typeof listSyncRunsForStreamer>>[number];

/**
 * Store a Page token obtained by the streamer themselves.
 *
 * Lives here rather than in the connect service for one reason:
 * `encrypted_page_token` is confined to this file, and
 * `tests/token-containment.test.ts` fails the build if it is written anywhere
 * else. That confinement is worth more than the convenience of putting this
 * beside the OAuth code — a Page token has exactly one place it can be stored,
 * and reviewing that place is reviewing all of them.
 *
 * Creates the streamer when the invitation was not tied to one, updates it when
 * it was. Validation happens in the caller, which already holds the plaintext
 * from Meta; the verdict arrives here as a decided fact.
 *
 * The audit entry carries a null user. The streamer is not a dashboard account,
 * and attributing this to whichever admin sent the link would record something
 * that did not happen.
 */
export async function attachConnectedPageToken(params: {
  streamerId: string | null;
  fallbackName: string;
  pageId: string;
  pageName: string;
  token: string;
  validation: TokenValidation;
}): Promise<string> {
  const db = getDb();

  const encrypted = encryptToken(params.token);
  const lastFour = lastFourOf(params.token);

  const tokenFields = {
    encryptedPageToken: encrypted,
    pageTokenLastFour: lastFour,
    tokenStatus: params.validation.status,
    tokenExpiresAt: params.validation.expiresAt,
    tokenScopes: params.validation.scopes,
    tokenLastValidatedAt: new Date(),
    tokenValidationError: params.validation.status === "valid" ? null : params.validation.message,
  };

  return db.transaction(async (tx) => {
    let id = params.streamerId;

    if (id) {
      await tx
        .update(streamers)
        .set({ ...tokenFields, pageName: params.pageName })
        .where(eq(streamers.id, id));
    } else {
      /*
       * `streamerCode` comes from the Page id, not the name.
       *
       * It has to be unique and stable, and two streamers may both be called
       * "Blade". An admin renames it afterwards if they care — the code is a
       * handle, not a display name, and a collision here would fail the insert
       * on somebody else's behalf.
       */
      const [created] = await tx
        .insert(streamers)
        .values({
          streamerCode: `FB${params.pageId.slice(-8)}`,
          streamerName: params.fallbackName,
          pageId: params.pageId,
          pageName: params.pageName,
          ...tokenFields,
        })
        .returning({ id: streamers.id });

      id = created!.id;
    }

    await tx.insert(auditLogs).values({
      userId: null,
      action: AUDIT_ACTIONS.tokenAdded,
      entityType: AUDIT_ENTITY_TYPES.streamer,
      entityId: id,
      metadataJson: {
        via: "self_service_connection",
        pageId: params.pageId,
        lastFour,
        tokenStatus: params.validation.status,
      },
    });

    return id;
  });
}
