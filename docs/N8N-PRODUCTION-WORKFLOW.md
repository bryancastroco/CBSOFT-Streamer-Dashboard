# The Production n8n Workflow

One workflow, end to end: schedule, sync, poll, export seven datasets, upsert
seven tabs, and alert when something needs a person.

- API reference — [`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md)
- Sheet layout — [`GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md)

> **This has been built.** The workflow described below now exists as
> `CBSOFT Streamer Sync to Google Sheets` (id `sFA25gXa5ZFPTrlE`) in the
> `bryancastroco` n8n Cloud personal project — 36 nodes, inactive until the
> three setup steps below are done. This document remains the explanation of
> *why* it is shaped that way; the workflow itself is the implementation.
>
> **The spreadsheet exists and is wired in.** `CBSOFT Streamer Reporting`
> (id `1RZseZyJSXGmKKjHmC6S3i2Tl8A6z39FWPjpjfpY3dMs`) holds all seven tabs with
> their header rows — 73 columns, generated from `sheet-schema.ts` and diffed
> against it, so the sheet cannot drift from the export contract. The default
> `Sheet1` was removed. All seven Sheet nodes point at it by id, and the
> `Google Sheets account` credential is attached and proven working.
>
> Two things remain deliberately unset, because nobody but the account owner
> should set them: the bearer credential holding `N8N_API_SECRET`, and the
> `baseUrl` in the **Configuration** node.
>
> One deviation from this document: the poll wait is **90 seconds, not 60**.
> The n8n Cloud instance caps a single execution at 180 seconds, and a wait
> under ~65 seconds is held in memory and counts against that cap — three polls
> and the run is killed. Above that threshold n8n offloads the execution and
> resumes it later, so the poll loop can outlive the cap. Twenty polls is
> therefore a 30-minute ceiling.

---

## 1. Shape

```
  ┌──────────────────┐
  │ Schedule Trigger │  0 3 * * *
  └────────┬─────────┘
           ▼
  ┌──────────────────────────┐
  │ POST /automation/sync-all│  → 202 { sync_run_id }
  └────────┬─────────────────┘
           ▼
  ┌──────────────────┐
  │ Set: Run Context │  sync_run_id, attempt = 0
  └────────┬─────────┘
           ▼
      ┌────────┐
      │  Wait  │◄──────────────────────┐
      └───┬────┘                       │
          ▼                            │
  ┌───────────────────────┐            │
  │ GET /sync-runs/{id}   │            │
  └───────┬───────────────┘            │
          ▼                            │
     ┌─────────┐   false               │
     │finished?├───────────────────────┘
     └────┬────┘   (bounded — see §5)
          │ true
          ▼
   ┌──────────────┐   status = failed   ┌──────────────────┐
   │ Sweep Status ├────────────────────►│ Alert: sync fail │
   └──────┬───────┘                     └──────────────────┘
          │ succeeded / partial
          ▼
  ┌────────────────────────────────────────────────┐
  │ Branch A  Streamers          → Sheets upsert   │
  │ Branch B  Facebook Posts     → Sheets upsert   │
  │ Branch C  Post Insights      → Sheets upsert   │
  │ Branch D  Facebook Videos    → Sheets upsert   │
  │ Branch E  Video Insights     → Sheets upsert   │
  │ Branch F  Comment Summaries  → Sheets upsert   │
  └───────────────────┬────────────────────────────┘
                      ▼
  ┌────────────────────────────────┐
  │ Branch G  Sync Logs → upsert   │  last: records the run
  └───────────────┬────────────────┘
                  ▼
        ┌────────────────────┐
        │ Token health check │  → Alert if any needs attention
        └────────────────────┘
```

Branch G runs **last**, so the log it writes describes a sweep whose data has
already landed.

---

## 2. Credential

One **Header Auth** credential, reused by every HTTP node:

| Field | Value |
|---|---|
| Name | `CBSOFT Automation` |
| Header Name | `Authorization` |
| Header Value | `Bearer <N8N_API_SECRET>` |

