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
  // The exact combined parameter the sync now sends — all or nothing.
  "post_clicks,post_reactions_by_type_total,post_activity_by_action_type,post_video_views,post_video_views_organic,post_video_views_unique,post_video_view_time,post_video_avg_time_watched",
  "post_video_views_unique",
  "post_video_view_time",
  "post_video_views", // control — known good
  "post_video_views_unique",
  "post_video_view_time",
  "post_impressions_unique",
  "post_video_views_3s",
  "post_video_3s_views",
  "post_video_views_10s",
  "post_video_complete_views_30s",
  "post_video_views_by_uploader",
  "post_video_avg_time_watched_unique",
  "post_engaged_users",
  "post_reach",
];

const VIDEO_CANDIDATES = [
  "total_video_views", // control — likely good
  "total_video_views_unique",
  "total_video_3s_views",
  "total_video_3s_views_unique",
  "total_video_10s_views",
  "total_video_impressions_unique",
  "total_video_view_total_time",
  "total_video_avg_time_watched",
  "total_video_complete_views",
  "post_video_views_unique",
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

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });

try {
  const [streamer] = await sql<{ token: string }[]>`
    select encrypted_page_token as token from streamers
     where encrypted_page_token is not null and deleted_at is null and active = true
     limit 1`;

  if (!streamer) throw new Error("No active streamer with a stored token.");
  const token = decryptToken(streamer.token);

  // One video post and one video: the only content these metrics apply to.
  const [post] = await sql<{ fb: string }[]>`
    select p.facebook_post_id as fb from posts p
     where not exists (
       select 1 from post_insights i
        where i.post_id = p.id and i.metric_name like 'post_video_%'
          and (i.value_json)::text <> '0')
     limit 1`;
  const [video] = await sql<{ fb: string }[]>`
    select facebook_video_id as fb from videos limit 1`;

  console.log(`Graph ${VERSION}\n`);

  if (post) {
    console.log(`POST ${post.fb} — /insights`);
    for (const metric of POST_CANDIDATES) {
      const outcome = await probe(post.fb, "insights", metric, token);
      console.log(`  ${outcome.status.padEnd(12)} ${outcome.metric.padEnd(36)} ${outcome.detail}`);
    }
  } else {
    console.log("No video post found to probe.");
  }

  if (video) {
    console.log(`\nVIDEO ${video.fb} — /video_insights`);
    for (const metric of VIDEO_CANDIDATES) {
      const outcome = await probe(video.fb, "video_insights", metric, token);
      console.log(`  ${outcome.status.padEnd(12)} ${outcome.metric.padEnd(36)} ${outcome.detail}`);
    }
  }
} finally {
  await sql.end();
}
