# The Google Sheets Reporting Mirror

The seven tabs, their columns, the seven n8n branches that fill them, and the
CSV fallback for when n8n is not available. Implemented in Phase 9.

> The automation API itself — authentication, rate limits, the sync workflow,
> error shapes — is [`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md). This document is
> about the spreadsheet.

---

## 1. Two rules, and what enforces them

**The database is the primary source. The spreadsheet is a mirror.**

Nothing in this application reads a sheet. There is no code path that could:
no Google client, no Sheets dependency, no read endpoint. Data flows one way.
If a sheet is deleted, nothing breaks — re-run the branches and it repopulates.

That matters because a spreadsheet is editable by anyone with access. If the
application ever read one back, a manager tidying a column would be silently
changing the system of record.

**n8n owns the Google credential.**

There is no field in this application to store one, no environment variable for
one, and no code that would use one. `GOOGLE_SHEETS_EXPORT_ENABLED` is a
feature flag, not a credential. The application produces rows over an
authenticated HTTP endpoint; n8n reads them and writes them to Sheets using a
credential this repository never sees.

**And no Facebook Page token reaches a sheet.** No tab has a column capable of
carrying one — the column sets in `src/lib/google-sheets/sheet-schema.ts` are
declared one at a time, and `tests/google-sheets-schema.test.ts` asserts every
header against a duplicated literal. The Streamers tab shows *Token Status* — a
health value such as `expiring` — which is what lets a workflow raise an alert
without ever seeing the credential.

---

## 2. The seven tabs

Create one spreadsheet with seven tabs, named exactly as below. Write the header
row exactly as listed, in order — Sheets is positional once a header exists.

`GET /api/automation/google-sheets/schema` returns all of this as JSON, so a
setup workflow can create the tabs rather than an operator typing them.

### Tab 1 — `Streamers`

Match on **Streamer ID**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Streamer ID | uuid | Matching column |
| 2 | Streamer Code | string | Business key, e.g. `CBS-014` |
| 3 | Streamer Name | string | |
| 4 | Page ID | string | Meta Page identifier |
| 5 | Page Name | string | |
| 6 | Token Status | string | Health only. Never the token |
| 7 | Active | boolean | |
| 8 | Last Successful Sync | datetime | UTC. Blank if never |
| 9 | Last Sync Error | text | Sanitised. Blank when clean |
| 10 | Updated At | datetime | UTC |

### Tab 2 — `Facebook Posts`

Match on **Post ID**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Post ID | string | Meta's `{page-id}_{post-id}`. Matching column |
| 2 | Streamer ID | uuid | Joins to Streamers |
| 3 | Streamer Name | string | |
| 4 | Page ID | string | |
| 5 | Message | text | |
| 6 | Created Time | datetime | UTC |
| 7 | Reactions | integer | Blank = not reported. **Not zero** |
| 8 | Comments | integer | Blank = not reported |
| 9 | Shares | integer | Blank = not reported. Meta omits this entirely on a post with none |
| 10 | Permalink | url | |
| 11 | Last Synced At | datetime | UTC |

### Tab 3 — `Post Insights`

Match on **Insight Key**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Insight Key | string | Composite. Matching column — see §3 |
| 2 | Post ID | string | Joins to Facebook Posts |
| 3 | Streamer ID | uuid | |
| 4 | Metric Name | string | Whatever Meta called it |
| 5 | Period | string | `lifetime`, `day`, `week`, `days_28`… |
| 6 | Value | string | Readable rendering. Blank = not reported |
| 7 | End Time | datetime | Periodic metrics only |
| 8 | Collected At | datetime | UTC |

### Tab 4 — `Facebook Videos`

Match on **Video ID**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Video ID | string | Matching column |
| 2 | Streamer ID | uuid | |
| 3 | Streamer Name | string | |
| 4 | Page ID | string | |
| 5 | Title | string | |
| 6 | Description | text | |
| 7 | Length Seconds | number | Fractional. Blank = no length reported |
| 8 | Created Time | datetime | UTC |
| 9 | Permalink | url | |
| 10 | Last Synced At | datetime | UTC |

### Tab 5 — `Video Insights`

Match on **Insight Key**. Same shape as Post Insights, keyed on the video.

| # | Column | Type |
|---|--------|------|
| 1 | Insight Key | string |
| 2 | Video ID | string |
| 3 | Streamer ID | uuid |
| 4 | Metric Name | string |
| 5 | Period | string |
| 6 | Value | string |
| 7 | End Time | datetime |
| 8 | Collected At | datetime |

### Tab 6 — `Comment Summaries`

Match on **Summary ID**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Summary ID | uuid | Matching column. Regenerating updates in place |
| 2 | Content Type | string | `post` or `video` |
| 3 | Content ID | string | Meta's id. Joins to Posts or Videos |
| 4 | Streamer ID | uuid | |
| 5 | Streamer Name | string | |
| 6 | Content Title | text | |
| 7 | Comment Count | integer | |
| 8 | Sentiment | string | |
| 9 | Summary | text | |
| 10 | Positive Points | text | Pipe-separated |
| 11 | Concerns | text | Pipe-separated |
| 12 | Suggestions | text | Pipe-separated |
| 13 | Questions | text | Pipe-separated |
| 14 | Urgent Issues | text | Pipe-separated |
| 15 | Generated At | datetime | UTC |

This tab carries the **analysis**, never the comments — and no commenter column,
because none is collected. A blank finding list means there were no real
findings; the model's `No significant findings` placeholder is never written out
as text.

### Tab 7 — `Sync Logs`

Match on **Sync Run ID**.

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | Sync Run ID | uuid | Matching column |
| 2 | Streamer ID | uuid | Blank for a roster-wide sweep |
| 3 | Sync Type | string | `automation`, `manual`, … |
| 4 | Status | string | `succeeded`, `partial`, `failed`, … |
| 5 | Posts Processed | integer | |
| 6 | Videos Processed | integer | |
| 7 | Comments Processed | integer | |
| 8 | Summaries Generated | integer | |
| 9 | Started At | datetime | UTC |
| 10 | Completed At | datetime | Blank while in flight |
| 11 | Error Message | text | Sanitised |

---

## 3. The matching columns

Every branch uses **Append or Update Row**, never Append. A plain Append adds a
new row for every post on every run: after a week the sheet has seven copies of
everything, and nobody notices until a total is questioned.

| Tab | Matching column | Why it is stable |
|---|---|---|
| Streamers | Streamer ID | The internal uuid, fixed for the life of the streamer |
| Facebook Posts | Post ID | Meta's `{page}_{post}`. Globally unique, and the database's own upsert key |
| Post Insights | Insight Key | Composite — see below |
| Facebook Videos | Video ID | Meta's video id. Globally unique |
| Video Insights | Insight Key | Composite — see below |
| Comment Summaries | Summary ID | One summary per content item; regenerating updates it in place |
| Sync Logs | Sync Run ID | Written when the run opens, updated when it closes |

### The insight composite key

A metric row is not identified by its metric name alone: the same metric appears
once per period and, for periodic metrics, once per `end_time`. So:

```
{content id}::{metric name}::{period}::{end time}
```

with a missing period or end time written as an empty segment:

```
102938475610293_8801::post_impressions::lifetime::
102938475610293_8801::post_video_views::day::2026-07-29T00:00:00.000Z
```

This deliberately mirrors the database's own uniqueness rule —
`(content, metric_name, coalesce(period,''), coalesce(end_time,'epoch'))`. If
the sheet keyed on something coarser, two rows the database keeps apart would
collapse into one; if it keyed on something finer, one row would split into two.

Each insight row also carries its UUID in the API (`post_insight_id`), but the
composite key is what the sheet matches on: it is readable, and it survives a row
being deleted and re-collected, which the UUID does not.

---

## 4. The seven branches

Each branch is three nodes: an HTTP Request, an optional pagination loop, and a
Google Sheets node. They are independent — one failing does not stop the others,
which is why they are separate branches rather than one loop over a dataset list.

Run them **after** the sync sweep has finished. See
[`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md) §2 for the polling loop that decides
when that is.