Rotating is two steps — set the new value in Vercel, then update this credential
— with a window between them where the workflow gets `401`. Schedule it outside
the sync window.

---

## 3. Node 1 — Schedule Trigger

| Field | Value |
|---|---|
| Trigger Rule | Cron |
| Cron Expression | `0 3 * * *` |
| Timezone | your reporting timezone |

The application works entirely in UTC; the trigger's timezone only decides when
the sweep starts.

**If Vercel Cron is also enabled**, the two are alternative triggers for the
same sweep. The application refuses a run that starts sooner than
`SYNC_FREQUENCY_HOURS` after the last, so whichever fires second is answered
`200 skipped` — harmless, but pick one and disable the other to keep the logs
readable.

---

## 4. Node 2 — Start the sweep

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://<app>/api/automation/sync-all` |
| Authentication | Header Auth → `CBSOFT Automation` |
| Send Body | on · JSON |
| JSON | `{ "mode": "async" }` |
| Options → Timeout | `30000` |
| Settings → Retry On Fail | on · 3 tries · 5000 ms |
| Settings → On Error | Stop workflow |

Returns `202` with a `sync_run_id`. All the ceilings — lookback window,
per-streamer caps, comment caps — come from the deployment's environment, so the
body stays empty unless you are deliberately overriding one.

**Node 3 — Set: Run Context**

| Field | Value |
|---|---|
| `sync_run_id` | `={{ $json.sync_run_id }}` |
| `poll_attempt` | `={{ 0 }}` |
| Include Other Fields | off |

Pinning the id in its own node means later nodes reference
`$('Run Context').item.json.sync_run_id` rather than reaching back through
whatever the previous node happened to output.

---

## 5. Nodes 4–6 — Poll until finished

**Wait**: After Time Interval, `60` seconds.

**HTTP Request — Poll**

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `=https://<app>/api/automation/sync-runs/{{ $('Run Context').item.json.sync_run_id }}` |
| Authentication | Header Auth → `CBSOFT Automation` |
| Options → Timeout | `15000` |
| Settings → Retry On Fail | on · 3 tries · 5000 ms |

**If — Finished?**: Boolean *is true* on `={{ $json.finished }}`.
False → back to Wait. True → onward.

### Bound the loop

A polling loop with no ceiling turns a stuck run into a workflow that never
ends. Between Wait and Poll, add a **Set** node incrementing the counter:

```
poll_attempt = {{ $('Run Context').item.json.poll_attempt + 1 }}
```

and an **If** that routes `poll_attempt > 30` to the failure alert. Thirty
attempts at 60 seconds is half an hour — comfortably longer than a real sweep,
short enough that a stuck run is noticed the same morning.

> Read `finished`, not `status`. It is derived from the parent run's own status,
> and the parent is closed last — so there is no window where it looks complete
> while a child is still working.

---

## 6. Node 7 — Branch on the outcome

A **Switch** on `={{ $json.status }}`:

| Value | Route |
|---|---|
| `succeeded` | export |
| `partial` | export, **and** send the sync alert |
| `failed` | alert only — do not export |

`partial` is the normal outcome for a roster with one stale token. It means some
streamers worked, so the data is worth exporting; it also means somebody should
look. Treating it as a hard failure trains people to ignore the status field,
and then a real total failure goes unnoticed.

`failed` means nothing worked. Exporting would write a sheet full of yesterday's
data under today's timestamp.

---

## 7. Branches A–G — Export and upsert

Seven identical pairs. Only the dataset name and the destination tab change.

### HTTP Request

| Field | Value |
|---|---|
| Method | `GET` |
| URL | `https://<app>/api/automation/exports/<dataset>` |
| Authentication | Header Auth → `CBSOFT Automation` |
| Send Query Parameters | on |
| `format` | `sheets` |
| `updated_after` | `={{ $('Checkpoints').item.json.<dataset>_watermark }}` |
| `limit` | `500` |
| `offset` | `={{ $json.pagination ? $json.pagination.next_offset : 0 }}` |
| Options → Timeout | `60000` |
| Settings → Retry On Fail | on · 3 tries · 5000 ms |
| Settings → On Error | Continue (using error output) |

