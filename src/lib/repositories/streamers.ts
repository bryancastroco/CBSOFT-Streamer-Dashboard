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
  type SQL,
} from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { encryptToken, decryptToken, lastFourOf, maskFromLastFour } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";
import { auditLogs, streamers, syncRuns } from "@/lib/db/schema";
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