### The shared HTTP Request configuration

| Field | Value |
|---|---|
| Method | `GET` |
| Authentication | Generic Credential Type → Header Auth → `CBSOFT Automation` |
| Send Query Parameters | on |
| Query — `format` | `sheets` |
| Query — `updated_after` | `={{ $('Read Checkpoint').item.json.<tab>_watermark }}` |
| Query — `limit` | `500` |
| Options → Timeout | `60000` |
| Settings → Retry On Fail | on, 3 tries, 5000 ms |

**`format=sheets` is the important one.** It returns each row already keyed by
the tab's column headers, in tab order, so the Google Sheets node can Map
Automatically with no Set node in between. Without it you would need a hand-
maintained mapping node on each of seven branches — seven places for a column to
be quietly dropped.

The response also carries `sheet_tab` and a `key_column` holding the header to
match on, so a branch can be built generically.

### The shared Google Sheets configuration

| Field | Value |
|---|---|
| Resource | Sheet Within Document |
| Operation | **Append or Update Row** |
| Document | your spreadsheet |
| Sheet | the tab for this branch |
| Mapping Column Mode | Map Automatically |
| Column to Match On | the tab's matching column |
| Options → Cell Format | `USER_ENTERED` |

`USER_ENTERED` lets Sheets parse dates and numbers into real values rather than
storing everything as text — which is what makes a date column sortable and a
count column summable.