**`format=sheets` is the important parameter.** Rows come back already keyed by
the tab's column headers, in tab order, so the Sheets node maps automatically
with no transform node in between. Seven branches each needing a hand-maintained
mapping node is seven places for a column to be quietly dropped.

### Google Sheets

| Field | Value |
|---|---|
| Resource | Sheet Within Document |
| Operation | **Append or Update Row** |
| Document | your spreadsheet |
| Sheet | the branch's tab |
| Mapping Column Mode | Map Automatically |
| Column to Match On | the tab's matching column |
| Options → Cell Format | `USER_ENTERED` |

`USER_ENTERED` lets Sheets store dates and numbers as real values rather than
text — which is what makes a date column sortable and a count column summable.

### The seven

| Branch | Dataset | Tab | Match on |
|---|---|---|---|
| A | `streamers` | Streamers | Streamer ID |
| B | `posts` | Facebook Posts | Post ID |
| C | `post-insights` | Post Insights | Insight Key |
| D | `videos` | Facebook Videos | Video ID |
| E | `video-insights` | Video Insights | Insight Key |
| F | `comment-summaries` | Comment Summaries | Summary ID |
| G | `sync-logs` | Sync Logs | Sync Run ID |

**Append or Update Row, never Append.** A plain Append adds a new row for every
post on every run: after a week the sheet has seven copies of everything, and
nobody notices until a total is questioned.

### Paginating

Loop the HTTP node back into itself while `{{ $json.pagination.has_more }}` is
true, passing `next_offset` as `offset`. Post Insights is the branch that will
actually need it — one row per metric per post adds up quickly.

### Checkpointing

Store `{{ $json.max_watermark }}` per dataset after the last page, and feed it
back as `updated_after` next run. n8n's static workflow data is the simplest
place; a dedicated Checkpoints tab in the spreadsheet also works and has the
advantage of being visible.

> **Take the checkpoint from `max_watermark`, never from a row's timestamp.**
> `max_watermark` is microsecond-precise because that is what Postgres stores;
> the per-row columns are millisecond-precise because they are rendered from a
> JavaScript `Date`. A checkpoint even 500 microseconds early re-delivers the
> boundary rows — and because a bulk upsert stamps every row it writes with one
> transaction timestamp, that is the entire previous batch, every night.

On the first run omit `updated_after` entirely to backfill.

---

## 8. Error handling and retry

### What to retry, and what not to

| Response | Meaning | Do |
|---|---|---|
| `429` | Rate limited | Retry after `Retry-After`. Built into Retry On Fail |
| `5xx` | Transient server fault | Retry 3 times |
| `401` | Wrong or missing secret | **Do not retry.** Alert — it will not fix itself |
| `400 invalid_query` | Malformed parameter | **Do not retry.** The workflow is wrong |
| `400 token_material_refused` | A credential was sent | **Do not retry.** Fix the workflow |
| `422 token_unusable` | A Page token needs replacing | Alert; a person must act |

Retrying a `401` for three attempts every night produces a workflow that has
been broken for a month and looks busy.

### Per-branch isolation

Set every export node's **On Error** to *Continue (using error output)*, and
route the error output to the alert node. One dataset failing then costs one
tab, not the whole run — which matters because the branches are independent and
six of seven succeeding is a much better night than none.

### The workflow-level catch

Add an **Error Trigger** workflow that fires on any unhandled failure and sends
the same alert. It is the backstop for the failure you did not anticipate.

---

## 9. Token-health alerts

The single most valuable alert in the system. A Page token that has been revoked
produces no error anybody sees — the sweep skips that streamer and finishes
`partial`, and the Page quietly stops updating until someone notices the numbers
have gone flat.

After Branch A, add a **Filter**:

