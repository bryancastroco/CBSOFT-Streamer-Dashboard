# Dashboard and Reporting Interface

How the screens are put together, and the four rules that shape them. Implemented in Phase 7.

---

## 1. Filters live in the URL

There is one filter contract, resolved by one pure function, used by every screen and every export:

```
src/lib/filters/period.ts   presets → a concrete UTC window
src/lib/filters/sorting.ts  sort keys → an allow-list
src/lib/filters/browse.ts   the combined resolver + the href builder
```

`resolveBrowseQuery` reads `period`, `from`, `to`, `scope`, `streamerId`, `gameId`, `search`,
`sort`, `dir` and `offset` out of the query string. `buildBrowseHref` writes them back, changing
only what it is given.

**`gameId` has three states, not two.** Absent means every game; a uuid means that game; the
reserved value `none` (`UNFILED_GAME`) means content attributed to no game at all. The third is a
real selection — once games are configured, unattributed content is the category an admin needs to
list in order to find the gap — so it resolves to `is null`, via the single `gameClause` helper in
`src/lib/db/game-filter.ts`. The sentinel is not a uuid, so it cannot collide with a real id.

Nothing else constructs a URL. Every sort header, page button, filter control, tab link and export
link routes through `buildBrowseHref`, which is what makes it impossible for one control to drop a
filter another control had set — a bug that stays invisible until somebody exports the wrong rows.

**Why the URL and not component state.** A filtered view is shareable, survives a refresh, is
undone by the back button, and — the reason that matters most — can be handed verbatim to the CSV
endpoint. Both sides resolve it with the same function, so the file cannot describe a different set
of rows than the table it was downloaded from.

**Why UTC.** Meta reports `created_time` in UTC and the database stores `timestamptz`. A window
computed in the viewer's local zone would put the same post inside "today" for one person and
outside it for another. Every screen displays UTC and the boundaries match.

**Rolling presets are whole days.** "Last 7 days" is today plus the six days before it, not the
last 168 hours. Two weekly reports have to line up with days, not with the moment someone opened
the page.

**A custom range that cannot be read is reported, not silently replaced.** An unparseable date, or
a range that ends before it starts, produces a `warning` the filter bar shows. Quietly rendering a
different window than the one asked for is worse than saying so.

---

## 2. Sorting cannot reach SQL

A sort key arrives from the query string, and the query string is attacker-controlled. Interpolating
it into `ORDER BY` — even through a template literal that looks safe — makes ordering an injection
point.

Two layers prevent it:

1. `resolveSort` checks the key against a per-table allow-list (`POST_SORT_KEYS`,
   `VIDEO_SORT_KEYS`, `ANALYSIS_SORT_KEYS`). Anything else resolves to that table's default. A
   direction is only honoured alongside a valid key, so `?dir=asc` alone cannot reverse the default.
2. The repository maps the resolved key through a `Record<SortKey, Column>` to a Drizzle column
   object or a fixed SQL fragment. An unrecognised string cannot index into it, so no user-supplied
   text ever becomes SQL.

`tests/filters.test.ts` fires `encrypted_page_token`, `createdTime; drop table posts` and `(select
1)` at the resolver and asserts each falls back to the default.

Every sort is `NULLS LAST` in both directions, and every query carries a stable final tiebreak on
id — without it, paging through a column with duplicate values can show the same row twice.

---

## 3. Missing is never zero — on the dashboard too

The rule from [`SYNC-ENGINE.md`](./SYNC-ENGINE.md) §6 is easiest to break on an aggregate.
`sum(reaction_count)` skips nulls silently, which would report "1,000 reactions" for a window where
half the posts never reported a figure: an understatement presented as a total.

So every engagement total is a `MetricTotal`:

```ts
{ total: number | null, reported: number, notReported: number }
```

The card renders the sum and names the excluded rows — *"312 posts did not report it — excluded,
not counted as zero"* — or shows `—` when nothing reported the figure at all. Table cells show `—`
with a title attribute. CSV cells are left blank, never `0`.

The same distinction runs through the analysis columns: a null sentiment renders as **Not
analysed**, not as *Neutral*. One is the absence of an opinion about the content; the other is an
opinion. And a finding list containing only the model's `No significant findings` placeholder counts
as **zero** findings — treating array length as the signal would mark every analysed item as having
concerns.

---

## 4. Nothing viewer-facing can carry a token

Three structural facts, not three habits:

| Layer | What makes it true |
|---|---|
| Repository | `listStreamerOptions` and `getStreamerIdentity` select four and ten identity columns. No token field exists on the returned shape for a screen to render by accident. |
| Roster | `token_status` is selected, but the page passes `showTokens={isAdmin(user.role)}`. Phase 2 grants viewers `streamers.view` and explicitly withholds anything about tokens. |
| Settings tab | The token-bearing `getStreamerById` is called **inside** the admin-only branch, so a viewer's request never reaches a query that selects token health. |
| Export | Columns are declared one by one in `lib/export/columns.ts`. There is no spread and no `Object.keys(row)`, so a new column on a table cannot appear in a download. |

