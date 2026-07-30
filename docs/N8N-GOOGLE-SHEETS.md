# n8n and Google Sheets Integration Architecture

How scheduled automation and business reporting work, and why n8n is deliberately kept powerless.

> **This document is the *why*.** For the endpoints as built — request and response shapes, node
> configurations, the polling workflow — see [`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md).
>
> The paths below are the Phase 1 sketch. Phase 8 replaced `POST /api/n8n/sync` with
> `POST /api/automation/sync-all` plus a polling endpoint, and the single `GET /api/n8n/export`
> with seven per-dataset exports. The architecture is unchanged; only the surface is.

---

## 1. The governing idea

n8n is a **scheduler and a transport**. It is not a data processor and it holds no privileged
access.

- n8n has **no** Postgres connection string.
- n8n has **no** Supabase service-role key.
- n8n has **no** Meta app credentials and **never** sees a Facebook Page token.
- n8n has exactly two things: a bearer secret for this application, and its own Google credential.

Everything n8n needs, it asks the application for. Every Meta Graph call and every database write
happens inside the Next.js server runtime. This is what makes architecture rules 3, 5 and 6
structural rather than aspirational — if n8n were fully compromised, the blast radius is "an
attacker can trigger a sync and read the same report rows a manager can read".

---

## 2. Direction of data

```
                    (1) trigger                (2) work happens here
  ┌────────┐  POST /api/n8n/sync   ┌──────────────────┐   ┌────────────────┐
  │  n8n   │ ────────────────────► │   Next.js API    │──►│  Meta Graph    │
  │        │ ◄──────────────────── │   (Vercel)       │   │  (Pages only)  │
  └────────┘   {counts, errors}    └────────┬─────────┘   └────────────────┘
       │                                    │ upsert
       │  (3) pull scrubbed rows            ▼
       │  GET /api/n8n/export      ┌──────────────────┐
       ├──────────────────────────►│ Supabase Postgres│
       │                           └──────────────────┘
       │  (4) append
       ▼
  ┌────────────────┐
  │ Google Sheets  │   append-only, never read back
  └────────────────┘
```

Data flows **out** to Sheets and never back in. No workflow, script or human edit in a spreadsheet
can change what the application believes. If a Sheet and the database disagree, the database is
right and the Sheet is stale.

---

## 3. Endpoint contracts

All machine endpoints use `Authorization: Bearer <secret>`, compared in constant time
(`src/lib/security/machine-auth.ts`). Responses are `cache-control: no-store`.

Two separate secrets, so either can be rotated independently and an n8n compromise cannot drive the
scheduler:

| Endpoint | Caller | Secret | Phase |
|----------|--------|--------|-------|
| `GET /api/health` | anyone | none (public, no secrets in body) | 1 ✅ |
| `POST /api/n8n/sync` | n8n | `N8N_API_SECRET` | 5 |
| `GET /api/n8n/export` | n8n | `N8N_API_SECRET` | 8 |
| `GET /api/cron/daily-sync` | Vercel Cron | `CRON_SECRET` | 5 |

In Phase 1 the `/api/n8n/*` and `/api/cron/*` routes **authenticate for real** and then return
`501 Not Implemented`. That is intentional: the n8n credential can be configured and verified now.
A `401` means the workflow credential is wrong; a `501` means it is correct and the feature is not
built yet.

### 3.1 `POST /api/n8n/sync` (Phase 5)

```jsonc
// request
{
  "scope": "all",                 // "all" | "streamer" | "page"
  "streamerId": null,             // required when scope = "streamer"
  "pageId": null,                 // required when scope = "page"
  "since": "2026-07-01",          // optional backfill window start
  "reason": "nightly"             // free-text, recorded on the sync_runs row
}

// response 200
{
  "runId": "…uuid…",
  "startedAt": "2026-07-29T02:00:00.000Z",
  "pagesProcessed": 12,
  "streamsIngested": 47,
  "failures": [{ "pageId": "…", "reason": "token_expired" }]
}
```

Note what is absent: no token, no Graph response passthrough, no internal user id.

### 3.2 `GET /api/n8n/export` (Phase 8)

Query: `dataset=streamer_performance|stream_log`, `period_start=YYYY-MM-DD`,
`period_end=YYYY-MM-DD`.

Returns the `ExportEnvelope` defined in `src/lib/google-sheets/export-contract.ts`:

```jsonc
{
  "dataset": "streamer_performance",
  "period_start": "2026-07-01",
  "period_end": "2026-07-31",
  "generated_at": "2026-08-01T03:00:00.000Z",
  "row_count": 12,
  "columns": ["period_start", "period_end", "streamer_name", "…"],
  "rows": [{ "period_start": "2026-07-01", "…": "…" }]
}
```

`columns` is authoritative and fixed. n8n must append in that order — Sheets has no schema, so
column order is the schema. Gated by `GOOGLE_SHEETS_EXPORT_ENABLED`.

**Why the contract lives in the app, not in n8n:** the export schema is the enforcement point for
rule 5. Because `StreamerPerformanceRow` and `StreamLogRow` have no field capable of holding a
token, no amount of workflow editing in n8n can cause one to be exported.

---

## 4. Workflows

### 4.1 Nightly sync

```
Schedule Trigger (02:00 workspace TZ)
  → HTTP Request  GET  /api/health          (pre-flight; abort if misconfigured)
  → HTTP Request  POST /api/n8n/sync        { scope: "all", reason: "nightly" }
  → IF failures.length > 0
        → Slack / email alert with pageId + reason (never token material)
```

### 4.2 Weekly Sheets export

```
Schedule Trigger (Mon 06:00)
  → HTTP Request  GET /api/n8n/export?dataset=streamer_performance&period_start=…&period_end=…
  → Split Out     rows
  → Google Sheets  Append   (sheet: "Streamer Performance")
  → Google Sheets  Append   (sheet: "Export Log": dataset, period, row_count, generated_at)
```

### 4.3 On-demand export

Triggered from the Reports screen (Phase 8). The app calls the n8n **webhook**, n8n calls back to
`/api/n8n/export`. The app→n8n direction carries only a dataset key and a period — never rows and
never credentials.

### 4.4 Token-expiry watch

```
Schedule Trigger (daily 08:00)
  → HTTP Request  GET /api/n8n/pages/health     (Phase 5)
  → Filter        status != "connected"
  → Notify admins: "Page <name> needs reconnection"
```

Reports Page *names* and statuses. Never a token, never a token fragment.

---

## 5. Google Sheets layout

One spreadsheet, three tabs. Header rows match `columns` exactly.

**Tab: Streamer Performance** — one row per streamer per period.

`period_start · period_end · streamer_name · facebook_page_name · facebook_page_id ·
streams_count · total_minutes_streamed · total_views · peak_concurrent_viewers ·
average_watch_time_seconds · new_followers · reactions · comments · shares · engagement_rate ·
synced_at`

**Tab: Stream Log** — one row per broadcast.

`stream_id · streamer_name · facebook_page_name · title · started_at · ended_at ·
duration_seconds · peak_concurrent_viewers · total_views · reactions · comments · permalink`

**Tab: Export Log** — audit trail of what was written.

`dataset · period_start · period_end · row_count · generated_at · triggered_by`

Conventions:

- Append-only. Re-running a period appends a new block; it never edits history.
- Pivot tables and charts live in a **separate** spreadsheet that references these tabs, so a
  layout change by a business user cannot break the automation.
- `facebook_page_id` is included because it is a public identifier and makes rows joinable. No
  internal database UUIDs are exported.

---

## 6. Credentials

| Credential | Held by | Notes |
|------------|---------|-------|
| `N8N_API_SECRET` | n8n (Header Auth credential), Vercel env | ≥32 chars. Rotate by adding the new value, redeploying, updating n8n, removing the old. |
| `CRON_SECRET` | Vercel only | Vercel Cron sends it automatically as a bearer token. |
| Google Service Account | n8n only | Sheets scope only. The application never holds it. |
| Supabase / Meta / encryption keys | Vercel only | **Never** configured in n8n. |

If n8n is self-hosted, it must reach the app over HTTPS on the public deployment URL. There is no
need for it to reach Supabase or Meta at all — network-level egress rules should reflect that.

---

## 7. Failure handling

| Failure | Behaviour |
|---------|-----------|
| App is misconfigured | `/api/health` returns 503 with missing key **names**; the workflow aborts before calling sync. |
| Bearer secret wrong | `401`. n8n alerts; no retry (retrying a bad credential is just a lockout risk). |
| Feature not built | `501` with `{ error: "not_implemented", phase }`. Expected during Phases 1–7. |
| Meta rate limit | The app returns partial success with per-Page failure reasons; n8n retries with backoff. |
| Page token expired | Reported as `failures[].reason = "token_expired"`. Resolution is a human reconnecting the Page in Admin — never an automated token operation. |
| Sheets append fails | n8n retries; the Export Log row is written only after a successful append. |

---

## 8. What is explicitly out of scope for n8n

- Reading or writing Supabase directly.
- Calling the Meta Graph API.
- Storing, forwarding or logging any Page token.
- Being a source of truth for anything.

Any future workflow that appears to need one of these is a signal that the capability belongs in
the application behind a new authenticated endpoint — not in n8n.
