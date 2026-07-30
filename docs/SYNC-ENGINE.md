# Meta Graph Client and Content Synchronization

The server-side Graph client and the Page-post sync pipeline. Implemented in Phase 4.

---

## 1. Layers

```
  sync-posts.ts        orchestration: run lifecycle, audit, streamer state
        │
        ▼
  meta/posts.ts        endpoint knowledge + pure normalisation
        │
        ▼
  meta/client.ts       timeout · retry · pagination · rate limits · logging
        │
        ├── meta/errors.ts     normalisation into 9 categories   [pure]
        ├── meta/retry.ts      backoff · concurrency             [pure]
        └── observability/logger.ts  structured logs + redaction [pure]
```

Everything below `client.ts` is pure, so the failure modes that matter — an
expired token, a rate limit, a metric with no value — are tested exactly rather
than mocked at the HTTP boundary.

---

## 2. Client capabilities

| Capability | Where | Notes |
|---|---|---|
| Configurable API version | `buildGraphUrl` | Reads `META_GRAPH_API_VERSION`; never hard-coded |
| Token decryption | `withStreamerToken` | Lends the plaintext to a callback; it is never returned |
| Request timeout | `graphRequest` | 15 s default via `AbortSignal.timeout` |
| Pagination | `graphPaginate` | Follows `paging.next`, capped at 25 pages |
| Retry + backoff | `retry.ts` | Full jitter, 500 ms base, 30 s cap, 3 retries |
| Rate-limit handling | `errors.ts` + `retry.ts` | Honours `Retry-After`; reads `X-App-Usage` |
| Error normalization | `errors.ts` | Nine categories |
| Structured logs | `logger.ts` | One JSON object per line, redacted |
| Controlled concurrency | `mapWithConcurrency` | 4 insight requests in flight |

### Why full jitter

Every streamer in a run hits Meta at once. Plain exponential backoff would put
them all back in lockstep after a rate limit and they would collide again on the
retry. `delay = random(0, min(cap, base · 2^attempt))` spreads them out.

When Meta supplies `Retry-After`, that wins outright — guessing shorter than a
stated cooldown is how an application earns a longer block.

### What is not retried

`invalid_token`, `expired_token`, `missing_permission`, `page_unavailable`,
`content_unavailable`, and malformed-request errors. Repeating them burns quota
and delays the feedback an admin actually needs. Retried: `rate_limited`,
`network_error`, and Meta 5xx.

---

## 3. Error categories

| Category | Trigger | Retryable |
|---|---|---|
| `invalid_token` | OAuth code 190 | No |
| `expired_token` | 190 with subcode 458/459/460/463/464/467 | No |
| `missing_permission` | code 10, or the 200–299 band | No |
| `rate_limited` | codes 4/17/32/613, or 80000–80014 | **Yes** |
| `page_unavailable` | code 803, or 100 subcode 33 in page context | No |
| `content_unavailable` | 100 subcode 33 in content context | No |
| `network_error` | timeout, DNS, TLS, reset | **Yes** |
| `meta_api_error` | any other Meta error | Only on 5xx |
| `unknown_error` | unrecognised response | Only on 5xx |

Code 100 subcode 33 is Meta's deliberately ambiguous "does not exist, or you
cannot see it". It maps to unavailability rather than to a permission problem,
because the two are indistinguishable from the response — and the caller's
`context` decides whether the missing thing was a Page or a post.

---

## 4. The pipeline

```
POST /api/admin/streamers/{id}/sync-posts
        │
        ├─ open sync_runs row (status = running)
        ├─ withStreamerToken(id, token => {
        │     GET /{page-id}/published_posts   ← paginated, 100 per page
        │     upsert posts on facebook_post_id
        │     mapWithConcurrency(posts, 4, post =>
        │        GET /{post-id}/insights       ← no `metric` parameter
        │        upsert post_insights
        │     )
        │  })
        └─ close run · update streamer · write audit entry
```

