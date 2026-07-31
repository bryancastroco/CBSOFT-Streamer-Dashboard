import { createDecipheriv } from "node:crypto";

import postgres from "postgres";

/**
 * Ask Meta which metrics actually exist, one at a time.
 *
 * ## Why one at a time
 *
 * `GET /{post-id}/insights?metric=a,b,c` fails as a whole if any single name is
 * invalid — `(#100) The value must be a valid insights metric`. Probing a batch
 * therefore tells you only that *something* in it was wrong, and worse, adding
 * an unverified name to the live sync list would zero out every metric for
 * every post. Each candidate gets its own request so an unsupported name costs
 * exactly one failed lookup and nothing else.
 *
 * ## Why this is a script and not a route
 *
 * It is read-only reconnaissance against one piece of content, run by hand
 * before the registry is written. The user-facing Metric Discovery tool comes
 * in 21c; this exists to answer a question the registry depends on.
 *
 * The Page token is decrypted in memory and never printed. Only metric names,
 * availability and Meta's own error messages are written to stdout.
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const TOKEN_KEY = process.env["TOKEN_ENCRYPTION_KEY"];
const VERSION = process.env["META_GRAPH_API_VERSION"] ?? "v25.0";

if (!DATABASE_URL || !TOKEN_KEY) {
  console.error("DATABASE_URL and TOKEN_ENCRYPTION_KEY must be set.");
  process.exit(1);
}

/** Mirrors `src/lib/crypto/tokens.ts`: v1.<iv>.<tag>.<ciphertext>, base64url. */
function decryptToken(encoded: string): string {
  const [version, iv, tag, ciphertext] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new Error("Unrecognised token envelope");
  }

  // Hex or base64, exactly as src/lib/crypto/tokens.ts accepts them.
  const key = /^[0-9a-fA-F]{64}$/.test(TOKEN_KEY!)
    ? Buffer.from(TOKEN_KEY!, "hex")
    : Buffer.from(TOKEN_KEY!, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return (
    decipher.update(Buffer.from(ciphertext, "base64url")).toString("utf8") + decipher.final("utf8")
  );
}

/**
 * Candidates for the two metrics the audit could not find, plus a control.
 *
 * The control is a name already known to work, so a run that reports every
 * candidate unavailable can be distinguished from a run where the token or the
 * endpoint was simply wrong.
 */
const POST_CANDIDATES = [
  "post_video_views", // control — known good
  /*
   * The impressions and engagement family, from the documented retrieval map.
   * Every one of these was rejected on the post edge in a previous run; they
   * are kept here so the rejection stays a reproducible observation rather
   * than a note in a comment. If Meta restores any of them, this run says so.
   */
  "post_impressions",
  "post_impressions_unique",
  "post_impressions_organic",
  "post_impressions_organic_unique",
  "post_impressions_paid",
  "post_engaged_users",
  "post_clicks",
  "post_reach",
  // Confirmed working, re-run as a second control.
  "post_reactions_by_type_total",
  "post_activity_by_action_type",
  "post_video_views_unique",
  "post_video_view_time",
  "post_video_avg_time_watched",
];

const VIDEO_CANDIDATES = [
  "total_video_views",
  "total_video_views_unique",
  "total_video_3s_views",
  "total_video_impressions",
  "total_video_impressions_unique",
  "total_video_view_total_time",
  "total_video_avg_time_watched",
  "total_video_complete_views",
  "post_impressions_unique",
  "post_video_views_unique",
];

/**
 * Post *fields*, which are not insights and follow different rules.
 *
 * A field lives on the post object itself and is read with `?fields=`. Unlike
 * insights, an unrecognised field fails only itself, and the summary counts
 * need no `read_insights` — only `pages_read_engagement`. This matters for
 * likes: `post_reactions_by_type_total` is absent for most of the roster, so
 * the LIKE subset currently resolves to unavailable on 1,015 posts. If
 * `likes.summary(true)` answers, that gap closes without an insights call.
 */
const FIELD_CANDIDATES = [
  "reactions.type(LIKE).summary(true).limit(0)",
  /*
   * The alias is the whole question. Two `reactions` requests in one field list
   * collide on the same response key, so the LIKE-filtered one has to be
   * renamed with `.as()`. If Meta refuses the alias, likes and total reactions
   * cannot be fetched in the same call and the design changes.
   *
   * This is the exact combined list the sync would send.
   */
  "reactions.limit(0).summary(true)," +
    "reactions.type(LIKE).limit(0).summary(true).as(like_reactions)," +
    "comments.limit(0).summary(true),shares",
];

type Outcome = { metric: string; status: string; detail: string };