### Branch A — Streamers

```
GET /api/automation/exports/streamers?format=sheets
      → Google Sheets: Append or Update Row
        Sheet: Streamers   Match on: Streamer ID
```

Small and slow-changing; a single page almost always covers it.

### Branch B — Facebook Posts

```
GET /api/automation/exports/posts?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Facebook Posts   Match on: Post ID
```

### Branch C — Post Insights

```
GET /api/automation/exports/post-insights?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Post Insights   Match on: Insight Key
```

The largest tab by a wide margin — one row per metric per post. Use
`updated_after` from the first run onward, or it will re-send everything nightly.

### Branch D — Facebook Videos

```
GET /api/automation/exports/videos?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Facebook Videos   Match on: Video ID
```

### Branch E — Video Insights

```
GET /api/automation/exports/video-insights?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Video Insights   Match on: Insight Key
```

### Branch F — Comment Summaries

```
GET /api/automation/exports/comment-summaries?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Comment Summaries   Match on: Summary ID
```

### Branch G — Sync Logs

```
GET /api/automation/exports/sync-logs?format=sheets&updated_after=…
      → Google Sheets: Append or Update Row
        Sheet: Sync Logs   Match on: Sync Run ID
```

Run this one **last**, so the log records a sweep whose data has already landed.

---

## 5. Paginating and checkpointing

