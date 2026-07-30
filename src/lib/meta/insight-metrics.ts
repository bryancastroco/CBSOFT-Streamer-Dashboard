/**
 * The post-insight metrics this application asks Meta for.
 *
 * ## Why this list has to exist
 *
 * The original design sent no `metric` parameter, on the principle that naming
 * metrics here would silently drop anything Meta added later. Graph v25 removed
 * that option: `GET /{post-id}/insights` with no `metric` now fails outright.
 *
 *     code 3001, subcode 1504028
 *     "No metric was specified to be fetched."
 *
 * So the choice is not "list metrics or stay schemaless" — it is "list metrics
 * or collect nothing". Storage stays schemaless regardless: `post_insights` keys
 * on `(post, metric_name, period, end_time)` with a JSON value, so adding a
 * metric is an edit to this array and nothing else. No migration, no new column,
 * no change to the export contract.
 *
 * ## Why not simply request everything Meta documents
 *
 * A single invalid name fails the whole request:
 *
 *     (#100) The value must be a valid insights metric
 *
 * One retired metric would therefore zero out every metric for every post. That
 * is precisely the silent data gap the original design was trying to avoid, so
 * the list is deliberately conservative: every entry below was confirmed to
 * return a value against a live Page on Graph v25.0 (2026-07-30).
 *
 * The whole `post_impressions` family — `post_impressions`,
 * `_unique`, `_organic`, `_paid` — plus `post_engaged_users`, `post_clicks_unique`,
 * `post_activity` and `post_negative_feedback` are all rejected by v25 and are
 * intentionally absent. Do not re-add one without checking it against a real
 * Page first; `docs/SYNC-ENGINE.md` records how.
 *
 * Video insights need none of this: `GET /{video-id}/video_insights` still
 * returns its full set with no `metric` parameter, and `meta/videos.ts`
 * continues to send none.
 */

/** Confirmed working on Graph v25.0. Order is cosmetic. */
export const POST_INSIGHT_METRICS: readonly string[] = [
  // Link and content clicks, lifetime.
  "post_clicks",
  // Reaction totals broken down by type: {like, love, haha, …}.
  "post_reactions_by_type_total",
  // Shares, likes and comments as one breakdown object.
  "post_activity_by_action_type",
  // Video metrics, returned for video posts and absent for the rest.
  "post_video_views",
  "post_video_views_organic",
  "post_video_avg_time_watched",
] as const;

/** The `metric` query-string value for a post insights request. */
export const POST_INSIGHT_METRIC_PARAM = POST_INSIGHT_METRICS.join(",");
