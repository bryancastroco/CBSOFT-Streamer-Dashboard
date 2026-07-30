import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthUser, createTestDatabase } from "./helpers/test-database";

/**
 * Applies the real migration files to a real Postgres and asserts the resulting
 * structure. Covers what a schema file alone cannot: that the SQL runs, in
 * order, and that the constraints and triggers actually fire.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

describe("migrations apply cleanly", () => {
  it("creates every table the phases so far define", async () => {
    const found = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );

    expect(found.map((r) => r.table_name)).toEqual([
      "audit_logs",
      "comment_summaries",
      "comments",
      "export_runs",
      "post_insights",
      "posts",
      "streamers",
      "sync_runs",
      "users",
      "video_insights",
      "videos",
    ]);
  });

  it("wires the video foreign keys Phase 5 deferred", async () => {
    // `comments.video_id` and `comment_summaries.video_id` were nullable
    // columns with no FK until the videos table existed. Both are now
    // constrained, so a comment cannot reference a video that is not there.
    const found = await rows<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND contype = 'f'
         AND conname IN ('comments_video_id_videos_id_fk',
                         'comment_summaries_video_id_videos_id_fk',
                         'video_insights_video_id_videos_id_fk',
                         'videos_streamer_id_streamers_id_fk')`,
    );

    expect(found).toHaveLength(4);
    // 'c' = CASCADE: deleting a video removes its comments, summary and metrics.
    for (const fk of found) {
      expect(fk.confdeltype, `${fk.conname} should cascade`).toBe("c");
    }
  });

  it("stores no commenter identity column on comments", async () => {
    // The schema-level half of the guarantee: even if a future Graph request
    // asked for `from`, there is nowhere to put it.
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'comments'`,
    );

    const names = columns.map((r) => r.column_name);

    expect(names.sort()).toEqual(
      [
        "content_hash",
        "content_type",
        "created_at",
        "created_time",
        "facebook_comment_id",
        "id",
        "like_count",
        "message",
        "post_id",
        "reply_count",
        "updated_at",
        "video_id",
        "last_synced_at",
      ].sort(),
    );
  });

  it("creates every column the specification lists", async () => {
    const expected: Record<string, string[]> = {
      users: ["id", "email", "full_name", "role", "created_at", "updated_at"],
      streamers: [
        "id",
        "streamer_code",
        "streamer_name",
        "page_id",
        "page_name",
        "encrypted_page_token",
        "page_token_last_four",
        "token_status",
        "token_expires_at",
        "token_scopes",
        "active",
        "notes",
        "last_successful_sync_at",
        "last_sync_error",
        "token_last_validated_at",
        "token_validation_error",
        "created_at",
        "updated_at",
        "deleted_at",
      ],
      export_runs: [
        "id",
        "dataset",
        "format",
        "caller",
        "status",
        "row_count",
        "total_available",
        "filters_json",
        "error_message",
        "duration_ms",
        "created_at",
      ],
      sync_runs: [
        "id",
        "streamer_id",
        // Phase 8: links a per-streamer run to the automation sweep that
        // spawned it, so a workflow polling one id learns the state of all.
        "parent_sync_run_id",
        "sync_type",
        "status",
        "posts_processed",
        "videos_processed",
        "comments_processed",
        "summaries_generated",
        "started_at",
        "completed_at",
        "error_message",
        "error_details_json",
      ],
      audit_logs: [
        "id",
        "user_id",
        "action",
        "entity_type",
        "entity_id",
        "metadata_json",
        "created_at",
      ],
    };

    for (const [table, columns] of Object.entries(expected)) {
      const actual = await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );

      expect(actual.map((r) => r.column_name).sort()).toEqual([...columns].sort());
    }
  });

  it("defines the enums with the expected values", async () => {
    const enums = await rows<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       GROUP BY t.typname`,
    );

    const byName = Object.fromEntries(enums.map((e) => [e.typname, e.labels]));

    expect(byName["user_role"]).toEqual(["admin", "viewer"]);
    expect(byName["token_status"]).toEqual([
      "missing",
      "valid",
      "expiring",
      "expired",
      "invalid",
      "missing_permission",
      "unknown",
    ]);
    expect(byName["sync_type"]).toEqual([
      "full",
      "incremental",
      "manual",
      "backfill",
      "token_check",
      // Phase 8. Appended, never reordered — enum position is stored on disk,
      // and inserting a value in the middle would rewrite existing rows.
      "automation",
    ]);
    expect(byName["sync_status"]).toEqual(["pending", "running", "succeeded", "failed", "partial"]);
    // Phase 9. Two values only: an export either produced its rows or it did
    // not. A short page is the last page, not a partial failure.
    expect(byName["export_status"]).toEqual(["succeeded", "failed"]);
  });

  it("keeps export_runs readable but not writable by a client role", async () => {
    /*
     * The Settings page reads this, so `authenticated` needs SELECT. Nothing
     * else: rows are written by server code holding the service role, and the
     * absence of an INSERT policy is what refuses a browser session — rather
     * than a rule somebody has to remember.
     */
    const grants = await rows<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'export_runs'
         AND grantee = 'authenticated'`,
    );

    expect(grants.map((g) => g.privilege_type)).toEqual(["SELECT"]);

    const anon = await rows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = 'export_runs' AND grantee = 'anon'`,
    );

    expect(anon).toHaveLength(0);

    const policies = await rows<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'export_runs'`,
    );

    expect(policies.map((p) => p.cmd)).toEqual(["SELECT"]);
  });

  it("requires a message on a failed export run", async () => {
    // Same reasoning as `sync_runs`: a failure nobody can explain is not much
    // better than a failure nobody recorded.
    await expect(
      db.query(
        `INSERT INTO export_runs (dataset, status, row_count) VALUES ('posts', 'failed', 0)`,
      ),
    ).rejects.toThrow(/export_runs_failure_has_message_check/);
  });
});

describe("foreign keys", () => {
  it("links audit_logs.user_id to users with ON DELETE SET NULL", async () => {
    const [fk] = await rows<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'public.audit_logs'::regclass AND contype = 'f'`,
    );

    // 'n' = SET NULL. The trail must outlive the user it refers to.
    expect(fk?.confdeltype).toBe("n");
  });

  it("links sync_runs.streamer_id to streamers with ON DELETE SET NULL", async () => {
    // Named explicitly: sync_runs carries two foreign keys since Phase 8, and
    // an unfiltered query would silently assert about whichever came back
    // first.
    const [fk] = await rows<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.sync_runs'::regclass AND contype = 'f'
         AND conname = 'sync_runs_streamer_id_streamers_id_fk'`,
    );

    expect(fk?.confdeltype).toBe("n");
  });

  it("links a child sync run to its parent, surviving the parent's deletion", async () => {
    const [fk] = await rows<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.sync_runs'::regclass AND contype = 'f'
         AND conname = 'sync_runs_parent_sync_run_id_sync_runs_id_fk'`,
    );

    // 'n' = SET NULL, not CASCADE: removing a sweep must not delete the
    // per-streamer history it spawned.
    expect(fk?.confdeltype).toBe("n");
  });

  it("refuses a sync run that is its own parent", async () => {
    const [constraint] = await rows<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.sync_runs'::regclass AND contype = 'c'
         AND conname = 'sync_runs_parent_not_self_check'`,
    );

    expect(constraint?.conname).toBe("sync_runs_parent_not_self_check");
  });

  it("grants the new parent column to authenticated", async () => {
    /*
     * `sync_runs` is granted column by column, so a column added in a later
     * migration is NOT covered by the existing grant — it has to be granted
     * explicitly or it is invisible to every client role. This is the same
     * mechanism that keeps `streamers.encrypted_page_token` unreadable, and the
     * same footgun. See SECURITY.md.
     */
    const granted = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'sync_runs'
         AND grantee = 'authenticated' AND privilege_type = 'SELECT'
         AND column_name = 'parent_sync_run_id'`,
    );

    expect(granted).toHaveLength(1);
  });

  it("links users.id to auth.users with ON DELETE CASCADE", async () => {
    const [fk] = await rows<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'users_id_auth_users_id_fk'`,
    );

    // 'c' = CASCADE. Removing the auth account removes the profile.
    expect(fk?.confdeltype).toBe("c");
  });

  it("rejects a profile for a non-existent auth user", async () => {
    await expect(
      db.query(`INSERT INTO public.users (id, email) VALUES (gen_random_uuid(), 'ghost@x.test')`),
    ).rejects.toThrow();
  });
});

describe("indexes", () => {
  it("creates every index the schema declares", async () => {
    const found = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = found.map((r) => r.indexname);

    for (const expected of [
      "users_email_lower_key",
      "users_role_idx",
      "streamers_streamer_code_active_key",
      "streamers_page_id_active_key",
      "streamers_active_idx",
      "streamers_token_status_idx",
      "streamers_last_successful_sync_at_idx",
      "sync_runs_streamer_id_started_at_idx",
      "sync_runs_status_idx",
      "sync_runs_started_at_idx",
      "sync_runs_in_flight_idx",
      "audit_logs_created_at_idx",
      "audit_logs_user_id_created_at_idx",
      "audit_logs_action_idx",
      "audit_logs_entity_idx",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("treats email case-insensitively, matching Supabase Auth", async () => {
    await createAuthUser(db, "Case@x.test");

    await expect(
      db.query(`INSERT INTO public.users (id, email) VALUES (gen_random_uuid(), 'case@x.test')`),
    ).rejects.toThrow();
  });
});

describe("streamers constraints", () => {
  const base = `INSERT INTO public.streamers (streamer_code, streamer_name, page_id, page_name)`;

  it("accepts a well-formed row", async () => {
    await db.query(`${base} VALUES ('CBS-001', 'Ana', '1234567890', 'Ana Live')`);

    const [row] = await rows<{ token_status: string; active: boolean; token_scopes: string[] }>(
      `SELECT token_status, active, token_scopes FROM public.streamers WHERE streamer_code = 'CBS-001'`,
    );

    expect(row?.token_status).toBe("missing");
    expect(row?.active).toBe(true);
    expect(row?.token_scopes).toEqual([]);
  });

  it("enforces the streamer_code format", async () => {
    await expect(db.query(`${base} VALUES ('lowercase', 'X', '111', 'X')`)).rejects.toThrow();
  });

  it("requires a numeric page_id, because Meta Page IDs are numeric", async () => {
    await expect(db.query(`${base} VALUES ('CBS-002', 'X', 'not-a-page', 'X')`)).rejects.toThrow();
  });

  it("blocks a duplicate streamer_code among live rows", async () => {
    await expect(
      db.query(`${base} VALUES ('CBS-001', 'Copy', '9999999999', 'Copy')`),
    ).rejects.toThrow();
  });

  it("blocks a duplicate page_id among live rows", async () => {
    await expect(
      db.query(`${base} VALUES ('CBS-003', 'Other', '1234567890', 'Other')`),
    ).rejects.toThrow();
  });

  it("allows a code to be reused after a soft delete", async () => {
    await db.query(`${base} VALUES ('CBS-REUSE', 'First', '5550001111', 'First')`);
    await db.query(
      `UPDATE public.streamers SET deleted_at = now() WHERE streamer_code = 'CBS-REUSE'`,
    );

    await expect(
      db.query(`${base} VALUES ('CBS-REUSE', 'Second', '5550002222', 'Second')`),
    ).resolves.toBeDefined();
  });

  it("refuses a token without its recognition suffix", async () => {
    await expect(
      db.query(
        `INSERT INTO public.streamers
           (streamer_code, streamer_name, page_id, page_name, encrypted_page_token, token_status)
         VALUES ('CBS-004', 'X', '2220000001', 'X', 'v1.aa.bb.cc', 'valid')`,
      ),
    ).rejects.toThrow();
  });

  it("refuses a plaintext token — ciphertext must carry the version envelope", async () => {
    await expect(
      db.query(
        `INSERT INTO public.streamers
           (streamer_code, streamer_name, page_id, page_name,
            encrypted_page_token, page_token_last_four, token_status)
         VALUES ('CBS-005', 'X', '2220000002', 'X', 'EAABwzLixnjYBO', 'njYB', 'valid')`,
      ),
    ).rejects.toThrow();
  });

  it("accepts a properly enveloped ciphertext with its suffix and status", async () => {
    await expect(
      db.query(
        `INSERT INTO public.streamers
           (streamer_code, streamer_name, page_id, page_name,
            encrypted_page_token, page_token_last_four, token_status)
         VALUES ('CBS-006', 'X', '2220000003', 'X', 'v1.aa.bb.cc', '9f2Q', 'valid')`,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a status of `missing` alongside a stored token", async () => {
    await expect(
      db.query(
        `INSERT INTO public.streamers
           (streamer_code, streamer_name, page_id, page_name,
            encrypted_page_token, page_token_last_four, token_status)
         VALUES ('CBS-007', 'X', '2220000004', 'X', 'v1.aa.bb.cc', '9f2Q', 'missing')`,
      ),
    ).rejects.toThrow();
  });
});

describe("sync_runs constraints", () => {
  it("accepts an open run", async () => {
    await expect(
      db.query(`INSERT INTO public.sync_runs (sync_type) VALUES ('manual')`),
    ).resolves.toBeDefined();
  });

  it("refuses a terminal status with no completed_at", async () => {
    await expect(
      db.query(`INSERT INTO public.sync_runs (sync_type, status) VALUES ('full', 'succeeded')`),
    ).rejects.toThrow();
  });

  it("refuses an open status that already has completed_at", async () => {
    await expect(
      db.query(
        `INSERT INTO public.sync_runs (sync_type, status, completed_at)
         VALUES ('full', 'running', now())`,
      ),
    ).rejects.toThrow();
  });

  it("refuses a failed run with no error message", async () => {
    await expect(
      db.query(
        `INSERT INTO public.sync_runs (sync_type, status, completed_at)
         VALUES ('full', 'failed', now())`,
      ),
    ).rejects.toThrow();
  });

  it("accepts a failed run that explains itself", async () => {
    await expect(
      db.query(
        `INSERT INTO public.sync_runs (sync_type, status, completed_at, error_message)
         VALUES ('full', 'failed', now(), 'Graph API rate limit')`,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses negative counters", async () => {
    await expect(
      db.query(`INSERT INTO public.sync_runs (sync_type, posts_processed) VALUES ('full', -1)`),
    ).rejects.toThrow();
  });

  it("refuses a run that finished before it started", async () => {
    await expect(
      db.query(
        `INSERT INTO public.sync_runs (sync_type, status, started_at, completed_at, error_message)
         VALUES ('full', 'failed', now(), now() - interval '1 hour', 'clock skew')`,
      ),
    ).rejects.toThrow();
  });
});

describe("triggers", () => {
  it("provisions a viewer profile when an auth user is created", async () => {
    const id = await createAuthUser(db, "newcomer@x.test", "New Comer");

    const [profile] = await rows<{ role: string; email: string; full_name: string | null }>(
      `SELECT role, email, full_name FROM public.users WHERE id = $1`,
      [id],
    );

    // The important assertion: signing up never yields administrative access.
    expect(profile?.role).toBe("viewer");
    expect(profile?.email).toBe("newcomer@x.test");
    expect(profile?.full_name).toBe("New Comer");
  });

  it("maintains updated_at on users", async () => {
    const id = await createAuthUser(db, "touch@x.test");

    const [before] = await rows<{ updated_at: string }>(
      `SELECT updated_at FROM public.users WHERE id = $1`,
      [id],
    );

    await db.query(`UPDATE public.users SET role = 'admin' WHERE id = $1`, [id]);

    const [after] = await rows<{ updated_at: string }>(
      `SELECT updated_at FROM public.users WHERE id = $1`,
      [id],
    );

    expect(new Date(after!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("keeps audit_logs append-only, even for a superuser", async () => {
    await db.query(
      `INSERT INTO public.audit_logs (action, entity_type) VALUES ('user.role_changed', 'user')`,
    );

    await expect(
      db.query(`UPDATE public.audit_logs SET action = 'user.signed_in'`),
    ).rejects.toThrow(/append-only/);

    await expect(db.query(`DELETE FROM public.audit_logs`)).rejects.toThrow(/append-only/);
  });

  it("enforces the audit action naming shape", async () => {
    await expect(
      db.query(`INSERT INTO public.audit_logs (action, entity_type) VALUES ('BadAction', 'user')`),
    ).rejects.toThrow();
  });
});

describe("row level security", () => {
  it("enables RLS on every table", async () => {
    const found = await rows<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
    );

    for (const table of found) {
      expect(table.relrowsecurity, `${table.relname} must have RLS enabled`).toBe(true);
    }
  });

  it("creates the expected policies", async () => {
    const found = await rows<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`,
    );
    const names = found.map((r) => r.policyname);

    for (const expected of [
      "users_select_self",
      "users_select_admin",
      "users_update_admin",
      "streamers_select_authenticated",
      "streamers_insert_admin",
      "streamers_update_admin",
      "streamers_delete_admin",
      "sync_runs_select_authenticated",
      "audit_logs_select_admin",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("gives users no INSERT or DELETE policy, so profiles are not client-created", async () => {
    const found = await rows<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users'`,
    );
    const commands = found.map((r) => r.cmd);

    expect(commands).not.toContain("INSERT");
    expect(commands).not.toContain("DELETE");
  });

  it("gives sync_runs and audit_logs no write policy at all", async () => {
    for (const table of ["sync_runs", "audit_logs"]) {
      const found = await rows<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );

      expect(found.every((r) => r.cmd === "SELECT")).toBe(true);
    }
  });
});

