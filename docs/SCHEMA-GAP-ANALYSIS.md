# Schema Gap Analysis — live Supabase project vs. Phase 2 migrations

**Project:** `okwphbplckrxwveqqqrl` (`bryancastroco's Project`), ap-southeast-2, Postgres 17.6
**Analysed:** 2026-07-29

> ## RESOLVED — Option C taken, 2026-07-29
>
> The instruction was to remove everything that is not part of Phase 1 and Phase 2. Done:
> the `public` schema was reset to exactly the Phase 2 specification and the repository's
> migrations were applied.
>
> **Data was not destroyed.** All 902 rows and 58 object definitions were first copied into the
> `archive_pre_phase2` schema, which is not exposed to PostgREST and has all privileges revoked
> from `anon` and `authenticated`.
>
> | | Before | After |
> |---|---|---|
> | Tables | 11 | 4 |
> | Views | 7 | 0 |
> | Enums | 13 | 4 |
> | Security advisories | 7 errors, 14 warnings | 0 errors, 2 warnings |
>
> **To restore the old schema:** definitions are in `archive_pre_phase2._schema_ddl`
> (`kind` = view / function / enum / policy), and the rows are in the matching
> `archive_pre_phase2.<table>` tables as JSONB, one row per record in a `row` column.
>
> **To discard the archive once you are satisfied:**
> ```sql
> DROP SCHEMA archive_pre_phase2 CASCADE;
> ```
>
> The rest of this document is the analysis that informed the decision, kept for the record.

---

## 1. Headline

The Phase 2 migrations in `drizzle/` **cannot be applied to this project.** They fail on the very
first statement, and forcing them through would require dropping tables holding ~890 rows of real
data.

The live database is not a partial version of the Phase 2 design. It is a **more advanced,
independently built implementation of the same product** — it already covers ground my roadmap put
in Phases 3 through 6.

---

## 2. What is already in the database

11 tables, 7 views, 13 enums, 17 foreign keys, 32 RLS policies.

| Table | Rows | Purpose |
|-------|------|---------|
| `users` | 5 | Profile, FK to `auth.users`, 3-value role enum |
| `campaigns` | 3 | Campaign definitions with hashtag and quota requirements |
| `streamers` | 10 | Roster with campaign, game, AE assignment, enrollment baseline |
| `page_metric_snapshots` | 650 | Daily follower / likes / reach / engagement snapshots |
| `facebook_posts` | 111 | Per-post metrics, reaction breakdown, compliance review |
| `facebook_livestreams` | 50 | Per-stream metrics, qualified minutes, hashtag compliance |
| `facebook_shared_content` | 63 | Share-compliance tracking against due dates |
| `streamer_notes` | 10 | Free-text notes per streamer |
| `facebook_page_connections` | 0 | Page tokens and sync status |
| `import_batches` | 0 | CSV import provenance |
| `automation_runs` | 0 | n8n workflow run log |

Views: `v_streamer_overview`, `v_page_growth`, `v_streamer_content_totals`, `v_content_comparison`,
`v_latest_snapshot`, `v_baseline_snapshot`, `v_automation_health`.

Helper functions: `is_admin()`, `can_write()`, `auth_role()`, `owns_streamer(uuid)`,
`handle_new_user()`, `set_updated_at()`.

No rows in `supabase_migrations` — this schema was built through the dashboard or another tool, so
there is no migration history to extend.

---

## 3. Why the Phase 2 migration fails

`drizzle/0000_phase2_core.sql` in execution order:

| Statement | Result |
|-----------|--------|
| `CREATE TYPE public.sync_status AS ENUM('pending','running',…)` | **FAILS** — exists as `{not_connected, connected, syncing, error, expired}` |
| `CREATE TYPE public.user_role AS ENUM('admin','viewer')` | **FAILS** — exists as `{administrator, account_executive, management_viewer}` |
| `CREATE TABLE audit_logs` | would succeed — nothing like it exists |
| `CREATE TABLE streamers` | **FAILS** — exists, 10 rows, entirely different columns |
| `CREATE TABLE users` | **FAILS** — exists, 5 rows |
| `CREATE TABLE sync_runs` | would succeed |

It aborts on statement one. Nothing partial is applied.

### Column-level divergence on the two colliding tables

**`users`** — close, but not the same.

| Phase 2 | Live | Note |
|---------|------|------|
| `id uuid` → `auth.users` | `id uuid` → `auth.users` | ✅ identical approach |
| `email text` | `email citext` | live is better — case-insensitivity is enforced by type |
| `full_name text` nullable | `full_name text` NOT NULL | |
| `role user_role` default `viewer` | `role user_role` default `management_viewer` | 2 roles vs 3 |
| — | `status user_status` | live has active/inactive; Phase 2 has no equivalent |

**`streamers`** — barely related. Phase 2 modelled a streamer *as* its Page connection. The live
schema separates them and adds a whole campaign/compliance domain.

