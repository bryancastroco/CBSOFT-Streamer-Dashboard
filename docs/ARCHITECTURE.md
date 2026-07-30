# System Architecture

CBSOFT Streamer Performance Dashboard — complete target architecture. Phase 1 has built the
foundation described in [§10](#10-phase-map); everything else is design intent.

---

## 1. Purpose

CBSOFT works with streamers who broadcast on **Facebook Pages**. The dashboard answers, per
streamer and per period:

- How much did they stream, and when?
- How many people watched, for how long, and at what peak concurrency?
- How did the audience engage — reactions, comments, shares, follower growth?
- What is the audience actually saying? (AI comment summaries — delivered in Phase 5 for posts and
  Phase 6 for videos)

Managers read this in the app. Finance and leadership read it in Google Sheets.

---

## 2. Non-negotiable architecture rules

These are enforced by structure, not by convention. Each has a mechanism.

| # | Rule | Enforcing mechanism |
|---|------|---------------------|
| 1 | Supabase PostgreSQL is the primary database | All reads/writes go through Drizzle (`src/lib/db`) or the Supabase client. No other datastore is authoritative. |
| 2 | Google Sheets is a reporting/export destination, not the database | Nothing in the codebase reads from Sheets. There is no Sheets client dependency at all. |
| 3 | n8n calls secure app API endpoints to trigger sync and pull export data | `/api/n8n/*`, bearer-authenticated with `N8N_API_SECRET`. n8n holds no database credentials. |
| 4 | Facebook Page tokens stay encrypted in the database | AES-256-GCM via `src/lib/crypto/tokens.ts`; the column stores ciphertext only. |
| 5 | Page tokens never reach browser, Sheets, or n8n | Token code is `server-only`; export schemas (`export-contract.ts`) have no field that can carry one; RLS denies the column to every client role. |
| 6 | All Meta Graph calls happen on the server | No Facebook JS SDK dependency. `src/lib/meta/*` is `server-only`, so importing it from a Client Component fails the build. |
| 7 | Only Facebook Pages — never personal profiles | Connection flow reads the `me/accounts` edge, which returns Pages only, and re-validates each node before persisting. |

---

## 3. Component map

```
┌──────────────┐         ┌───────────────────────────────────────┐
│   Browser    │◄────────│  Next.js on Vercel                    │
│  (React 19)  │  RSC /  │                                       │
└──────────────┘  JSON   │  ├─ (auth)  login                     │
                         │  ├─ (app)   dashboard, streamers,     │
                         │  │           reports, admin, settings │
                         │  └─ /api    health, n8n/*, cron/*     │
                         └───────┬─────────────┬─────────────────┘
                                 │             │
              service role /     │             │  server-side only,
              RLS-scoped queries │             │  decrypted token in memory
                                 ▼             ▼
                    ┌────────────────────┐   ┌──────────────────┐
                    │ Supabase Postgres  │   │  Meta Graph API  │
                    │  + Supabase Auth   │   │  (Pages only)    │
                    └────────────────────┘   └──────────────────┘
                                 ▲
                                 │  never direct — always via the API
                    ┌────────────┴───────┐
                    │        n8n         │──────► Google Sheets
                    │  (scheduler /      │        (append-only
                    │   transport only)  │         reporting)
                    └────────────────────┘
```

**The critical property:** n8n has no line to Postgres and no line to Meta. It can only ask the
application to do things. That single constraint is what makes rules 3, 5 and 6 hold.

---

## 4. Technology choices

| Concern | Choice | Why |
|---------|--------|-----|
| Framework | Next.js App Router (16.x) | Server Components keep secrets and Graph calls on the server by default. |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Metric aggregation is arithmetic over optional data; unchecked index access is exactly the bug class to eliminate. |
| Styling | Tailwind CSS v4 + shadcn/ui | Owned, vendored components — no runtime UI dependency to version-chase. |
| Database | Supabase PostgreSQL | Managed Postgres, RLS, and Auth from one vendor. |
| ORM | **Drizzle** | No query-engine binary, so cold starts stay low on Vercel functions; schema is plain TypeScript, so `strict` mode covers the data layer. Prisma was the alternative — rejected on serverless cold-start and bundle weight. |
| Auth | Supabase Auth (`@supabase/ssr`) | Cookie-based sessions that work in Server Components, middleware and Route Handlers. |
| Validation | Zod v4 | One schema serves env parsing, API input and export output. |
| Charts | Recharts | Composable, SSR-friendly, no license friction. |
| AI | Anthropic API (Claude) | Comment summarisation, live since Phase 5. Server-side only. |
| Automation | n8n | Scheduling and Sheets transport, with no privileged access. |
| Reporting | Google Sheets | Where the business already works. Destination only. |
| Hosting | Vercel | Native App Router support; Cron for scheduled jobs. |

---

## 5. Request paths

### 5.1 A user opens the dashboard

1. `src/proxy.ts` refreshes the Supabase session cookie and applies the route policy.
2. The `(app)` layout calls `requireUser()`, which revalidates the JWT and loads the profile row.
3. The Server Component builds a Supabase client bound to the user's session; queries run under RLS.
4. Aggregates are computed server-side and passed to Client Components as plain props.
5. No token, no service-role key and no raw Graph response is ever serialised into the payload.

Full detail of the authorization layering: [`AUTHORIZATION.md`](./AUTHORIZATION.md).

### 5.2 A scheduled sync

1. n8n (or Vercel Cron) → `POST /api/n8n/sync` with `Authorization: Bearer <N8N_API_SECRET>`.
2. The route authenticates the caller in constant time, then enqueues/executes a run.
3. For each connected Page: read the ciphertext, decrypt in memory, call Meta Graph, discard.
4. Normalised metrics are upserted into Postgres.
5. The response reports counts and failures. **No token material, ever.**

### 5.3 A Google Sheets export

1. n8n → `GET /api/n8n/export?dataset=…&period_start=…&period_end=…`, same bearer scheme.
2. The app queries Postgres and serialises rows against `export-contract.ts`.
3. n8n's Google Sheets node appends the rows using its own Google credential.
4. The app never holds a Google credential. Sheets access is entirely n8n's concern.

---

## 6. Security boundaries

Three concentric zones:

**Public zone** — the browser. May hold `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
and a user session JWT. Everything it can reach is RLS-filtered, and `encrypted_page_token` is
denied to it by column-level grant regardless of role.

**Application zone** — Next.js server runtime. Holds the service-role key, the Meta app secret, the
token encryption key and the machine secrets. This is the only zone where a plaintext Page token
exists, and only transiently, inside a single function call.

**Machine zone** — n8n and Vercel Cron. Holds one bearer secret each and a Google credential.
Deliberately the least privileged: it can trigger work and receive scrubbed rows, nothing else.

Full threat analysis: [`SECURITY.md`](./SECURITY.md).

---

## 7. Directory layout

```
src/
  app/
    (auth)/login/            Sign-in (Supabase Auth)
    (app)/                   Authenticated shell: header + sidebar
      dashboard/  streamers/  posts/  videos/  reports/  admin/  settings/
    api/
      health/                Public liveness + config check
      admin/                 Session-authenticated admin operations
      posts/                 Read-only post queries
      n8n/sync/              n8n-triggered synchronisation   (deferred)
      n8n/export/            n8n export payloads for Sheets  (deferred)
      cron/daily-sync/       Vercel Cron scheduled refresh   (deferred)
    layout.tsx  page.tsx  not-found.tsx  globals.css
  components/
    ui/                      shadcn/ui primitives (vendored)
    layout/                  Shell, sidebar, page header, phase notice
  config/
    env.ts                   server-only Zod env contract
    public-env.ts            the ONLY browser-visible env values
    navigation.ts  site.ts
  lib/
    supabase/                client (browser) / server (RLS) / admin (service role)
    db/                      Drizzle client + schema
    crypto/                  AES-256-GCM Page-token encryption   [server-only]
    security/                Bearer auth for n8n and cron        [server-only]
    meta/                    Graph API access                    [server-only]
    services/                Sync orchestration                  [server-only]
    repositories/            Data access                         [server-only]
    comments/                Content refs + deterministic hashing
    ai/                      Anthropic summaries                 [server-only]
    google-sheets/           Export row/column contract          [server-only]
    api/                     Shared Route Handler responses
  types/
docs/                        This documentation set
drizzle/                     Generated SQL migrations
```

The `server-only` marker is load-bearing: those modules throw at build time if imported into a
Client Component, which is how rules 5 and 6 survive future refactors.

---

## 8. Data model

Table-by-table design, including RLS posture and the token column: [`DATA-MODEL.md`](./DATA-MODEL.md).

---

## 9. Automation and reporting

n8n workflows, endpoint contracts, sheet layouts and credential handling:
[`N8N-GOOGLE-SHEETS.md`](./N8N-GOOGLE-SHEETS.md).

---

## 10. Phase map

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | **Project foundation, tooling, structure, docs, placeholders** | **Done** |
| **2** | **Supabase Auth, roles, RLS, route protection, user management, audit trail** | **Done** |
| **3** | **Streamer management, encrypted Page tokens, token validation and health** | **Done** |
| **4** | **Graph client, post + insight synchronization, post screens** | **Done** |
| **5** | **Comment collection and AI summarisation** | **Done** |
| 4 | Meta OAuth (Pages only), encrypted token storage, connection health | |
| 5 | Sync engine, job records, Vercel Cron + `/api/n8n/sync` | |
| 6 | Dashboard analytics and Recharts visualisations | |
| 7 | Comment ingestion and Anthropic summaries | |
| 8 | Report builder and `/api/n8n/export` → Google Sheets | |
| 9 | Audit log, workspace settings, alerting | |
| 10 | Hardening, performance, production rollout | |

See [`ROADMAP.md`](./ROADMAP.md) for the detail of each.