async function probe(id: string, edge: string, metric: string, token: string): Promise<Outcome> {
  const url = new URL(`https://graph.facebook.com/${VERSION}/${id}/${edge}`);
  url.searchParams.set("metric", metric);
  url.searchParams.set("access_token", token);

  try {
    const response = await fetch(url);
    const body = (await response.json()) as {
      data?: { name: string; period: string; values?: { value: unknown }[] }[];
      error?: { message?: string; code?: number };
    };

    if (body.error) {
      const message = body.error.message ?? "unknown";
      // Meta's own wording, trimmed. Never echo the URL — it carries the token.
      return { metric, status: "UNAVAILABLE", detail: message.slice(0, 90) };
    }

    const entry = body.data?.[0];
    if (!entry) return { metric, status: "EMPTY", detail: "accepted, returned no data" };

    const value = entry.values?.[0]?.value;
    const rendered =
      typeof value === "object" && value !== null
        ? `object ${JSON.stringify(value).slice(0, 44)}`
        : String(value);

    return { metric, status: "AVAILABLE", detail: `${entry.period} · ${rendered}` };
  } catch (error) {
    return { metric, status: "ERROR", detail: (error as Error).message.slice(0, 70) };
  }
}

/** Probe one post field. Fields are read with `?fields=`, not `?metric=`. */
async function probeField(id: string, field: string, token: string): Promise<Outcome> {
  const url = new URL(`https://graph.facebook.com/${VERSION}/${id}`);
  url.searchParams.set("fields", field);
  url.searchParams.set("access_token", token);

  try {
    const response = await fetch(url);
    const body = (await response.json()) as Record<string, unknown> & {
      error?: { message?: string };
    };

    if (body.error) {
      return { metric: field, status: "UNAVAILABLE", detail: (body.error.message ?? "").slice(0, 90) };
    }

    // Never echo the whole object — it carries the post id and message text.
    const { id: _id, ...rest } = body;
    const rendered = JSON.stringify(rest).slice(0, 220);

    return { metric: field, status: "AVAILABLE", detail: rendered };
  } catch (error) {
    return { metric: field, status: "ERROR", detail: (error as Error).message.slice(0, 70) };
  }
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });

const line = (outcome: Outcome) =>
  console.log(`  ${outcome.status.padEnd(12)} ${outcome.metric.padEnd(40)} ${outcome.detail}`);

try {
  /*
   * A streamer whose token still works, preferred by how long it has left.
   *
   * Probing with an expired token returns "Session has expired" for every
   * candidate including the controls, which looks exactly like a Page that
   * supports nothing. A run wasted that way is worse than no run — it invites
   * removing candidates that are actually fine.
   */
  const [streamer] = await sql<{ id: string; code: string; token: string }[]>`
    select id, streamer_code as code, encrypted_page_token as token from streamers
     where encrypted_page_token is not null
       and deleted_at is null
       and active = true
       and token_status <> 'expired'
       and (token_expires_at is null or token_expires_at > now())
     order by token_expires_at desc nulls first
     limit 1`;

  if (!streamer) {
    throw new Error(
      "No active streamer holds an unexpired token. Replace one before probing — " +
        "every candidate would fail authentication and read as unsupported.",
    );
  }

  console.log(`Probing with ${streamer.code}\n`);
  const token = decryptToken(streamer.token);

  /*
   * Content belonging to *this* streamer, because the token is this streamer's.
   * The previous version picked any post on the roster, so a probe could fail
   * for the mundane reason that the Page did not own the post — indistinguishable
   * in the output from the metric not existing.
   *
   * Two posts, not one. A video post and a plain one answer differently, and a
   * metric rejected on both is a stronger finding than one rejected on either.
   */
  const [videoPost] = await sql<{ fb: string }[]>`
    select p.facebook_post_id as fb from posts p
     where p.streamer_id = ${streamer.id}
       and exists (
         select 1 from post_insights i
          where i.post_id = p.id and i.metric_name like 'post_video_%'
            and (i.value_json)::text not in ('0', 'null'))
     limit 1`;

  const [textPost] = await sql<{ fb: string }[]>`
    select p.facebook_post_id as fb from posts p
     where p.streamer_id = ${streamer.id}
       and not exists (
         select 1 from post_insights i
          where i.post_id = p.id and i.metric_name like 'post_video_%'
            and (i.value_json)::text not in ('0', 'null'))
     limit 1`;

  const [video] = await sql<{ fb: string }[]>`
    select facebook_video_id as fb from videos where streamer_id = ${streamer.id} limit 1`;

  console.log(`Graph ${VERSION}\n`);

  for (const [label, post] of [
    ["VIDEO POST", videoPost],
    ["TEXT POST", textPost],
  ] as const) {
    if (!post) {
      console.log(`No ${label.toLowerCase()} found to probe.\n`);
      continue;
    }

    console.log(`${label} ${post.fb} — /insights`);
    for (const metric of POST_CANDIDATES) line(await probe(post.fb, "insights", metric, token));

    console.log(`${label} ${post.fb} — ?fields=`);
    for (const field of FIELD_CANDIDATES) line(await probeField(post.fb, field, token));

    console.log("");
  }

  if (video) {
    console.log(`VIDEO ${video.fb} — /video_insights`);
    for (const metric of VIDEO_CANDIDATES) {
      line(await probe(video.fb, "video_insights", metric, token));
    }
  }
} finally {
  await sql.end();
}