| Phase 2 | Live |
|---------|------|
| `page_id`, `page_name` | `facebook_page_id`, `facebook_page_name`, `facebook_page_url` |
| `encrypted_page_token`, `page_token_last_four`, `token_status`, `token_expires_at`, `token_scopes` | moved to `facebook_page_connections` |
| `active boolean` | `status streamer_status` (5 values) |
| `deleted_at` soft delete | none |
| — | `in_game_name`, `player_id`, `assigned_account_executive`, `enrollment_date`, `assigned_game`, `campaign_id`, `required_hashtag`, `starting_followers`, `starting_page_likes` |

---

## 4. What Phase 2 has that the live database lacks

Only three things — but two of them matter a lot.

### 4.1 No audit trail at all

There is no `audit_logs` table, and no equivalent. Nothing records who changed a role, connected a
Page, or ran a sync. The Phase 2 spec required this, and the append-only trigger design is worth
keeping.

### 4.2 Page tokens are not encrypted

`facebook_page_connections.page_access_token` is plain `text`. There is:

- no encryption — the column name says `page_access_token`, not `encrypted_…`
- no check constraint requiring a ciphertext envelope
- no column-level `REVOKE`, so any `authenticated` session that satisfies `is_admin()` can read the
  token straight out of PostgREST

This is **architecture rules 4 and 5**, which the project treats as non-negotiable.

**The table has 0 rows.** No token has ever been stored, so this is the cheapest possible moment to
fix it — a column rename plus the constraint and grant, with no data migration.

### 4.3 No `sync_runs`

`automation_runs` covers n8n workflow health (`workflow_name`, `rows_received/written/rejected`)
but not per-streamer sync outcomes — there is no `streamer_id`, no `posts_processed`,
`videos_processed`, `comments_processed`, `summaries_generated`. The two are complementary rather
than duplicates.

---

## 5. Security findings in the live database

From Supabase's own linter plus direct inspection. **These exist today, independent of Phase 2.**

| # | Level | Finding |
|---|-------|---------|
| 1 | **High** | `page_access_token` stored unencrypted and readable via PostgREST (§4.2) |
| 2 | **Error** | 7 views are `SECURITY DEFINER`: `v_streamer_overview`, `v_page_growth`, `v_streamer_content_totals`, `v_content_comparison`, `v_latest_snapshot`, `v_baseline_snapshot`, `v_automation_health`. They run with the creator's permissions, so RLS on the underlying tables does **not** apply to whoever queries the view. A `management_viewer` querying `v_streamer_overview` bypasses the row filtering the base tables impose |
| 3 | Warn | `handle_new_user()`, `is_admin()`, `can_write()`, `auth_role()`, `owns_streamer()` are all callable by `anon` over `/rest/v1/rpc/…`. `handle_new_user()` being publicly invokable is the concerning one |
| 4 | Warn | `set_updated_at()` has a mutable `search_path` — shadowing risk in a `SECURITY DEFINER` chain |
| 5 | Warn | `citext` extension installed in the `public` schema |
| 6 | Warn | Leaked-password protection (HaveIBeenPwned) is disabled in Supabase Auth |

Remediation reference: <https://supabase.com/docs/guides/database/database-linter>

**What is already good:** RLS is enabled on all 11 tables; policies use sensible helpers
(`is_admin()`, `owns_streamer()`, `can_write()`); read policies gate on `auth.uid() IS NOT NULL`,
so anonymous access is blocked in practice despite the policies targeting the `public` role.

---

## 6. Role model conflict

| | Phase 2 spec | Live database |
|---|---|---|
| Roles | `admin`, `viewer` | `administrator`, `account_executive`, `management_viewer` |
| Default | `viewer` | `management_viewer` |

The live model is the richer one and the schema depends on it —
`streamers.assigned_account_executive` and the `owns_streamer()` policy helper both assume account
executives own a subset of the roster. Collapsing to two roles would discard a distinction the data
already uses.

Mapping that preserves both, with no enum migration:

| Live role | Phase 2 permission set |
|-----------|------------------------|
| `administrator` | full admin |
| `account_executive` | viewer now; streamer-management rights in Phase 3 |
| `management_viewer` | viewer |

---

## 7. Options

**A — Adapt Phase 2 to the live schema.** Regenerate `src/lib/db/schema.ts` from the real database,
extend `src/lib/auth/roles.ts` to three roles with the mapping above, and add one migration for the
genuinely missing pieces: `audit_logs`, token encryption on `facebook_page_connections`, and
`sync_runs`. Keeps all 890 rows. Also lets us close the §5 findings. Estimated: most of the auth
layer (`proxy.ts`, guards, session, route policy, login, user management, tests) survives unchanged
— it is the schema and role enum that move.

**B — Fresh Supabase project.** Phase 2 applies exactly as written, zero risk. But the campaign,
compliance and metric work in the live database is abandoned.

**C — Reset this project's public schema.** Destroys 890 rows and 11 tables. Only if this is
throwaway test data.

**Recommendation: A.** The live schema is ahead of the Phase 2 design, and the parts of Phase 2 it
lacks — audit trail and token encryption — are exactly the parts that are cheap to add right now,
while `facebook_page_connections` is still empty.
