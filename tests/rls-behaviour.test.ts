import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  actAs,
  createAuthUser,
  createTestDatabase,
  resetRole,
  setRole,
} from "./helpers/test-database";

/**
 * Row-level security, exercised rather than inspected.
 *
 * `migrations.test.ts` already asserts that RLS is enabled, that the policies
 * exist, and that `encrypted_page_token` carries no grant for `anon` or
 * `authenticated`. Those are statements about the schema. This file asks the
 * different question: **acting as** an anonymous visitor, a viewer and an
 * admin, what actually happens?
 *
 * The distinction matters. A policy can exist and still not bite — a stray
 * table-level GRANT, a policy attached to the wrong command, a `USING` clause
 * that is accidentally `true`. None of those are visible in a catalogue query,
 * and all of them are visible here.
 *
 * The helper wires `auth.uid()` to a GUC so a session can become a specific
 * user, which is how Supabase derives it from the request JWT in production.
 */

let db: PGlite;
let adminId: string;
let viewerId: string;
let streamerId: string;

const CIPHERTEXT = "v1.YWJjZGVmZ2hpamts.bW5vcHFyc3R1dnc.eHl6MTIzNDU2Nzg5";

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await resetRole(db);
  await db.exec("delete from streamers");
  await db.exec("delete from public.users");
  await db.exec("delete from auth.users");

  adminId = await createAuthUser(db, "admin@cbsoft.test", "An Admin");
  viewerId = await createAuthUser(db, "viewer@cbsoft.test", "A Viewer");
  await setRole(db, adminId, "admin");
  // The trigger already provisions `viewer`; being explicit documents intent.
  await setRole(db, viewerId, "viewer");

  const inserted = await db.query<{ id: string }>(
    `insert into streamers
       (streamer_code, streamer_name, page_id, page_name,
        encrypted_page_token, page_token_last_four, token_status)
     values ('RLS001', 'RLS Subject', '100000000000001', 'RLS Page', $1, 'wxyz', 'valid')
     returning id`,
    [CIPHERTEXT],
  );
  streamerId = inserted.rows[0]!.id;
});

/** Run a statement and report whether it was refused, without failing the test. */
async function attempt(sql: string, params: unknown[] = []) {
  try {
    const result = await db.query(sql, params);
    return { ok: true as const, rows: result.rows };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : "unknown" };
  }
}

describe("anonymous visitors", () => {
  beforeEach(async () => {
    await actAs(db, null, "anon");
  });

  it("cannot read the streamer roster", async () => {
    const result = await attempt("select id from streamers");
    expect(result.ok).toBe(false);
  });

  it("cannot read posts, videos, comments or summaries", async () => {
    for (const table of ["posts", "videos", "comments", "comment_summaries"]) {
      const result = await attempt(`select 1 from ${table}`);
      expect(result.ok, `anon read ${table}`).toBe(false);
    }
  });

  it("cannot read user profiles or the audit trail", async () => {
    for (const table of ["users", "audit_logs"]) {
      const result = await attempt(`select 1 from ${table}`);
      expect(result.ok, `anon read ${table}`).toBe(false);
    }
  });

  it("cannot reach the encrypted token by any route", async () => {
    const direct = await attempt("select encrypted_page_token from streamers");
    expect(direct.ok).toBe(false);

    // Not via a function call either.
    const indirect = await attempt("select length(encrypted_page_token) from streamers");
    expect(indirect.ok).toBe(false);
  });
});

describe("a viewer", () => {
  beforeEach(async () => {
    await actAs(db, viewerId, "authenticated");
  });

  it("can read the roster's non-sensitive columns", async () => {
    const result = await attempt(
      "select streamer_code, page_name, token_status, page_token_last_four from streamers",
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.rows).toHaveLength(1);
  });

  it("CANNOT read the encrypted token column", async () => {
    /*
     * The single most important assertion in this file. The column-level
     * REVOKE is what stands between a signed-in viewer and every Page token in
     * the workspace — a table-level policy alone would not do it, because the
     * viewer is legitimately allowed to select other columns of the same row.
     */
    const result = await attempt("select encrypted_page_token from streamers");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/permission denied|column/i);
  });

  it("cannot update a streamer", async () => {
    const result = await attempt("update streamers set streamer_name = 'Renamed'");
    // Either refused outright, or silently matching zero rows — both mean the
    // viewer changed nothing.
    const changed = await db.query<{ streamer_name: string }>(
      "select streamer_name from streamers where id = $1",
      [streamerId],
    );

    expect(result.ok === false || changed.rows[0]?.streamer_name === "RLS Subject").toBe(true);
    expect(changed.rows[0]?.streamer_name).toBe("RLS Subject");
  });

  it("cannot insert or delete a streamer", async () => {
    const inserted = await attempt(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('SNEAK', 'Sneaky', '100000000000009', 'Sneaky Page')`,
    );
    expect(inserted.ok).toBe(false);

    await attempt("delete from streamers");
    const remaining = await db.query("select 1 from streamers");
    expect(remaining.rows).toHaveLength(1);
  });

  it("sees only its own profile, not the whole user table", async () => {
    const result = await db.query<{ id: string }>("select id from public.users");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(viewerId);
  });

  it("cannot promote itself to admin", async () => {
    /*
     * Privilege escalation, the direct attempt. `users_update_admin` is the
     * only UPDATE policy on the table and it requires `is_admin()`, so a viewer
     * has no UPDATE path at all.
     */
    await attempt("update public.users set role = 'admin' where id = $1", [viewerId]);

    await resetRole(db);
    const after = await db.query<{ role: string }>("select role from public.users where id = $1", [
      viewerId,
    ]);

    expect(after.rows[0]?.role).toBe("viewer");
  });

  it("cannot read the audit trail", async () => {
    const result = await db.query("select 1 from audit_logs");
    // Policy is `is_admin()`, so a viewer sees an empty set rather than an error.
    expect(result.rows).toHaveLength(0);
  });
});

describe("an admin", () => {
  beforeEach(async () => {
    await actAs(db, adminId, "authenticated");
  });

  it("can read every user profile", async () => {
    const result = await db.query("select id from public.users");
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("can update a streamer", async () => {
    await db.query("update streamers set streamer_name = 'Renamed by admin' where id = $1", [
      streamerId,
    ]);

    const after = await db.query<{ streamer_name: string }>(
      "select streamer_name from streamers where id = $1",
      [streamerId],
    );
    expect(after.rows[0]?.streamer_name).toBe("Renamed by admin");
  });

  it("STILL cannot read the encrypted token", async () => {
    /*
     * Being an admin in the application is not the same as being able to read
     * ciphertext from the browser's connection. The REVOKE is on the role, not
     * on the policy, so it applies to every `authenticated` session regardless
     * of role — decryption happens server-side under the service role, and
     * nowhere else.
     */
    const result = await attempt("select encrypted_page_token from streamers");
    expect(result.ok).toBe(false);
  });
});

describe("the service role path", () => {
  it("reads the ciphertext, because that is where decryption happens", async () => {
    await resetRole(db);

    const result = await db.query<{ encrypted_page_token: string }>(
      "select encrypted_page_token from streamers where id = $1",
      [streamerId],
    );

    expect(result.rows[0]?.encrypted_page_token).toBe(CIPHERTEXT);
    // And it really is an envelope, not a plaintext token that slipped through.
    expect(result.rows[0]?.encrypted_page_token).toMatch(/^v\d+\./);
  });
});
