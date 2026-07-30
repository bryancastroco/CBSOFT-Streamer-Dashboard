# Environments, migrations and auth redirects

Three environments — Development, Preview, Production — and what differs
between them. Phase 12.

- Variable meanings and how to generate each: [`.env.example`](../.env.example)
- Deployment procedure: [`SETUP.md`](./SETUP.md)

---

## 1. Where each variable lives

| Variable | Type in Vercel | Targets | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | plain | dev, preview, prod | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | plain | dev, preview, prod | Public by design; useless without an RLS policy |
| `NEXT_PUBLIC_APP_NAME` | plain | dev, preview, prod | Display only |
| `NEXT_PUBLIC_APP_URL` | plain | **prod only** | Not set on preview — see §2 |
| `SUPABASE_SERVICE_ROLE_KEY` | **sensitive** | preview, prod | |
| `DATABASE_URL` | **sensitive** | preview, prod | |
| `META_APP_SECRET` | **sensitive** | preview, prod | |
| `TOKEN_ENCRYPTION_KEY` | **sensitive** | preview, prod | |
| `CRON_SECRET` | **sensitive** | preview, prod | |
| `N8N_API_SECRET` | **sensitive** | preview, prod | |
| `META_APP_ID` | encrypted | dev, preview, prod | Not secret, but not public either |
| `META_GRAPH_API_VERSION` | encrypted | dev, preview, prod | |
| `AI_PROVIDER`, `ANTHROPIC_MODEL` | encrypted | dev, preview, prod | |
| `ANTHROPIC_API_KEY` | **sensitive** | preview, prod | **Not yet set** — see §5 |
| The six sync ceilings | encrypted | dev, preview, prod | |
| `AI_SUMMARIZATION_ENABLED` | encrypted | dev, preview, prod | Currently `false` |
| `GOOGLE_SHEETS_EXPORT_ENABLED` | encrypted | dev, preview, prod | |

**Why the six secrets skip Development.** Vercel's `sensitive` type is
write-only: it cannot be read back through the dashboard or the API, only
replaced. Vercel therefore refuses to attach it to the Development target,
whose whole purpose is to be pulled locally with `vercel env pull`. Local
development reads `.env.local` instead, which is the better split — a
production service-role key has no reason to be downloadable to a laptop.

**Never a Vercel variable:** an individual streamer's Page token. Those are
AES-256-GCM ciphertext in `streamers.encrypted_page_token`, one row per
streamer, added through the admin UI. A token in an environment variable would
be readable by every function in the deployment and by anyone with dashboard
access, and could not be rotated per streamer.

---

## 2. Why `NEXT_PUBLIC_APP_URL` is production-only

A preview deployment has no stable hostname — Vercel mints one per commit. Set
a canonical URL for previews and every preview after the first is wrong.

`resolveAppOrigin()` in [`src/lib/config/app-origin.ts`](../src/lib/config/app-origin.ts)
resolves in this order:

1. `NEXT_PUBLIC_APP_URL` — canonical production origin
2. `VERCEL_PROJECT_PRODUCTION_URL`
3. `VERCEL_URL` — this deployment, the only truth on a preview
4. `http://localhost:3000`

The request `Host` header is deliberately **not** in that list. Building an
absolute URL from it is host-header poisoning: an attacker sends
`Host: evil.test` to a password-reset endpoint and the victim receives a real
token pointed at the attacker. `originFromRequest()` exists for the cases where
a request origin genuinely is the answer, and it validates the header against
the resolved allow-list rather than echoing it. `tests/app-origin.test.ts`
pins that behaviour, including look-alike hosts such as
`cbsoft.example.com.evil.test`.

---

## 3. Supabase Auth redirect URLs

Add these under **Authentication → URL Configuration**.

**Site URL** — the production origin only:

```
https://<production-domain>
```

**Redirect URLs** — one per line. Wildcards are supported and are the only
practical way to cover preview deployments:

```
http://localhost:3000/**
https://<production-domain>/**
https://<vercel-project-name>-*.vercel.app/**
https://*-<vercel-team-slug>.vercel.app/**
```

For this project the last two resolve to:

```
https://cbsoft-streamer-dashboard-*.vercel.app/**
https://*-combo-inter-active.vercel.app/**
```

### What currently depends on this

Honestly: **nothing yet.** Sign-in is a password grant through a Server Action
and redirects to a relative path, so no Supabase redirect URL is consulted. The
list matters for flows that send a link:

