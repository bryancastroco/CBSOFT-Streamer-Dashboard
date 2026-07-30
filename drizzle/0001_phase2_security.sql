-- =============================================================================
-- Phase 2 — security posture
--
-- Drizzle owns the tables. This migration owns everything that makes them safe:
-- the link to Supabase Auth, auto-provisioning, updated_at maintenance, the
-- append-only audit trail, Row Level Security, and the column-level revoke that
-- keeps Page tokens away from every client role.
--
-- Written to be idempotent so it can be re-applied to a partially migrated
-- database without failing.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Link public.users to auth.users
--
-- Drizzle cannot express a foreign key into a non-public schema, so it is added
-- here. Deleting an auth user removes the application profile with it.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'auth' AND table_name = 'users')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_id_auth_users_id_fk')
  THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_id_auth_users_id_fk
      FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- 2. Auto-provision a profile when an auth user is created
--
-- Every new account lands as `viewer`. Roles are only ever granted afterwards,
-- deliberately, by an admin — there is no path by which signing up produces
-- administrative access.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data ->> 'full_name', '')), ''),
    'viewer'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'auth' AND table_name = 'users')
  THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
  END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- 3. updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS streamers_set_updated_at ON public.streamers;
CREATE TRIGGER streamers_set_updated_at
  BEFORE UPDATE ON public.streamers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. audit_logs is append-only
--
-- Enforced by trigger rather than by policy alone, so it holds even for the
-- service role and for a direct psql session. An audit trail that privileged
-- code can quietly rewrite is not an audit trail.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.reject_audit_log_mutation();


-- -----------------------------------------------------------------------------
-- 5. Role helper
--
-- SECURITY DEFINER so the policy on `users` does not re-enter `users` through
-- RLS, which would recurse. `search_path` is pinned to defeat shadowing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;


-- -----------------------------------------------------------------------------
-- 6. Row Level Security
--
-- A table with RLS enabled and no matching policy denies everything, which is
-- the default we want. The service role bypasses RLS by design — server code is
-- trusted, and it does its own authorisation in src/lib/auth/guards.ts.
-- -----------------------------------------------------------------------------
ALTER TABLE public.users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streamers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- users ----------------------------------------------------------------------
DROP POLICY IF EXISTS users_select_self ON public.users;
CREATE POLICY users_select_self ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS users_select_admin ON public.users;
CREATE POLICY users_select_admin ON public.users
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Only admins may change a profile, and NOBODY may change their own row
-- through this surface. Self-promotion is the escalation path that matters
-- most, so it is blocked in the policy itself, not only in application code.
DROP POLICY IF EXISTS users_update_admin ON public.users;
CREATE POLICY users_update_admin ON public.users
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin() AND id <> auth.uid());

-- No INSERT or DELETE policy: profiles are created by the auth trigger and
-- removed by the cascade from auth.users. Neither is a client operation.

-- streamers ------------------------------------------------------------------
DROP POLICY IF EXISTS streamers_select_authenticated ON public.streamers;
CREATE POLICY streamers_select_authenticated ON public.streamers
  FOR SELECT TO authenticated
  USING (deleted_at IS NULL);

-- Writes are admin-only. In practice they arrive through the server, but the
-- policy means a stolen anon key plus a valid viewer session still cannot
-- create, edit or delete a streamer.
DROP POLICY IF EXISTS streamers_insert_admin ON public.streamers;
CREATE POLICY streamers_insert_admin ON public.streamers
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS streamers_update_admin ON public.streamers;
CREATE POLICY streamers_update_admin ON public.streamers
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS streamers_delete_admin ON public.streamers;
CREATE POLICY streamers_delete_admin ON public.streamers
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- sync_runs ------------------------------------------------------------------
DROP POLICY IF EXISTS sync_runs_select_authenticated ON public.sync_runs;
CREATE POLICY sync_runs_select_authenticated ON public.sync_runs
  FOR SELECT TO authenticated
  USING (true);

-- No write policy at all: sync runs are written exclusively by server code
-- using the service role.

-- audit_logs -----------------------------------------------------------------
DROP POLICY IF EXISTS audit_logs_select_admin ON public.audit_logs;
CREATE POLICY audit_logs_select_admin ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- No INSERT policy: the trail is written by the server only.


-- -----------------------------------------------------------------------------
-- 7. Least-privilege grants — architecture rules 4 and 5
--
-- RLS is row-level; it cannot hide a column. Column privileges can — but ONLY
-- if the role holds no table-wide grant for that command. In Postgres a
-- table-level GRANT SELECT implies every column, and a column-level REVOKE
-- cannot subtract from it:
--
--     GRANT SELECT ON t TO r;               -- r can read every column
--     REVOKE SELECT (secret) ON t FROM r;   -- no effect: the table grant wins
--
-- So the order below matters. Every table-level grant is stripped first, then
-- privileges are re-granted column by column, deliberately omitting
-- `encrypted_page_token`. This is what actually stops a Page token being read
-- through PostgREST, even by an admin session, even via `select *`.
--
-- `service_role` is untouched throughout: server code needs the ciphertext to
-- make Meta Graph calls, and it is the only thing that does.
-- -----------------------------------------------------------------------------

-- Strip everything first. A table with no grant denies regardless of policy.
REVOKE ALL ON public.users      FROM anon, authenticated;
REVOKE ALL ON public.streamers  FROM anon, authenticated;
REVOKE ALL ON public.sync_runs  FROM anon, authenticated;
REVOKE ALL ON public.audit_logs FROM anon, authenticated;

-- anon gets nothing at all. Signed-out visitors have no data surface.

-- users: read, plus the narrow updates the admin policy allows. `id`,
-- `created_at` and `updated_at` are not grantable for UPDATE — they are
-- identity and provenance.
GRANT SELECT ON public.users TO authenticated;
GRANT UPDATE (full_name, role) ON public.users TO authenticated;

-- streamers: every column EXCEPT encrypted_page_token.
--
-- `page_token_last_four` is included on purpose: four characters of a token are
-- a recognition aid for operators, not a credential.
GRANT SELECT (
  id, streamer_code, streamer_name, page_id, page_name,
  page_token_last_four, token_status, token_expires_at, token_scopes,
  active, notes, last_successful_sync_at, last_sync_error,
  created_at, updated_at, deleted_at
) ON public.streamers TO authenticated;

GRANT INSERT (
  streamer_code, streamer_name, page_id, page_name,
  token_status, token_expires_at, token_scopes,
  active, notes
) ON public.streamers TO authenticated;

GRANT UPDATE (
  streamer_code, streamer_name, page_id, page_name,
  token_status, token_expires_at, token_scopes,
  active, notes, deleted_at
) ON public.streamers TO authenticated;

GRANT DELETE ON public.streamers TO authenticated;

-- sync_runs and audit_logs: read only, and the policies narrow it further —
-- audit_logs to admins, sync_runs to any signed-in user.
GRANT SELECT ON public.sync_runs  TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