**Requested post fields:** `id`, `message`, `created_time`, `permalink_url`,
`reactions.limit(0).summary(true)`, `comments.limit(0).summary(true)`, `shares`.
The `.limit(0).summary(true)` form asks for the count without the payload.

**Partial results survive.** A rate limit on page 4 returns pages 1–3 alongside
the error; the run is recorded as `partial` rather than `failed`, and the posts
already collected are kept. Discarding them would make every subsequent run
start from nothing.

**One post's insights failing does not abandon the rest.** A single unavailable
post is normal on a busy Page; failures are counted and the first 20 recorded on
the run.

The run is closed on every path, including an unexpected throw. An abandoned
`running` row would make the next operator think a sync was still in flight.

### 4b. Videos (Phase 6)

The video pipeline is the same shape with different edges:

```
POST /api/admin/streamers/{id}/sync-videos
        │
        ├─ open sync_runs row (status = running)
        ├─ withStreamerToken(id, token => {
        │     GET /{page-id}/videos            ← paginated, 50 per page
        │     upsert videos on facebook_video_id
        │     mapWithConcurrency(videos, 4, video =>
        │        GET /{video-id}/video_insights   ← no `metric` parameter
        │        upsert video_insights
        │     )
        │  })
        └─ close run · update streamer · write audit entry
```

**Requested video fields:** `id`, `title`, `description`, `created_time`,
`permalink_url`, `length` — exactly the six specified, and no more.

**`/videos`, never `/live_videos`.** The live-video edge can require separate
Meta App Review, which would block the whole integration on an approval this
phase deliberately avoids. Ended broadcasts appear on the general edge as VODs,
so the data is reachable without it. Nothing in the codebase calls
`/live_videos`; a test asserts the field list contains no live-video field.

`length` is stored as `double precision`, not an integer: Meta reports fractional
seconds, and rounding at ingestion would discard precision the source actually
provided. `formatDuration` truncates for display only. A `length` that is absent,
non-finite or negative becomes `null` rather than `0` — the same
missing-is-never-zero rule as §6.

Partial-result handling, per-item failure isolation and run closing are shared
with the post pipeline, so the two cannot drift apart.

---

## 5. Insights are stored dynamically

**Storage** is dynamic. **Requesting** is not, and cannot be, for posts.

`GET /{post-id}/insights` originally sent no `metric` parameter, on the principle
that naming metrics would silently drop whatever the code did not anticipate.
Graph v25 removed that option — the call now fails outright:

```
code 3001, subcode 1504028
"No metric was specified to be fetched."
```

So `src/lib/meta/insight-metrics.ts` holds the list, and it is deliberately
short: **one invalid name fails the entire request** with
`(#100) The value must be a valid insights metric`, which would zero out every
metric for every post — exactly the silent gap the original rule guarded against.
Six names are confirmed working on v25.0 (2026-07-30):

| Metric | Shape |
|--------|-------|
| `post_clicks` | scalar |
| `post_reactions_by_type_total` | `{like, love, haha, …}` |
| `post_activity_by_action_type` | `{share, like, comment}` |
| `post_video_views` | scalar, `lifetime` and `day` |
| `post_video_views_organic` | scalar, `lifetime` and `day` |
| `post_video_avg_time_watched` | scalar, milliseconds |

The whole `post_impressions` family, `post_engaged_users`, `post_clicks_unique`,
`post_activity` and `post_negative_feedback` are **rejected by v25** and are
absent on purpose. Verify against a live Page before adding one:

```bash
curl -s -G "https://graph.facebook.com/v25.0/{POST_ID}/insights" \
  --data-urlencode "metric={CANDIDATE}" --data-urlencode "access_token={TOKEN}"
```

`/video_insights` still accepts no `metric` and returns its full set, so
`meta/videos.ts` sends none and stays genuinely schemaless. Adding a post metric
is a one-line edit to that array: no migration, no column, no contract change.

Each insight arrives as `{ name, period, values: [{ value, end_time }, …] }` and
becomes one row per entry, so a periodic series is preserved rather than
collapsed. Storage is `metric_name`, `period`, `value_json`, `end_time` and the
untouched `raw_json`.

