# n8n Automation

How the nightly workflow works, what every endpoint expects, and why the
architecture is shaped this way. Implemented in Phase 8.

---

## 1. The rule that shapes everything

**n8n never receives a Facebook Page token.**

n8n asks this application to do work. The application decrypts the Page token
server-side, calls the Meta Graph API itself, stores the results, and hands n8n
back normalised rows. The credential never crosses the boundary in either
direction.

That is not a convention — it is enforced in three places:

| Direction | Mechanism |
|---|---|
| **Outbound** | Every export column is declared one at a time in `src/lib/google-sheets/export-contract.ts`. No schema there has a field capable of holding a token, and `tests/automation-exports.test.ts` asserts the exact column list of all seven datasets. |
| **Outbound** | Meta error payloads are reduced to `{category, code, subcode, message}` and the message is scrubbed. A Graph error can echo back the request that caused it — and a Graph request carries the access token in its query string. |
| **Inbound** | Request bodies are screened. A field named `access_token`, or a value shaped like one, is refused with `400 token_material_refused`. See §6. |

n8n is the least privileged actor in the system. It holds one bearer secret and
a Google credential, and nothing else.

---

## 2. The workflow

```
Schedule Trigger  (cron, e.g. 03:00 daily)
        │
        ▼
HTTP Request      POST /api/automation/sync-all
        │         → 202 { sync_run_id, poll_url }
        ▼
Set               Save Sync Run ID
        │
        ▼
Wait              60 seconds
        │
        ▼
HTTP Request      GET /api/automation/sync-runs/{{ $json.sync_run_id }}
        │
        ▼
If                {{ $json.finished }} === true
        │  false → back to Wait
        │  true
        ▼
HTTP Request ×7   GET /api/automation/exports/…?updated_after=…
        │         (loop while has_more)
        ▼
Google Sheets     Append or Update, keyed on key_column
        │
        ▼
HTTP Request      GET /api/automation/exports/sync-logs
        │
        ▼
Google Sheets     Record automation result
```

### Why it polls instead of waiting on the response

A sweep of a real roster takes minutes: every active Page, its posts and videos,
their insights, and comment analysis for the recent ones. Holding an HTTP
connection open for that long means the request times out somewhere nobody
controls — an n8n node default, a proxy, a platform limit — and n8n retries,
starting a **second** sweep against the same Pages, doubling the Meta quota
spend and racing the first one.

So `sync-all` returns a run id in about a second and the work continues in the
background. Polling makes the duration irrelevant.

> For a small roster or a by-hand check of a new deployment, post
> `{"mode": "wait"}` and get the whole result in the response. Do not use it on
> a schedule.

---

## 3. Authentication

Every `/api/automation/*` endpoint requires `N8N_API_SECRET` as a bearer token:

```
Authorization: Bearer <N8N_API_SECRET>
```

- The secret is compared in **constant time**, so a wrong guess takes the same
  time to reject however many leading characters are right.
- A missing and an invalid secret both return the same `401` body. Telling an
  unauthenticated caller which one it was is free reconnaissance.
- Session cookies do nothing here, and these routes are marked `machine` in the
  route policy so the session layer skips them entirely — a redirect to `/login`
  is a useless answer to give a workflow, and n8n would read the `307` as
  success.

### Configuring the credential in n8n

Create one **Header Auth** credential and reuse it on every node:

| Field | Value |
|---|---|
| Credential type | Header Auth |
| Name | `CBSOFT Automation` |
| Header Name | `Authorization` |
| Header Value | `Bearer <your N8N_API_SECRET>` |

Rotating the secret is a two-step change: set the new value in the deployment's
environment, then update this credential. There is a window between the two
where the workflow gets `401`; schedule it outside the sync window.

---

## 4. Rate limits

