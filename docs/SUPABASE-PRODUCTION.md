# Supabase in production

## The project

| | |
| --- | --- |
| Reference | `okwphbplckrxwveqqqrl` |
| Region | `ap-southeast-2` |
| Postgres | 17.6 |
| Status | `ACTIVE_HEALTHY` |

**Preview and Production share this one project.** That is a real limitation,
not an oversight deferred: a preview deployment writes to the same rows
production serves. Until a second project exists, treat any preview sync as a
production write, and prefer read-only checks against previews.

Splitting them later means a second project, a second `DATABASE_URL`, and
running the migrations there — no code change.

## Connection

`DATABASE_URL` uses the **transaction pooler** (port 6543), not a direct
connection. Serverless functions open and discard connections constantly, and
Postgres cannot absorb that directly.

The pooler does not support prepared statements, so the client is configured
accordingly in `src/lib/db`:

```ts
postgres(url, { prepare: false, max: 1 })
```

`prepare: false` is required by the pooler. `max: 1` reflects that each
serverless invocation is its own short-lived process — a larger pool per
invocation multiplies connections without helping.

This has a consequence worth knowing: **a `Date` object inside a raw `sql`
fragment fails** under `prepare: false` with `ERR_INVALID_ARG_TYPE`, taking the
whole statement with it. Use the `tsParam()` helper in `src/lib/db/params.ts`,
which `tests/raw-sql-timestamps.test.ts` enforces across the codebase.

## Migrations

Non-destructive, forward-only:

```bash
npm run db:migrate
```

It applies anything in `drizzle/` that is not yet recorded in
`drizzle.__drizzle_migrations`. It never drops, resets or seeds.

**Do not** use `drizzle-kit push` against production. It diffs and applies
directly, skipping the ledger, and will happily drop a column to make the
schema match.

Confirm afterwards:

```sql
select count(*) from drizzle.__drizzle_migrations;                  -- 11
select count(*) from information_schema.tables where table_schema = 'public';  -- 11
```

The eleven application tables: `users`, `streamers`, `posts`, `post_insights`,
`videos`, `video_insights`, `comments`, `comment_summaries`, `sync_runs`,
`export_runs`, `audit_logs`.

### Structures worth checking by name

```sql
-- One active roster sweep, enforced by Postgres rather than by application code.
select indexname from pg_indexes
 where schemaname = 'public' and indexname = 'sync_runs_one_active_sweep_idx';

-- Terminal statuses must carry a completion time.
select conname from pg_constraint where conname = 'sync_runs_terminal_status_check';

-- Six statuses and four trigger sources.
select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
 where t.typname in ('sync_status', 'trigger_source') order by t.typname, e.enumsortorder;
```

`sync_status` must be exactly `queued, processing, completed, failed,
completed_with_errors, cancelled`, and `trigger_source` exactly `admin, n8n,
vercel_cron, system_retry`.

### If the ledger and the schema disagree

Applying a migration outside drizzle — through the SQL editor, say — changes the
schema without recording it, and the next `db:migrate` tries to replay it. Fix
the ledger, never the migration file: editing an applied file changes its hash
and makes the mismatch permanent. See
[PRODUCTION-TROUBLESHOOTING.md](./PRODUCTION-TROUBLESHOOTING.md).

## Authentication

Supabase Auth issues the session; roles live in the application's own `users`
table. Two roles only, `admin` and `viewer`, defined in `src/lib/auth/roles.ts`.

### Redirect URLs

**Authentication → URL Configuration**:

- **Site URL:** `https://cbsoft-streamer-dashboard.vercel.app`
- **Redirect URLs:** add every origin that completes a sign-in —
  `https://cbsoft-streamer-dashboard.vercel.app/**`, `http://localhost:3000/**`,
  and a preview pattern such as
  `https://cbsoft-streamer-dashboard-*-combo-inter-active.vercel.app/**` if you
  sign in to previews.

An origin missing here fails at the *end* of sign-in, after credentials are
accepted, which reads like a broken password rather than a configuration gap.

### The first administrator

```bash
npm run seed:admin
```

Promotes an existing Supabase Auth user to `admin` and writes the change to
`audit_logs`. Create the user in **Authentication → Users** first — the script
grants a role, it does not create accounts.

Verify:

```sql
select count(*) from public.users where role = 'admin';   -- at least 1
```

Never grant `admin` with a bare `UPDATE`. Role changes belong in `audit_logs`
in the same transaction that applies them, which is what the script does and a
manual statement does not.

### A migration that bites

Supabase Auth returns 500 with `converting NULL to string` when certain token
columns are `NULL` rather than empty. If sign-in breaks after a restore:

```sql
update auth.users set
  confirmation_token      = coalesce(confirmation_token, ''),
  recovery_token          = coalesce(recovery_token, ''),
  email_change            = coalesce(email_change, ''),
  email_change_token_new  = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change            = coalesce(phone_change, ''),
  phone_change_token      = coalesce(phone_change_token, ''),
  reauthentication_token  = coalesce(reauthentication_token, '');
```

## Row Level Security

Every application query runs through the service role from the server, so RLS
is not what protects the data — `requireUser()`, `requireAdmin()` and
`assertAdmin()` are. RLS is defence in depth for the case where a key leaks.

`tests/rls-behaviour.test.ts` pins the intended behaviour. Do not rely on RLS
alone for authorisation, and do not remove the server-side guards because RLS
exists.

## Backups

Free tier: daily snapshots, so the worst-case recovery point is 24 hours.
Point-in-time recovery is paid. Take a manual snapshot before anything
irreversible — a destructive migration, a bulk update, a token re-encryption.

The encrypted Page tokens are in these backups. A restored backup is as
sensitive as the live database, and is useless without the matching
`TOKEN_ENCRYPTION_KEY` — which means losing that key loses the tokens in every
backup too.
