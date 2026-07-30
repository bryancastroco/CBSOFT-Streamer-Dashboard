# CBSOFT Streamer Performance Dashboard

Performance monitoring and reporting for CBSOFT streamers broadcasting on **Facebook Pages**.
Metrics are collected server-side from the Meta Graph API, stored in Supabase PostgreSQL, shown in
a Next.js dashboard, and exported to Google Sheets by n8n.

**Status: complete.** All ten phases are built, tested and documented. Collection runs on a
schedule, the dashboard is live, and the Google Sheets mirror is fed by n8n.

| | |
|---|---|
| **Set up from scratch** | [`docs/SETUP.md`](./docs/SETUP.md) — every service, in order |
| **Deploy** | [`docs/SETUP.md#8-vercel-deployment`](./docs/SETUP.md#8-vercel-deployment) |
| **Automate** | [`docs/N8N-PRODUCTION-WORKFLOW.md`](./docs/N8N-PRODUCTION-WORKFLOW.md) |
| **Something is broken** | [`docs/SETUP.md#troubleshooting`](./docs/SETUP.md#troubleshooting) |

---

## Architecture rules

These are non-negotiable and enforced structurally, not by convention:

1. **Supabase PostgreSQL is the primary database.**
2. **Google Sheets is a reporting and export destination — never a source of truth.**
3. **n8n calls secure application API endpoints** to trigger synchronisation and to pull normalised
   rows for export. It holds no database, Meta or Supabase credentials.
4. **Facebook Page tokens are encrypted at rest** (AES-256-GCM).
5. **Page tokens never reach the browser, Google Sheets, or n8n.**
6. **All Meta Graph API calls happen on the server.** There is no browser Facebook SDK.
7. **Only Facebook Pages are supported.** Personal profiles are out of scope.

How each is mechanically enforced: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §2.

---

## Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` |
| Styling | Tailwind CSS v4, shadcn/ui |
| Database | Supabase PostgreSQL |
| ORM | Drizzle |
| Auth | Supabase Auth (`@supabase/ssr`) |
| Validation | Zod v4 |
| Charts | Recharts |
| AI | Anthropic API (comment summaries, Phase 7) |
| Automation | n8n |
| Reporting | Google Sheets |
| Hosting | Vercel |

**Why Drizzle over Prisma:** no query-engine binary keeps Vercel cold starts low, and a
TypeScript-native schema means `strict` mode covers the data layer too.

---

## Getting started

Node.js 20.9 or newer, a Supabase project, a Meta app and an Anthropic key.
[`docs/SETUP.md`](./docs/SETUP.md) walks through all of them; this is the short version.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` — every variable is documented inline. Three you generate yourself:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

for `TOKEN_ENCRYPTION_KEY`, and:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

separately for `CRON_SECRET` and `N8N_API_SECRET` — they must differ.

Apply the migrations with `DATABASE_URL` pointed at the **direct** Supabase connection (port 5432);
the transaction pooler on 6543 cannot run DDL reliably. Switch it back to the pooler afterwards.

```bash
npm run db:migrate
```

Create the first administrator:

```bash
npm run seed:admin -- --email you@cbsoft.example --name "Your Name"
```

Then:

```bash
npm run dev
```

Sign in at `http://localhost:3000` with the credentials the seed script printed. `/settings` shows
a live configuration check — it reports missing key **names**, never values.

Add your first streamer at **Admin → Streamers → Add streamer**, then use **Sync Posts** on its
Settings tab to confirm the Meta connection works.

---

## Creating the first administrator

Every account created through Supabase Auth is provisioned as a **viewer** by a database trigger.
There is no signup path that produces administrative access, so the first admin must be seeded.

```bash
npm run seed:admin -- --email you@cbsoft.example --name "Your Name"
```

The script needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` in
`.env.local`, and:

1. Creates the Supabase Auth user if the email is new — with a generated password and the email
   pre-confirmed — or finds the existing account and leaves its password untouched.
2. Ensures the `public.users` profile row exists.
3. Promotes it to `admin` and writes a `user.role_changed` audit entry, in one transaction.

The generated password is printed **once** and stored nowhere. Change it after signing in. Pass
`--password "…"` to choose your own instead.

It is safe to re-run: an account that is already an admin is left alone.

After that, promote further admins through **Admin → Users** in the app, which is audited. A user
must sign in once before they appear there — that is what creates their profile row.

### Roles

| Role | Can |
|------|-----|
| **Admin** | Manage streamers, manage Page tokens, trigger synchronisation, view sync errors, manage users and settings |
| **Viewer** | View dashboards and reports. Cannot manage or trigger anything |

Nobody can change their own role, and the last admin cannot be demoted — both enforced in the
database transaction and in the RLS policy. Details in
[`docs/AUTHORIZATION.md`](./docs/AUTHORIZATION.md).

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint with autofix |
| `npm run test` | Vitest |
| `npm run test:watch` | Vitest in watch mode |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check |
| `npm run verify` | typecheck → lint → test → build. All four must pass |
| `npm run verify:bundle` | Build, then scan the client bundle for secrets |
| `npm run db:generate` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply migrations |
| `npm run db:verify` | Apply migrations to an in-process Postgres and assert the result — **no database needed** |
| `npm run db:push` | Push schema (development only) |
| `npm run db:studio` | Drizzle Studio |
| `npm run seed:admin` | Create or promote the first administrator |

Database scripts read `.env.local` automatically. Use the **direct** Supabase connection (port 5432)
for migrations; the transaction pooler (6543) cannot run DDL reliably.

`npm run db:verify` boots a real Postgres in-process (PGlite) and applies the actual migration
files to it, so the SQL can be validated in CI without provisioning a database.

---

## Project structure

```
src/
  proxy.ts                 Edge auth gate (Next 16's renamed middleware)
  app/
    (auth)/login/          Sign-in form + server actions
    (app)/                 Authenticated shell — requireUser()
      loading.tsx          Navigation-level skeleton
      error.tsx            Segment error boundary (never shows raw messages)
      dashboard/           Ten metric cards + the shared filter bar
      posts/ videos/       Sortable, searchable tables and detail screens
      comment-analysis/    Cross-content AI analysis list
      streamers/[id]/      Six-tab streamer detail (Settings is admin-only)
      reports/ settings/
      admin/               requireAdmin() in its own layout
        users/             User management, role changes, audit trail
        streamers/         Roster, tokens, sync panels
    unauthorized/          Shown when authenticated but not permitted
    global-error.tsx       Root-layout failure; renders its own <html>
    api/
      health/              Public liveness + configuration check   live
      admin/               Session-authenticated admin operations  live
      posts/               Read-only post queries                  live
      export/              CSV downloads, permission-checked       live
        sheets/            One CSV per spreadsheet tab
      automation/          Bearer-authenticated n8n surface        live
        sync-all/          Roster sweep, returns a run id
        sync-streamer/     One streamer, synchronously
        sync-runs/         Run status for the polling loop
        exports/           Seven Sheets-shaped datasets
        google-sheets/     The spreadsheet layout, machine-readable
      n8n/                 Retired placeholders                    410
      cron/daily-sync/     Vercel Cron scheduled refresh           501, deferred
  components/
    ui/                    shadcn/ui primitives (vendored)
    layout/                Shell, sidebar, mobile nav, tab nav, page header
    theme/                 next-themes provider and toggle
    data/                  Filter bar, sortable headers, pagination,
                           metric cards, empty/loading/error states
    tables/                One table implementation per content type,
                           shared by the list screen and the streamer tab
  config/
    env.ts                 server-only Zod environment contract
    public-env.ts          the ONLY browser-visible environment values
  lib/
    auth/                  roles, route policy, session, guards
    audit/                 Append-only audit trail                [server-only]
    repositories/          Data access; assumes assertAdmin() ran [server-only]
    supabase/              browser / server (RLS) / admin (service role)
    db/                    Drizzle client and schema              [server-only]
    crypto/                AES-256-GCM Page-token encryption      [server-only]
    security/              Bearer auth for n8n and cron           [server-only]
    meta/                  Graph API access                       [server-only]
    services/              Sync orchestration (posts, videos,
                           comments)                              [server-only]
    comments/              Content refs and deterministic hashing
    ai/                    Anthropic summaries                    [server-only]
    google-sheets/         Export row and column contract         [server-only]
  types/
drizzle/                   Generated SQL migrations
scripts/seed-admin.ts      First-administrator seed
tests/                     Vitest: route policy, guards, RBAC, migrations
docs/                      Architecture, authorization, security, data model
```

Modules marked `[server-only]` import the `server-only` package: importing them from a Client
Component is a **build error**. That is the mechanism keeping rules 5 and 6 true as the codebase
grows, and ESLint blocks the same import paths as a second line of defence.

---

## API endpoints

| Endpoint | Auth | Status |
|----------|------|--------|
| `GET /api/health` | none | Live. Returns config status and missing key *names*. |
| `GET /api/admin/streamers` | admin session | Live. List the roster. |
| `POST /api/admin/streamers` | admin session | Live. Add a streamer, optionally with a token. |
| `GET /api/admin/streamers/{id}` | admin session | Live. One streamer plus recent sync runs. |
| `PATCH /api/admin/streamers/{id}` | admin session | Live. Edit details, enable/disable. |
| `DELETE /api/admin/streamers/{id}` | admin session | Live. Soft delete; destroys the token. |
| `POST /api/admin/streamers/{id}/validate-token` | admin session | Live. Re-check against Meta. |
| `POST /api/admin/streamers/{id}/replace-token` | admin session | Live. Rotate the token. |
| `POST /api/admin/streamers/{id}/sync-posts` | admin session | Live. Fetch posts and insights from Meta. |
| `POST /api/admin/streamers/{id}/sync-videos` | admin session | Live. Fetch videos and video insights from Meta. |
| `POST /api/admin/posts/{id}/sync-comments` | admin session | Live. Collect comments; summarises only if they changed. |
| `POST /api/admin/posts/{id}/regenerate-summary` | admin session | Live. Re-analyse the stored comments. |
| `POST /api/admin/videos/{id}/sync-comments` | admin session | Live. Same pipeline, for a video. |
| `POST /api/admin/videos/{id}/regenerate-summary` | admin session | Live. Same pipeline, for a video. |
| `GET /api/posts` | any signed-in | Live. Paginated post list. |
| `GET /api/posts/{id}` | any signed-in | Live. One post with every stored metric. |
| `GET /api/export/posts` | needs `posts.view` | Live. CSV of the current filter selection. |
| `GET /api/export/videos` | needs `videos.view` | Live. CSV of the current filter selection. |
| `GET /api/export/comment-analysis` | needs `analysis.view` | Live. CSV of the analyses, not the comments. |
| `POST /api/automation/sync-all` | `Bearer $N8N_API_SECRET` | Live. Starts a roster sweep, returns a run id. |
| `POST /api/automation/sync-streamer/{id}` | `Bearer $N8N_API_SECRET` | Live. One streamer, synchronously. |
| `GET /api/automation/sync-runs/{id}` | `Bearer $N8N_API_SECRET` | Live. Run status plus every child run. |
| `GET /api/automation/exports/{dataset}` | `Bearer $N8N_API_SECRET` | Live. Seven datasets; `?format=sheets` for tab-shaped rows. |
| `GET /api/automation/google-sheets/schema` | `Bearer $N8N_API_SECRET` | Live. Tab names, columns, matching keys and types. |
| `GET /api/export/sheets/{tab}` | needs `reports.view` | Live. CSV fallback for one spreadsheet tab. |
| `POST /api/n8n/sync` | `Bearer $N8N_API_SECRET` | Retired — `410` naming its replacement. |
| `GET /api/n8n/export` | `Bearer $N8N_API_SECRET` | Retired — `410` naming its replacements. |
| `GET /api/cron/daily-sync` | `Bearer $CRON_SECRET` | Live. Scheduled sweep; skips if one is in flight or too recent. |

The `/api/admin/*` routes authenticate by **session cookie** and require the `admin` role — a
signed-in viewer calling them directly gets `403`, an anonymous caller `401`. They are for the
admin UI and for an operator with a browser session, not for n8n. No response from any of them
contains a Page token: they return `••••••••••••ABCD` and the stored four-character suffix.

Authentication on the machine endpoints is real today so n8n credentials can be configured and
verified now: **`401` means the credential is wrong, `501` means it is correct and the feature is
not built yet.**

---

## Documentation

| Document | Contents |
|----------|----------|
| [`docs/SETUP.md`](./docs/SETUP.md) | Every service set up in order, plus the troubleshooting guide |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Complete system architecture, component map, request paths, technology rationale |
| [`docs/AUTHORIZATION.md`](./docs/AUTHORIZATION.md) | Roles, the four protection layers, sessions, guards, first-admin setup |
| [`docs/PAGE-TOKENS.md`](./docs/PAGE-TOKENS.md) | Token lifecycle, validation, the six health statuses, masking, containment |
| [`docs/SYNC-ENGINE.md`](./docs/SYNC-ENGINE.md) | Graph client, error categories, retry policy, and why missing is never zero |
| [`docs/COMMENT-ANALYSIS.md`](./docs/COMMENT-ANALYSIS.md) | Comment collection, the no-identity guarantee, hash gating, AI provider |
| [`docs/INTERFACE.md`](./docs/INTERFACE.md) | URL-based filters, sort safety, CSV rules, screens, states and accessibility |
| [`docs/N8N-PRODUCTION-WORKFLOW.md`](./docs/N8N-PRODUCTION-WORKFLOW.md) | The production workflow end to end, with error handling and alerting |
| [`docs/N8N-AUTOMATION.md`](./docs/N8N-AUTOMATION.md) | The automation endpoints as built: workflow, node configs, example JSON |
| [`docs/GOOGLE-SHEETS.md`](./docs/GOOGLE-SHEETS.md) | The seven tabs, their columns and keys, branches A–G, and the CSV fallback |
| [`docs/N8N-GOOGLE-SHEETS.md`](./docs/N8N-GOOGLE-SHEETS.md) | Why n8n is kept powerless: credential boundaries and data direction |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | 16 identified risks with controls and the phase each ships in |
| [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md) | The ten migrated tables plus the design for later phases |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phases 1–10 and their exit criteria |

---

## Deployment

```bash
npm run verify
```

typecheck → lint → tests → production build. All four must pass.

Then, in Vercel:

1. Import the repository. Framework preset **Next.js**; leave the build settings alone.
2. Add every variable from `.env.example` for **Production** and **Preview**.
   - `DATABASE_URL` must be the **transaction pooler** (port 6543). The direct connection is
     IPv6-only on new Supabase projects and Vercel functions cannot reach it.
   - `TOKEN_ENCRYPTION_KEY` must be the **same value** that encrypted the tokens already in the
     database. A different key makes every stored token unreadable.
3. Run `npm run db:migrate` against the target project — with `DATABASE_URL` on the **direct**
   connection — before the first deploy.
4. Deploy, then seed an admin for that environment.
5. Check `/api/health` returns `200` and `/settings` reports no missing variables.

`vercel.json` registers the six-hourly cron and pins the function durations a sweep needs (800 s).
Those exceed the Hobby plan's limit — the scheduled sweep needs Pro.

Full walkthrough, including Meta App Review and the n8n workflow:
[`docs/SETUP.md`](./docs/SETUP.md).

---

## Security

The full risk register, with the control for each and the phase it shipped in, is
[`docs/SECURITY.md`](./docs/SECURITY.md). In summary:

| Concern | Control |
|---|---|
| Page tokens at rest | AES-256-GCM, versioned envelope. Decrypted in exactly one function, whose result never leaves the module |
| Page tokens in transit | Never sent to the browser, Google Sheets or n8n. A request carrying one is refused `400` |
| Secrets in the client bundle | `server-only` makes it a build error; `tests/bundle-secrets.test.ts` scans the compiled output |
| Authorisation | Four layers: proxy, page guard, `assertAdmin()` in every action, and RLS |
| Machine callers | Separate bearer secrets for n8n and cron, compared in constant time, rate-limited per endpoint class |
| Login | Throttled per address and per client, six attempts per fifteen minutes |
| XSS | Nonce-based CSP with `strict-dynamic`; every route is dynamically rendered so the nonce always applies |
| SQL injection | Drizzle parameterises; sort keys resolve through an allow-list to column objects, never string interpolation |
| Errors | Sanitised on every outbound path. A Graph error can echo a token in a URL; that never reaches a log n8n can read |
| Deletion | Soft-delete for streamers, with the token destroyed. Destructive actions are confirmed |
| Traceability | `audit_logs` is append-only, enforced by a trigger that holds even for the service role |

**Remaining gaps**, deliberately: no MFA, and no in-app password reset — use the Supabase
dashboard. Rate-limit counters are per process, so on serverless the effective ceiling is
`limit × instances`; they bound a runaway workflow rather than a distributed attacker.

If you believe you have found a vulnerability, do not open a public issue — contact the CBSOFT
engineering lead directly.

## Documentation map

The specification for this project named documents in lower case. This
repository uses upper case throughout, and on Windows and macOS the two are the
same file — `docs/rollback.md` and `docs/ROLLBACK.md` cannot coexist. The
repository convention won; this table maps one to the other.

| Asked for | In this repository | Covers |
| --- | --- | --- |
| `vercel-deployment.md` | [VERCEL-DEPLOYMENT.md](docs/VERCEL-DEPLOYMENT.md) | Project settings, env vars, deploying, cron |
| `supabase-production.md` | [SUPABASE-PRODUCTION.md](docs/SUPABASE-PRODUCTION.md) | Connection, migrations, auth, first admin, backups |
| `meta-api-setup.md` | [META-API-SETUP.md](docs/META-API-SETUP.md) | App config, Page permissions, tokens, Meta's limits |
| `anthropic-setup.md` | [ANTHROPIC-SETUP.md](docs/ANTHROPIC-SETUP.md) | Enabling AI summaries, cost, failure behaviour |
| `n8n-production-workflow.md` | [N8N-PRODUCTION-WORKFLOW.md](docs/N8N-PRODUCTION-WORKFLOW.md) | The production workflow, node by node |
| `google-sheets-setup.md` | [GOOGLE-SHEETS.md](docs/GOOGLE-SHEETS.md) + [N8N-GOOGLE-SHEETS.md](docs/N8N-GOOGLE-SHEETS.md) | Tab layout, match columns, upsert wiring |
| `security-and-secret-rotation.md` | [SECURITY-AND-SECRET-ROTATION.md](docs/SECURITY-AND-SECRET-ROTATION.md) | Where secrets live, rotation index |
| `production-troubleshooting.md` | [PRODUCTION-TROUBLESHOOTING.md](docs/PRODUCTION-TROUBLESHOOTING.md) | Symptom-first diagnosis |
| `rollback.md` | [ROLLBACK.md](docs/ROLLBACK.md) | Deployment, database, n8n, tokens, every rotation |

Also present, from earlier phases: [ARCHITECTURE.md](docs/ARCHITECTURE.md),
[AUTHORIZATION.md](docs/AUTHORIZATION.md), [DATA-MODEL.md](docs/DATA-MODEL.md),
[SECURITY.md](docs/SECURITY.md), [SETUP.md](docs/SETUP.md),
[ENVIRONMENTS.md](docs/ENVIRONMENTS.md), [SYNC-ENGINE.md](docs/SYNC-ENGINE.md),
[PAGE-TOKENS.md](docs/PAGE-TOKENS.md),
[COMMENT-ANALYSIS.md](docs/COMMENT-ANALYSIS.md),
[INTERFACE.md](docs/INTERFACE.md), [N8N-AUTOMATION.md](docs/N8N-AUTOMATION.md).