describe("column privileges — architecture rules 4 and 5", () => {
  it("hides encrypted_page_token from anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [result] = await rows<{ can_read: boolean }>(
        `SELECT has_column_privilege($1, 'public.streamers', 'encrypted_page_token', 'SELECT') AS can_read`,
        [role],
      );

      expect(result?.can_read, `${role} must not be able to read the token column`).toBe(false);
    }
  });

  it("also blocks writing the token column from those roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [result] = await rows<{ can_write: boolean }>(
        `SELECT has_column_privilege($1, 'public.streamers', 'encrypted_page_token', 'UPDATE') AS can_write`,
        [role],
      );

      expect(result?.can_write).toBe(false);
    }
  });

  it("still exposes the non-sensitive columns to authenticated", async () => {
    for (const column of [
      "streamer_name",
      "page_id",
      "page_token_last_four",
      "token_status",
      // Added in Phase 3. Columns added after the Phase 2 grants start with no
      // privilege at all, so these must be granted explicitly or the admin UI
      // silently cannot read token health through PostgREST.
      "token_last_validated_at",
      "token_validation_error",
    ]) {
      const [result] = await rows<{ can_read: boolean }>(
        `SELECT has_column_privilege('authenticated', 'public.streamers', $1, 'SELECT') AS can_read`,
        [column],
      );

      expect(result?.can_read, `authenticated should still read ${column}`).toBe(true);
    }
  });

  it("keeps trigger functions off the PostgREST RPC surface", async () => {
    // Supabase's default privileges publish every public function at
    // /rest/v1/rpc/<name>. A trigger function must not be directly callable —
    // handle_new_auth_user inserts into public.users.
    for (const fn of [
      "public.handle_new_auth_user()",
      "public.set_updated_at()",
      "public.reject_audit_log_mutation()",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const [result] = await rows<{ can_execute: boolean }>(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS can_execute`,
          [role, fn],
        );

        expect(result?.can_execute, `${role} must not execute ${fn}`).toBe(false);
      }
    }
  });

  it("lets authenticated call is_admin() but not anon", async () => {
    // The RLS policies call is_admin(), and a policy is evaluated as the
    // querying role, so `authenticated` must keep EXECUTE.
    const [auth] = await rows<{ can_execute: boolean }>(
      `SELECT has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE') AS can_execute`,
    );
    expect(auth?.can_execute).toBe(true);

    const [anon] = await rows<{ can_execute: boolean }>(
      `SELECT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') AS can_execute`,
    );
    expect(anon?.can_execute).toBe(false);
  });

  it("pins search_path on the trigger functions", async () => {
    const found = await rows<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('set_updated_at', 'reject_audit_log_mutation', 'is_admin', 'handle_new_auth_user')`,
    );

    expect(found).toHaveLength(4);

    for (const fn of found) {
      expect(
        fn.proconfig?.some((c) => c.startsWith("search_path=")),
        `${fn.proname} must pin search_path`,
      ).toBe(true);
    }
  });

  it("gives anon no access to any application table", async () => {
    for (const table of ["users", "streamers", "sync_runs", "audit_logs"]) {
      const [result] = await rows<{ can_read: boolean }>(
        `SELECT has_table_privilege('anon', $1, 'SELECT') AS can_read`,
        [`public.${table}`],
      );

      expect(result?.can_read, `anon must not read ${table}`).toBe(false);
    }
  });
});
