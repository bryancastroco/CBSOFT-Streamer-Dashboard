-- =============================================================================
-- Phase 2 — function hardening
--
-- Closes four warnings raised by the Supabase database linter against objects
-- created in migration 0001. Both classes are real, not cosmetic.
--
-- 1. Mutable search_path on SECURITY DEFINER-adjacent functions. Without a
--    pinned search_path, a caller who can create objects in a schema earlier in
--    the path can shadow a name the function resolves at runtime.
--
-- 2. Trigger functions exposed as PostgREST RPC endpoints. Supabase's default
--    privileges grant EXECUTE on every function in `public` to `anon` and
--    `authenticated`, which publishes them at /rest/v1/rpc/<name>. A trigger
--    function has no business being callable directly by a browser — and
--    `handle_new_auth_user` in particular inserts into public.users.
--
--    Note that `REVOKE ... FROM PUBLIC` alone does NOT fix this: the roles hold
--    their own explicit grants from Supabase's default privileges, so they must
--    be named directly.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Pin search_path
--
-- Neither function references a table, so an empty search_path is safe and is
-- the strongest option available.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.set_updated_at()             SET search_path = '';
ALTER FUNCTION public.reject_audit_log_mutation()  SET search_path = '';


-- -----------------------------------------------------------------------------
-- 2. Take trigger functions off the REST surface
--
-- Triggers execute as the table owner regardless of who holds EXECUTE, so
-- revoking these does not affect the triggers themselves.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.handle_new_auth_user()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_audit_log_mutation() FROM PUBLIC, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. is_admin() — signed-in callers only
--
-- `authenticated` must keep EXECUTE: the RLS policies call is_admin(), and a
-- policy is evaluated as the querying role. `anon` has no policy that uses it,
-- so it has no reason to hold the grant.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