| Flow | Status |
|---|---|
| Email confirmation | Active if "Confirm email" is on — the link uses Site URL |
| Password reset | Not implemented; needs `redirectTo` |
| Magic link / OAuth | Not implemented |

Configure it now anyway. The failure mode when it is missing is a user clicking
a link and landing on `localhost:3000` from their phone, which is confusing to
diagnose after the fact.

### Redirect safety already in place

- `sanitiseNextPath()` rejects anything not starting with a single `/` — so
  `//evil.com`, `https://evil.com` and `/\evil.com` cannot become a post-login
  bounce. Covered by `tests/route-policy.test.ts`.
- Session cookies come from `@supabase/ssr`, which sets `Secure` on HTTPS and
  `SameSite=Lax`.
- Redirect loops are prevented by `resolveRouteAccess` marking `/login` public,
  so an unauthenticated user landing there is never redirected again.
- Authorisation is re-checked server-side on every protected page and inside
  every Server Action. The middleware gate is an optimisation, never the only
  check.

---

## 4. Migrations

Thirteen migrations in [`drizzle/`](../drizzle), all committed. Drizzle has no
client-generation step: `db:generate` writes SQL from the schema at authoring
time and the output is committed, so there is nothing to generate at build time.

| Command | When |
|---|---|
| `npm run db:generate` | After editing `src/lib/db/schema.ts`. Writes SQL; commit it. |
| `npm run db:migrate` | Local. Reads `.env.local`. |
| `npm run db:migrate:deploy` | CI/production. Non-interactive; reads the ambient environment. |
| `npm run db:verify` | Applies every migration to a throwaway Postgres and asserts the result. |
| `npm run db:seed -- --email you@example.com` | First admin. Once per environment, by hand. |

### Per environment

**Development** — `npm run db:migrate` against your own project or branch.

**Preview** — previews currently share the Production database (see §5). Until
that changes, do not run a migration "for preview": you are migrating
production.

**Production** — deliberate and manual:

```bash
npm run db:verify
npm run db:migrate:deploy
```

Use the **direct** connection on port 5432, not the pooler on 6543. The
transaction pooler cannot run DDL reliably.

**Nothing runs during a Vercel build.** No migration, no seed, no reset. A build
that migrates would apply schema changes on every preview deployment against
whatever database that preview points at.

### Rollback

Drizzle generates forward-only migrations; there are no down-migrations, and
adding them would be a false comfort — a dropped column cannot be un-dropped by
running a script.

- **Additive changes** (new table, nullable column, new index) — safe. Roll back
  by deploying the previous application version; the extra column is ignored.
- **Destructive changes** (drop or rename a column, tighten a constraint) — not
  reversible. Take a Supabase backup first, and prefer expand-then-contract:
  add the new column, backfill, ship code that reads both, drop the old column
  in a later migration once nothing reads it.
- **Never** in a migration: dropping `streamers`, dropping
  `encrypted_page_token`, or truncating any table. Losing the encryption key or
  that column means every Page token must be re-entered by hand.

### Migration user permissions

Migrations run as the Postgres role in `DATABASE_URL` — the `postgres`
superuser on Supabase, which owns the schema. It can create tables, enums,
policies and triggers, and can `GRANT`/`REVOKE` on behalf of `anon` and
`authenticated`. `db:verify` proves the whole sequence applies from empty, which
is a stronger check than any permission audit.

---

## 5. Known gaps

**Preview and Production share one Supabase project.** Only
`okwphbplckrxwveqqqrl` exists. So a preview deployment reads and writes
production data, and a migration applied for a preview is applied to production.
Acceptable while the roster is one streamer; not acceptable once this is
reporting to anyone. The fix is a second Supabase project — or a Supabase branch
— with its own `DATABASE_URL` and keys on the Preview target only.

**`ANTHROPIC_API_KEY` is not set in Vercel** and `AI_SUMMARIZATION_ENABLED` is
`false` in all three environments. The schema now requires the key only while
that switch is true, so the application starts cleanly without it and skips
summarisation. Set both together when a real key exists.

**`NEXT_PUBLIC_APP_URL` is not set**, because the production domain is not yet
known. Until it is, `resolveAppOrigin()` falls back to `VERCEL_URL`. Set it on
the Production target once the domain is decided, and make the Supabase Site URL
agree with it.