```
{{ ["expired", "invalid", "missing", "missing_permission"].includes($json["Token Status"]) }}
```

then a notification node:

> **Page token needs attention**
> {{ $json["Streamer Name"] }} ({{ $json["Streamer Code"] }})
> Status: **{{ $json["Token Status"] }}**
> Page: {{ $json["Page Name"] }}
> Last successful sync: {{ $json["Last Successful Sync"] || "never" }}
>
> Replace it: https://\<app\>/streamers/{{ $json["Streamer ID"] }}?tab=settings

Add `expiring` to the filter if you want warning before the outage rather than
after. It is a different message — "this will break soon" rather than "this is
broken" — so it is worth a separate branch with a lower urgency.

> **The alert carries no token.** *Token Status* is a health enum. The
> credential itself is not on the tab, not in the export, and not in this
> message — that is what makes it safe to send to a chat channel.

---

## 10. Failed-sync alerts

Fired from the Switch in §6 (`failed`), from the poll-loop ceiling in §5, and
from any branch's error output.

> **Synchronisation {{ $json.status || "failed" }}**
> Run: `{{ $json.sync_run_id }}`
> Started: {{ $json.started_at }}
> Duration: {{ $json.duration_seconds }}s
>
> {{ $json.error_message }}
>
> Streamers: {{ $json.totals.posts_processed }} posts,
> {{ $json.totals.videos_processed }} videos,
> {{ $json.totals.summaries_generated }} summaries
>
> Detail: https://\<app\>/settings

For a `partial`, list the streamers that did not work — an **Item Lists** node
over `$json.streamers` filtered to `status != "succeeded"` gives one line each
with its `errors[0].message`. That turns "the sweep was partial" into "CBS-021's
token expired", which is the difference between an alert somebody acts on and
one they mute.

### Alert on silence, too

Every alert above fires when something *runs* and fails. None fires if the
workflow never runs at all — a disabled schedule, a paused n8n instance, an
expired Google credential blocking the whole thing.

Add a second, independent workflow on a daily schedule that reads
`/api/automation/exports/sync-logs?limit=1` and alerts if the newest
`Started At` is older than a day. It is a few nodes, and it is the only thing
that catches the automation being switched off.

---

## 11. Verifying the whole thing

1. **Disable the schedule** and run manually.
2. Confirm `sync-all` returns `202` with a `sync_run_id`.
3. Watch the poll loop reach `finished: true`.
4. Confirm all seven tabs have rows and correct headers.
5. Run it **again immediately**. Row counts must not change — that is the upsert
   working. If a tab doubles, its matching column is wrong.
6. Check **Settings** in the application: seven datasets, each with a recent
   successful run.
7. Temporarily point one node at a bad URL and confirm the alert fires.
8. Re-enable the schedule.

Step 5 is the one people skip, and duplicate rows are the failure that takes
longest to notice.

---

## 12. Operational notes

**Runtime.** A roster of ten Pages with comment analysis takes roughly 3–8
minutes. Most of it is comments: each item is a paginated Graph walk, and a
*changed* comment set is an Anthropic call.

**Cost.** Meta quota scales with posts × insight calls. Anthropic cost scales
with *changed* comment sets only — the source-hash gate means an unchanged set
costs a fetch and nothing else. `AI_SUMMARIZATION_ENABLED=false` stops AI spend
without stopping collection.

**Sheet growth.** Post Insights is by far the largest tab — one row per metric
per post. At 100 posts per streamer and ~8 metrics each, ten streamers is ~8,000
rows a month. Sheets holds 10 million cells; at 8 columns that is comfortable
for a couple of years, and then the tab needs archiving.

**Timezones.** The application is UTC throughout. Set the spreadsheet's locale
to match, or a date column will read an hour or two off and somebody will spend
an afternoon on it.

**Do analysis in a separate spreadsheet** linked with `IMPORTRANGE`. These tabs
are overwritten by an upsert on every run, and a formula or chart added inside a
data tab will fight the automation.