`/video_insights` follows the same rule through the same `normalizeInsights`
function. Video metric values arrive in every JSON shape — a scalar count, a
status string, a retention-curve array, a reactions-by-type object, a nested
demographics tree — so `value_json` is `jsonb` and the value is written exactly
as received: not flattened, not summed, not coerced to a number. Tests assert
each of those shapes survives both normalisation and a round trip through the
column.

### Two hazards found in live testing

Both were invisible to the test suite and both silently produced *zero* insight
rows while every sync reported success.

**A `Date` in a raw `sql` fragment.** The pool runs `prepare: false`, which the
Supabase transaction pooler requires. On that path postgres.js will not
serialise a `Date` interpolated into a hand-written `sql` template — it throws
`ERR_INVALID_ARG_TYPE` before Postgres sees the statement, failing the whole
insert. Use `tsParam()` from `src/lib/db/params.ts` with a `::timestamptz` cast.
Drizzle's typed helpers (`eq`, `gte`, `lte`) are unaffected and are preferable.
`tests/raw-sql-timestamps.test.ts` scans the source for regressions; it is a
source scan because PGlite uses a different driver and cannot reproduce it.

**`= ANY(${array})` in a `sql` template.** Drizzle binds each array element as
its own parameter, compiling to `ANY(($1, $2))` — a row constructor Postgres
rejects. Use `inArray`. With a single-element array the broken form *works*, so a
one-post Page looked healthy and a two-post Page did not.
`tests/id-mapping-queries.test.ts` drives the compiled query against real
Postgres and pins the broken form.

> A counter that reports what the code *intended* to write is not evidence that
> Postgres accepted it. Both bugs reported success while writing nothing.

---

## 6. Missing is never zero

**The rule:** a metric Meta did not report displays as
**“Metric not available from Meta”**, never as `0`.

Zero is a measurement — nobody engaged. Absence is the absence of a measurement.
Collapsing them would turn a permission gap or a retired metric into a confident,
wrong claim, and drag every downstream average toward zero.

Enforced at four points:

1. **Schema.** `reaction_count`, `comment_count`, `share_count` and `value_json`
   are all nullable. There is no `DEFAULT 0` anywhere.
2. **Normalisation.** `normalizePost` returns `null` for an absent summary;
   `normalizeInsights` records a metric with an empty `values` array as present
   but valueless.
3. **Persistence.** No row is ever written for a metric Meta did not return.
4. **Display.** `formatInsightValue` returns `null` for absence and `"0"` for a
   reported zero; the UI substitutes `METRIC_NOT_AVAILABLE`.

The case that makes this concrete: **Meta omits `shares` entirely from a post
with no shares.** A post with zero shares and a post whose share count was
withheld are different facts, and the system refuses to conflate them.

---

## 7. Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/admin/streamers/{id}/sync-posts` | admin | Run a post sync; body optional (`since`, `maxPages`, `concurrency`) |
| `POST /api/admin/streamers/{id}/sync-videos` | admin | Run a video sync; same optional body |
| `GET /api/posts` | any signed-in | Paginated list; filters `streamerId`, `search`, `from`, `to` |
| `GET /api/posts/{id}` | any signed-in | One post plus every stored metric and an `availability` map |

A partial run returns **200 with `status: "partial"`**, not an error status — the
posts collected are real, and reporting the whole run as a failure would hide
them.

---

## 8. Logging

One JSON object per line. Every field passes through `redact()` first, which
strips secret-named keys and credential-shaped values — Meta tokens, our own
`v1.` ciphertext envelope, JWTs, and anything in an `access_token` /
`input_token` / `client_secret` query parameter.

This is a safety net, not a licence: a Graph URL carries the token in its query
string, so `redactUrl()` exists and no URL from the client is logged raw.

Events: `sync.started`, `sync.posts.stored`, `sync.videos.stored`,
`sync.insights.stored`, `sync.finished`, `sync.failed`, `graph.request.ok`,
`graph.request.failed`, `graph.paginate.truncated`, `graph.quota.slowdown`.