`tests/csv-export.test.ts` asserts the export rule from the outside: no header may contain `token`,
`secret`, `credential`, `password`, `encrypted`, `cipher`, `authorization` or `bearer`, and the only
streamer columns are `Streamer code` and `Streamer name`. It also asserts no header mentions a
commenter — there is none to export, because none is collected.

---

## 5. CSV: two things that are easy to get wrong

`lib/export/csv.ts` is pure and tested, for two reasons a naive `rows.join(",")` misses.

**RFC 4180 quoting.** A comment containing a comma, a quote or a newline must not shift every
following column by one. Fields are quoted; inner quotes are doubled.

**Formula injection.** A cell beginning `=`, `+`, `-`, `@`, tab or CR is *executed* when the file
opens in Excel, Numbers or Sheets. These exports carry third-party comment text, so a commenter
could otherwise plant `=HYPERLINK(...)` in a comment and have it run on a manager's machine. Such
cells get a leading apostrophe — inside the quotes, so the guard is not itself data in the previous
column.

Files carry a UTF-8 BOM and CRLF endings, because the most common destination is Excel on Windows,
which mis-reads accented characters without the BOM.

Exports are capped at `EXPORT_ROW_LIMIT` (5,000) rows. A download is one request holding every row
in memory before the first byte is written, so it needs a bound a paginated screen does not. The cap
applies *after* sorting, so "the first 5,000 by urgency" is a meaningful subset.

---

## 6. Screens

| Route | Who | What |
|---|---|---|
| `/dashboard` | any signed-in | The ten cards, filter bar. Roster cards are current state; content cards are period-scoped. |
| `/posts` | any signed-in | Sortable table, search, pagination, CSV. |
| `/videos` | any signed-in | Same, with duration and available metrics. |
| `/comment-analysis` | any signed-in | Cross-content analysis list — a two-row layout per result, because a summary plus four finding lists does not fit in table cells. |
| `/streamers` | any signed-in | Roster with per-streamer counts. Token column admin-only. |
| `/streamers/{id}` | any signed-in | Six tabs: Overview, Posts, Videos, Comment Analysis, Sync History, Settings. Settings is admin-only. |
| `/reports` | any signed-in | Export hub: set filters once, download any of the three files. |
| `/api/export/{posts,videos,comment-analysis}` | permission-checked | CSV. Authorised on `posts.view` / `videos.view` / `analysis.view`, not on a role. |

**Tabs are links, not client state.** Each tab is its own URL, so it is bookmarkable and
server-rendered, and a tab holding a large table is not fetched just because a sibling is open.
Marked up as a `nav` with `aria-current` rather than `role="tablist"` — these are links, and
claiming the tab pattern would promise an arrow-key model that links do not implement. `basePath`
keeps `?tab=`, so sorting inside a tab stays inside it.

**Tables share one implementation.** `components/tables/{posts,videos,analysis}-table.tsx` are used
by both the standalone screen and the streamer tab; the tab passes `showStreamer={false}`. Two
copies would guarantee that a fix to one — a column, an accessible label, a missing-is-never-zero
dash — silently misses the other. Rows arrive as props, and the components import no repository, so
they cannot widen a query.

---

## 7. States and accessibility

- **Loading.** `(app)/loading.tsx` covers navigation. Each screen additionally wraps its data in
  its own `Suspense` boundary, so changing a filter re-renders the table while the filter bar stays
  painted and interactive — a reader who picked the wrong period can change it without waiting for
  the wrong answer to arrive first.
- **Empty.** Every empty state says why it is empty and offers the next action — clear the filters,
  or go to the screen that would populate it.
- **Error.** `(app)/error.tsx` for the group, `global-error.tsx` for a root-layout failure. Neither
  displays `error.message`: in development it can carry a connection string or a Graph URL, and
  these are reachable by any signed-in role. `digest` is shown for log correlation.
- **Mobile.** Numeric columns are hidden below `md`/`lg` rather than reflowed, so one row stays one
  row, and the first cell carries what a phone needs. Navigation moves into a dropdown; wide tables
  scroll inside their own container.
- **Dark mode.** `next-themes` with `attribute="class"`, defaulting to `system`. The theme toggle
  picks its icon with a `dark:` variant rather than a `mounted` flag, so there is no hydration
  mismatch and no second render.
- **Labels.** Every table has an `sr-only` `<caption>`; headers carry `scope="col"`; sortable
  headers carry `aria-sort` and a link label naming the action ("Reactions, sort ascending");
  icon-only buttons carry `aria-label`; pagination is a labelled `nav` with an `aria-live` summary.

**Confirmation dialogs** wrap the actions that are not free — a sync spends Meta quota, an analysis
spends Anthropic tokens — with a dialog that names the cost. The dialog is a courtesy, never a
control: every wrapped action still calls `assertAdmin()` before it mutates anything.