| Endpoint class | Budget |
|---|---|
| Writes — `sync-all`, `sync-streamer/{id}` | 10 per minute |
| Reads — `sync-runs/{id}`, all exports | 120 per minute |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`. A denial is `429` with `Retry-After` in seconds.

The limiter exists to stop a **runaway schedule** — a workflow set to every
minute instead of every night — and an accidental retry storm. It is not a
defence against a distributed attacker, and on a serverless platform the
counters are per instance. The security boundary is the bearer secret.

In n8n, set the HTTP Request node's **Retry On Fail** to on with a 5-second
delay; that handles a `429` from a polling loop without any extra branching.

---

## 5. Endpoints

### `POST /api/automation/sync-all`

Starts a sweep of every streamer that is active, not deleted, and has a stored
Page token.

**Body** — all fields optional:

| Field | Default | Meaning |
|---|---|---|
| `mode` | `async` | `async` returns a run id; `wait` blocks and returns the result |
| `since` | — | ISO 8601. Only collect content published after this instant |
| `max_pages` | 5 | Graph pages per content edge, per streamer |
| `concurrency` | 4 | Parallel insight fetches |
| `max_posts_for_comments` | 10 | Newest posts per streamer whose comments are refreshed |
| `max_videos_for_comments` | 10 | Newest videos per streamer whose comments are refreshed |
| `skip_comments` | `false` | Skip comment collection and analysis entirely |
| `skip_token_validation` | `false` | Skip the per-streamer Graph token check |

> **Why comments are capped.** Comment collection is the expensive half: each
> item is a paginated Graph walk, and each *changed* set is an Anthropic call.
> Engagement on a Facebook post is heavily front-loaded, so the newest items are
> where comments actually change — and the source-hash gate means an unchanged
> set costs a fetch and no AI call at all. Walking a Page's whole history nightly
> would spend both budgets on content nobody is commenting on.

**What it does, per streamer, in order:** validate the token → posts → post
insights → post comments → changed summaries → videos → video insights → video
comments → changed summaries. Insights come back on a per-item Graph edge, so
they are collected inside the post and video passes rather than as a separate
sweep.

**One streamer failing does not end the run.** An expired token, a rate-limited
Page, a Page deleted out from under us — each costs exactly that streamer's
results and is recorded against it. The sweep finishes `partial`. It only
reports `failed` when *nothing* worked; a sweep where nine of ten Pages synced
is a partial success, and calling that a failure would train an operator to
ignore the status field.

A streamer whose token is `missing`, `expired`, `invalid` or
`missing_permission` is **skipped**, not failed. Nothing is broken — the
credential needs replacing, and spending Graph quota on a call that cannot
succeed helps nobody.

### `POST /api/automation/sync-streamer/{id}`

One streamer, synchronously. Same eleven steps, same body fields except `mode`.
A single Page fits comfortably in one invocation, and a workflow retrying one
Page wants the answer rather than another id to poll.

Returns `422 token_unusable` when the Page token needs replacing — actionable,
not a transient error to retry.

### `GET /api/automation/sync-runs/{id}`

The state of one run and of every per-streamer run it spawned.

Read **`finished`**. It is derived from the parent's own status, and the parent
is closed last, so there is no window where it looks complete while a child is
still working.

### `GET /api/automation/google-sheets/schema`

The spreadsheet layout as JSON: tab names, required column headers in order, the
unique matching column per tab, and a data type per column. Structure only — no
data, and no Google credential to describe, because n8n owns that.

Use it to build the tabs, to configure a branch's "Column to Match On", or to
detect drift by comparing a live header row against `required_columns`. See
[`GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md).

### `GET /api/automation/exports/{dataset}`

Seven datasets: `streamers`, `posts`, `post-insights`, `videos`,
`video-insights`, `comment-summaries`, `sync-logs`.

Every one accepts the same parameters:

| Parameter | Meaning |
|---|---|
| `updated_after` | ISO 8601. Rows whose watermark is **strictly greater**. The incremental checkpoint |
| `from`, `to` | Inclusive content-date window. Accepts `YYYY-MM-DD` (read as midnight UTC) |
| `streamer_id` | UUID |
| `limit` | 1–1000, default 500 |
| `offset` | Page offset |
| `format` | `json` (default) or `sheets` — see below |