Both are described in full in [`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md) §7; the
short version:

- Loop back into the HTTP Request while `{{ $json.pagination.has_more }}` is
  true, passing `{{ $json.pagination.next_offset }}` as `offset`.
- Store `{{ $json.max_watermark }}` per tab and send it back as `updated_after`
  next run.

**Checkpoint from `max_watermark`, never from a row's timestamp column.**
`max_watermark` is microsecond-precise because that is what Postgres stores; the
per-row columns are millisecond-precise because they are rendered from a
JavaScript `Date`. Checkpointing from a row sends a value up to 999 microseconds
early, and since a bulk upsert stamps every row it writes with one transaction
timestamp, that re-delivers the whole previous batch every night.

On the very first run, omit `updated_after` entirely to backfill.

---

## 6. Example

Request:

```http
GET /api/automation/exports/posts?format=sheets&limit=2 HTTP/1.1
Host: dashboard.example.com
Authorization: Bearer <N8N_API_SECRET>
```

Response:

```json
{
  "ok": true,
  "dataset": "posts",
  "contract_version": 2,
  "format": "sheets",
  "generated_at": "2026-07-30T03:05:01.442Z",
  "columns": [
    "Post ID", "Streamer ID", "Streamer Name", "Page ID", "Message",
    "Created Time", "Reactions", "Comments", "Shares", "Permalink",
    "Last Synced At"
  ],
  "key_column": "Post ID",
  "sheet_tab": "Facebook Posts",
  "watermark_column": "updated_at",
  "max_watermark": "2026-07-30T03:02:19.884217Z",
  "pagination": {
    "limit": 2, "offset": 0, "returned": 1, "total": 1,
    "has_more": false, "next_offset": null
  },
  "rows": [
    {
      "Post ID": "102938475610293_8801",
      "Streamer ID": "3f0a5b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c",
      "Streamer Name": "Sample Streamer",
      "Page ID": "102938475610293",
      "Message": "Ranked grind tonight, come hang out",
      "Created Time": "2026-07-29T18:04:00.000Z",
      "Reactions": 412,
      "Comments": 63,
      "Shares": "",
      "Permalink": "https://facebook.com/102938475610293/posts/8801",
      "Last Synced At": "2026-07-30T03:02:19.884Z"
    }
  ]
}
```

The field names are the column headers, so Map Automatically works directly.

> **`"Shares": ""` is not zero.** Meta omits `shares` entirely from a post that
> has none, and a post with zero shares is a different fact from one whose count
> was withheld. Every blank cell in these tabs means *not reported*. A
> `SUM()` over the column ignores blanks, which is correct; an `AVERAGE()` also
> ignores them, which is usually what you want — but decide before you write
> `IFERROR(x, 0)` anywhere.

---

## 7. CSV fallback

n8n is a single point of failure. When it is down, misconfigured, or waiting on
a credential rotation, the mirror stops being fed — and "wait for the automation
to be fixed" is not an answer when the sheet is what the business reads.

So every tab can be downloaded as a CSV from the browser:

```
/api/export/sheets/streamers
/api/export/sheets/posts
/api/export/sheets/post-insights
/api/export/sheets/videos
/api/export/sheets/video-insights
/api/export/sheets/comment-summaries
/api/export/sheets/sync-logs
```

There are download buttons for all seven on **Settings**.

The headers are generated from the same definitions the automation uses, in the
same order, so a downloaded file lines up with a sheet the workflow has been
writing to. Import it with **File → Import → Replace current sheet** (or paste
below the existing rows and de-duplicate on the matching column).

Differences from the automation path:

- Authenticated by **session**, not by the n8n bearer secret. It is a person
  clicking a link, and it is deliberately not reachable with the automation
  credential.
- Capped at 5,000 rows per file. Narrow the period or pick a single streamer if
  a download reaches the cap.
- Recorded in `export_runs` with `caller: "browser"`, so Settings can tell a
  hand-pulled file from a scheduled one.

The same filters work: `?streamer_id=…&from=2026-07-01&to=2026-07-31`.

---

## 8. Monitoring it

**Settings** shows the state of the pipeline:

| Card | What it answers |
|---|---|
| Google Sheets export | Is `GOOGLE_SHEETS_EXPORT_ENABLED` on? |
| n8n connection | Has an authenticated automation request arrived recently? Stale after 36 h |
| Last successful export | When, which dataset, how many rows |
| Records exported | Rows in the last 24 hours, and all time |
| Last export error | When and which dataset, with the sanitised message |

Plus a per-dataset table, so one broken branch is visible while the other six are
fine — a failure mode that a single "last export" figure hides completely.

The **Sync Logs** tab is the same information inside the spreadsheet, for anyone
who does not have an application login.

---

## 9. Setting the spreadsheet up

1. Create a spreadsheet and share it with the Google account n8n authenticates
   as. Restrict it to named accounts — see `SECURITY.md` R8.
2. Create the seven tabs with the exact names in §2.
3. Write each header row exactly as listed, in order. Or let a one-off workflow
   do it from `GET /api/automation/google-sheets/schema`.
4. Freeze the header row and set each tab's date columns to a date format.
5. Build the seven branches from §4.
6. Run once with no `updated_after` to backfill, then store the watermarks.
7. Check **Settings** afterwards: seven datasets should show a recent successful
   run.

Do analysis in a **separate** spreadsheet linked with `IMPORTRANGE`. These tabs
are overwritten by an upsert on every run, and a formula or a chart added inside
a data tab will fight the automation.
