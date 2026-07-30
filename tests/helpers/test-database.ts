import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

/**
 * Boots a real Postgres in-process (PGlite, Postgres compiled to WASM) and
 * applies the project's actual migration files to it.
 *
 * This is not a simulation of the schema — it is the schema. If a migration
 * would fail against Supabase for a syntax or dependency-ordering reason, it
 * fails here first, in CI, instead of during a production deploy.
 *
 * Supabase-managed objects that the migrations depend on do not exist in a bare
 * Postgres, so they are stubbed to match the real thing closely enough for the
 * migration to be exercised: the `auth` schema, `auth.users`, `auth.uid()`, and
 * the `anon` / `authenticated` roles.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

type Journal = {
  entries: { idx: number; tag: string }[];
};

const SUPABASE_STUBS = `
  CREATE SCHEMA IF NOT EXISTS auth;

  -- Mirrors the columns migration 0001 actually reads.
  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Supabase derives this from the request JWT. Here it is driven by a GUC so
  -- a test can "become" a given user.
  CREATE OR REPLACE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $fn$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $fn$;

  DO $roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
  END
  $roles$;

  -- Supabase grants broadly by default; reproduce that so the REVOKEs in
  -- migration 0001 have something to actually take away.
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated;
`;

export async function createTestDatabase(): Promise<PGlite> {
  const db = await PGlite.create();

  await db.exec(SUPABASE_STUBS);
  await applyMigrations(db);

  return db;
}

export async function applyMigrations(db: PGlite): Promise<string[]> {
  const journalRaw = await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(journalRaw) as Journal;

  const applied: string[] = [];

  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const file = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sql = await readFile(file, "utf8");

    // Drizzle's breakpoint marker is a SQL comment; Postgres ignores it, and
    // the simple query protocol handles the rest of the file in one go.
    await db.exec(sql);
    applied.push(entry.tag);
  }

  return applied;
}

/** Run the remainder of the session as the given user, for RLS assertions. */
export async function actAs(db: PGlite, userId: string | null, role: string): Promise<void> {
  await db.exec(`RESET ROLE;`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ""]);
  await db.exec(`SET ROLE ${role};`);
}

export async function resetRole(db: PGlite): Promise<void> {
  await db.exec("RESET ROLE;");
}

/** Insert an auth user, letting the migration's trigger provision the profile. */
export async function createAuthUser(
  db: PGlite,
  email: string,
  fullName?: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO auth.users (email, raw_user_meta_data)
     VALUES ($1, $2::jsonb)
     RETURNING id`,
    [email, JSON.stringify(fullName ? { full_name: fullName } : {})],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to create auth user");
  return id;
}

export async function setRole(db: PGlite, userId: string, role: "admin" | "viewer"): Promise<void> {
  await db.query(`UPDATE public.users SET role = $1 WHERE id = $2`, [role, userId]);
}