`format=sheets` returns each row already keyed by its spreadsheet column
headers, in tab order, so n8n's Google Sheets node can Map Automatically with no
transform node in between. It is strictly a projection of the JSON fields: a
subset, renamed and reordered, so it cannot expose anything the default format
does not. [`GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md) has the tab definitions.

> **Checkpoint from `max_watermark`, never from a row.**
>
> `max_watermark` is microsecond-precise — `2026-07-30T01:12:50.921120Z` — because
> that is the precision Postgres stores. The per-row timestamp columns are
> millisecond-precise, because they are rendered from a JavaScript `Date`, which
> cannot hold more.
>
> Checkpointing from a row column therefore sends a value up to 999 microseconds
> *earlier* than the row it came from, and the boundary rows come back next run.
> That is not merely a duplicate: a bulk upsert stamps every row it writes with
> one transaction timestamp, so the boundary is usually the whole batch, and the
> incremental filter stops saving you anything.
>
> `max_watermark` covers the entire filtered set, not just the page, so you can
> read it from the first response and use it after paging to the end.

**Bad input is rejected, not corrected.** A `400` names the offending field.
Unlike the browser-facing filters, a scheduled workflow silently handed the
wrong window would write wrong rows into a spreadsheet every night and nobody
would notice until the numbers were questioned.

---

## 6. What these endpoints refuse

A request body carrying credential material is refused before anything happens:

```json
{
  "ok": false,
  "error": "token_material_refused",
  "message": "This endpoint never accepts Facebook Page tokens or other credentials. …",
  "fields": [
    { "path": "access_token", "reason": "This field name is reserved for credentials, …" }
  ]
}
```

Two independent signals, because either alone misses cases:

1. **A suspicious key** at any depth — `access_token`, `page_token`,
   `client_secret`, a bare `token` or `secret`, and so on.
2. **A suspicious value** — a Meta token (`EAA…`), this application's own
   `v1.<iv>.<tag>.<ciphertext>` envelope, or a JWT. Catches a token smuggled
   under an innocent key like `note`.

The path is returned so the workflow can be fixed. **The value never is.**

Why bother, when n8n has no reason to hold a token? Because "n8n does not have
one" is a property of how n8n is configured, and configurations drift. Somebody
debugging a Graph call pastes a token into a workflow parameter, the workflow
posts it here, and now a credential that was only ever supposed to exist as
ciphertext in one database column is sitting in an n8n execution log, a proxy
log and this application's request log. Rejecting it at the door makes that
mistake loud and immediate instead of silent and permanent.

Legitimate metadata is not affected: `token_status`, `tokens_used` and
`has_token` all pass.

---

## 7. n8n node configurations

### Node 1 — Schedule Trigger

| Field | Value |
|---|---|
| Trigger Rule | Cron |
| Cron Expression | `0 3 * * *` |
| Timezone | your reporting timezone |

The automation surface works entirely in UTC — `from`/`to` are read as midnight
UTC and every timestamp is emitted with a `Z`. The trigger's timezone only
decides when the sweep starts. (The dashboard *displays* GMT+8, which is a
presentation choice and does not reach these endpoints.)

### Node 2 — HTTP Request: start the sweep

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://<your-app>/api/automation/sync-all` |
| Authentication | Generic Credential Type → Header Auth → `CBSOFT Automation` |
| Send Body | on |
| Body Content Type | JSON |
| Specify Body | Using JSON |
| JSON | `{ "mode": "async", "max_posts_for_comments": 10 }` |
| Options → Timeout | `30000` |
| Options → Response → Never Error | **off** |
| Settings → Retry On Fail | on, 3 tries, 5000 ms |

`202` is a success status. If your n8n version treats non-`2xx` as failure only,
no change is needed; if you have configured an explicit success list, include
`202`.

### Node 3 — Set: save the run id

| Field | Value |
|---|---|
| Mode | Manual Mapping |
| Field name | `sync_run_id` |
| Type | String |
| Value | `={{ $json.sync_run_id }}` |
| Include Other Fields | off |

Pinning the id in its own node means later nodes reference `$('Save Sync Run
ID').item.json.sync_run_id` rather than reaching back through whatever the last
node happened to output.

### Node 4 — Wait

| Field | Value |
|---|---|
| Resume | After Time Interval |
| Wait Amount | `60` |
| Wait Unit | Seconds |

60 seconds is a reasonable first poll for a roster of a dozen Pages. The read
budget is 120/minute, so even a 5-second loop stays inside it — but a slower
loop costs nothing and keeps the execution log readable.

### Node 5 — HTTP Request: poll the run

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `=https://<your-app>/api/automation/sync-runs/{{ $('Save Sync Run ID').item.json.sync_run_id }}` |
| Authentication | Header Auth → `CBSOFT Automation` |
| Options → Timeout | `15000` |
| Settings → Retry On Fail | on, 3 tries, 5000 ms |

### Node 6 — If: has it finished?

| Field | Value |
|---|---|
| Condition type | Boolean → is true |
| Value 1 | `={{ $json.finished }}` |

Route **false** back to the Wait node and **true** onward.

> Give the loop a ceiling. Add a Set node before the Wait that increments an
> attempt counter and an If that fails the execution past, say, 30 attempts. A
> polling loop with no bound is how a stuck run becomes a workflow that never
> ends.

### Node 7 — HTTP Request: read an export

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `https://<your-app>/api/automation/exports/posts` |
| Authentication | Header Auth → `CBSOFT Automation` |
| Send Query Parameters | on |
| Query — `updated_after` | `={{ $('Read Checkpoint').item.json.posts_watermark }}` |
| Query — `limit` | `500` |
| Query — `offset` | `={{ $json.pagination ? $json.pagination.next_offset : 0 }}` |
| Options → Timeout | `60000` |
| Settings → Retry On Fail | on, 3 tries, 5000 ms |

Duplicate this node per dataset, changing only the path. Every envelope has the
same shape, so the downstream nodes do not change.

**Paginating.** Loop back into this node while `{{ $json.pagination.has_more }}`
is true, passing `next_offset`. When it is false, move on.

**Checkpointing.** Store `max_watermark` somewhere durable — an n8n static-data
node, or a cell in the sheet — and feed it back as `updated_after` next run. The
filter is strictly greater than, and the value is microsecond-precise, so nothing
already delivered comes back. Take it from `max_watermark`, not from a row: see
the note in §5.

On the very first run, omit `updated_after` entirely to backfill.

### Node 8 — Google Sheets: upsert

| Field | Value |
|---|---|
| Resource | Sheet Within Document |
| Operation | **Append or Update Row** |
| Document | your spreadsheet |
| Sheet | one tab per dataset |
| Mapping Column Mode | Map Automatically |
| Column to Match On | the envelope's `key_column` |

The envelope tells you which column to match on: `facebook_post_id` for posts,
`summary_id` for comment summaries, and so on. Use **Append or Update**, not
Append — a re-sync updates a post's counts in place, and plain Append would
accumulate a new row every night for every post.

Write the header row from `columns`, in that order. Sheets is positional.

### Node 9 — Google Sheets: record the automation result

Point a final HTTP Request node at
`/api/automation/exports/sync-logs?updated_after=…` and append to an
"Automation Log" tab. That tab answers "did last night run, and what did it
do?" without opening n8n.

---

## 8. Example request and response

### Start a sweep

```http
POST /api/automation/sync-all HTTP/1.1
Host: dashboard.example.com
Authorization: Bearer <N8N_API_SECRET>
Content-Type: application/json

{ "mode": "async", "max_posts_for_comments": 10 }
```

```json
{
  "ok": true,
  "sync_run_id": "0f1e2d3c-4b5a-4968-8776-655443322110",
  "mode": "async",
  "status": "running",
  "finished": false,
  "poll_url": "/api/automation/sync-runs/0f1e2d3c-4b5a-4968-8776-655443322110",
  "defaults_applied": {
    "max_pages": 5,
    "concurrency": 4,
    "max_posts_for_comments": 10,
    "max_videos_for_comments": 10
  },
  "message": "The sweep is running. Poll poll_url until finished is true, then read the exports."
}
```

Status `202 Accepted`.

### Poll the run — still working

```json
{
  "ok": true,
  "sync_run_id": "0f1e2d3c-4b5a-4968-8776-655443322110",
  "status": "running",
  "finished": false,
  "sync_type": "automation",
  "streamer_id": null,
  "streamer_code": null,
  "started_at": "2026-07-30T03:00:04.120Z",
  "completed_at": null,
  "duration_seconds": null,
  "error_message": null,
  "totals": { "posts_processed": 0, "videos_processed": 0, "comments_processed": 0, "summaries_generated": 0 },
  "child_totals": { "posts_processed": 34, "videos_processed": 6, "comments_processed": 210, "summaries_generated": 4 },
  "child_run_count": 4,
  "children": [
    {
      "sync_run_id": "aa11bb22-cc33-4d44-8e55-ff6677889900",
      "streamer_id": "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
      "streamer_code": "CBS-014",
      "sync_type": "automation",
      "status": "succeeded",
      "posts_processed": 21,
      "videos_processed": 0,
      "comments_processed": 0,
      "summaries_generated": 0,
      "started_at": "2026-07-30T03:00:05.001Z",
      "completed_at": "2026-07-30T03:00:41.900Z",
      "error_message": null
    }
  ],
  "streamers": null
}
```

The parent's own `totals` stay at zero until it is closed; `child_totals` is the
running figure.

### Poll the run — finished

```json
{
  "ok": true,
  "sync_run_id": "0f1e2d3c-4b5a-4968-8776-655443322110",
  "status": "partial",
  "finished": true,
  "started_at": "2026-07-30T03:00:04.120Z",
  "completed_at": "2026-07-30T03:04:52.310Z",
  "duration_seconds": 288.19,
  "error_message": "1 streamer(s) failed; 1 skipped for token health; 6 of 8 synced.",
  "totals": {
    "posts_processed": 118,
    "videos_processed": 22,
    "comments_processed": 1043,
    "summaries_generated": 19
  },
  "child_run_count": 12,
  "streamers": [
    {
      "streamer_id": "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
      "streamer_code": "CBS-014",
      "status": "succeeded",
      "token_status": "valid",
      "posts_processed": 21,
      "post_insights_written": 147,
      "videos_processed": 4,
      "video_insights_written": 52,
      "comments_processed": 210,
      "summaries_generated": 3,
      "errors": []
    },
    {
      "streamer_id": "7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f",
      "streamer_code": "CBS-021",
      "status": "skipped",
      "token_status": "expired",
      "posts_processed": 0,
      "post_insights_written": 0,
      "videos_processed": 0,
      "video_insights_written": 0,
      "comments_processed": 0,
      "summaries_generated": 0,
      "errors": [
        {
          "step": "token_validation",
          "message": "Token is expired; skipping this streamer until it is replaced."
        }
      ]
    }
  ]
}
```

`status: "partial"` with `finished: true` is the normal outcome for a roster
with one stale token. Branch on `status` if you want an alert; branch on
`finished` to decide when to export.

### Read an export

```http
GET /api/automation/exports/posts?updated_after=2026-07-29T03%3A00%3A00Z&limit=500 HTTP/1.1
Host: dashboard.example.com
Authorization: Bearer <N8N_API_SECRET>
```

```json
{
  "ok": true,
  "dataset": "posts",
  "contract_version": 1,
  "generated_at": "2026-07-30T03:05:01.442Z",
  "columns": [
    "post_id", "streamer_id", "streamer_code", "facebook_page_id", "facebook_post_id",
    "message", "created_time", "permalink_url", "reactions", "comments", "shares",
    "insight_metric_count", "last_synced_at", "updated_at"
  ],
  "key_column": "facebook_post_id",
  "watermark_column": "updated_at",
  "max_watermark": "2026-07-30T03:02:19.884217Z",
  "filters": {
    "updated_after": "2026-07-29T03:00:00.000Z",
    "from": null,
    "to": null,
    "streamer_id": null
  },
  "pagination": {
    "limit": 500,
    "offset": 0,
    "returned": 2,
    "total": 2,
    "has_more": false,
    "next_offset": null
  },
  "rows": [
    {
      "post_id": "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
      "streamer_id": "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
      "streamer_code": "CBS-014",
      "facebook_page_id": "102938475610293",
      "facebook_post_id": "102938475610293_8801",
      "message": "Ranked grind tonight, come hang out",
      "created_time": "2026-07-29T18:04:00.000Z",
      "permalink_url": "https://facebook.com/102938475610293/posts/8801",
      "reactions": 412,
      "comments": 63,
      "shares": null,
      "insight_metric_count": 7,
      "last_synced_at": "2026-07-30T03:02:19.884Z",
      "updated_at": "2026-07-30T03:02:19.884Z"
    }
  ]
}
```

> **`"shares": null` is not zero.** Meta omits `shares` entirely from a post that
> has none, and a post with zero shares is a different fact from one whose share
> count was withheld. Blank cells throughout these exports mean *not reported*.
> Do not coerce them in a Sheets formula without deciding which you meant.

### An insight row

Sheets holds one scalar per cell, but a Meta metric can be a nested tree — so
each value is carried three ways:

```json
{
  "post_insight_id": "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
  "facebook_post_id": "102938475610293_8801",
  "metric_name": "post_reactions_by_type_total",
  "period": "lifetime",
  "value_display": "412",
  "value_json": "{\"like\":301,\"love\":88,\"wow\":23}",
  "value_type": "object",
  "end_time": null,
  "collected_at": "2026-07-30T03:02:20.101Z"
}
```

`value_display` is the cell a person reads; `value_json` is the exact value for
a workflow that needs the breakdown.

### A refused body

```http
POST /api/automation/sync-all
Authorization: Bearer <N8N_API_SECRET>

{ "page_access_token": "EAAGm0BA1ZC8..." }
```

```json
{
  "ok": false,
  "error": "token_material_refused",
  "message": "This endpoint never accepts Facebook Page tokens or other credentials. The application decrypts Page tokens server-side and calls Meta itself. Remove the offending fields and retry.",
  "fields": [
    {
      "path": "page_access_token",
      "reason": "This field name is reserved for credentials, which these endpoints never accept."
    }
  ]
}
```

Status `400`. The value is not echoed.

### Other error shapes

```json
{ "ok": false, "error": "unauthorized", "message": "Valid bearer credentials are required." }
```

```json
{
  "ok": false,
  "error": "rate_limited",
  "message": "Too many automation requests. Retry in 42s.",
  "retry_after_seconds": 42
}
```

```json
{
  "ok": false,
  "error": "invalid_query",
  "message": "One or more query parameters are invalid.",
  "issues": [{ "field": "updated_after", "message": "\"last tuesday\" is not a valid ISO 8601 timestamp or YYYY-MM-DD date." }]
}
```

Every error body has `ok: false` and a stable `error` code. Branch on the code,
never on the message text.

---

## 9. Sheet layout

The tab names, their exact columns, the seven branches that fill them and the
CSV fallback are all in **[`GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md)**, and served
as JSON by `GET /api/automation/google-sheets/schema`.

| Tab | Dataset | Match on |
|---|---|---|
| Streamers | `streamers` | Streamer ID |
| Facebook Posts | `posts` | Post ID |
| Post Insights | `post-insights` | Insight Key |
| Facebook Videos | `videos` | Video ID |
| Video Insights | `video-insights` | Insight Key |
| Comment Summaries | `comment-summaries` | Summary ID |
| Sync Logs | `sync-logs` | Sync Run ID |

The Comment Summaries tab carries the *analysis* — summary, sentiment, concerns,
suggestions, questions, urgent issues — and never the comments. There is no
commenter column because none exists: the Graph request never asks for `from`,
so no identity is received, stored or exportable.

---

## 10. Retired endpoints

`POST /api/n8n/sync` and `GET /api/n8n/export` were the Phase 1 placeholders.
Both now return `410 Gone` naming their replacement — but only after
authenticating, so a wrong secret still gets `401` and an operator can tell the
two problems apart.

They are deliberately **not** redirects. n8n's HTTP Request node follows
redirects silently, and a workflow that keeps working against a retired URL is a
workflow nobody updates.
