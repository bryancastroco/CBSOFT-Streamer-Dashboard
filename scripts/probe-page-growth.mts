import { createDecipheriv } from "node:crypto";

import postgres from "postgres";

/**
 * Ask Meta what it will actually tell us about a Page's audience size.
 *
 * ## Why this exists before any code
 *
 * The project's own rule, learned the hard way on post insights: never add a
 * metric name without probing it. One invalid name fails an entire insights
 * request, and a field documented in a retrieval map is not the same thing as a
 * field this Page, this token and this API version will answer.
 *
 * Follower growth needs two separate answers and they come from different
 * places:
 *
 *   the current count  — a Page *field*, one number, no history
 *   the change over time — a Page *insight*, a daily series
 *
 * If the insight edge works, growth is available retrospectively and no
 * snapshot table is needed for the past. If it does not, growth can only be
 * built forward from counts we record ourselves, and the honest first version
 * shows nothing until it has been running a few days. That is the decision this
 * probe is here to settle.
 *
 * Read-only. Prints names, values and Meta's own errors — never the token.
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
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unrecognised token envelope");

  const key = /^[0-9a-fA-F]{64}$/.test(TOKEN_KEY!)
    ? Buffer.from(TOKEN_KEY!, "hex")
    : Buffer.from(TOKEN_KEY!, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return (
    decipher.update(Buffer.from(ciphertext, "base64url")).toString("utf8") + decipher.final("utf8")
  );
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });

const [streamer] = await sql<{ code: string; page_id: string; token: string }[]>`
  select streamer_code as code, page_id, encrypted_page_token as token
    from streamers
   where encrypted_page_token is not null
     and token_status not in ('expired', 'invalid', 'missing', 'missing_permission')
     and deleted_at is null
   limit 1
`;

if (!streamer) {
  console.error("No streamer with a usable token. A dead token answers every probe identically.");
  await sql.end();
  process.exit(1);
}

const token = decryptToken(streamer.token);
console.log(`Probing ${streamer.code} (page ${streamer.page_id}) on ${VERSION}\n`);

const base = `https://graph.facebook.com/${VERSION}`;

// ---- 1. Page fields: the current number -----------------------------------
console.log("--- Page fields (current count, no history) ---");

for (const field of ["followers_count", "fan_count", "new_like_count", "talking_about_count"]) {
  const url = `${base}/${streamer.page_id}?fields=${field}&access_token=${encodeURIComponent(token)}`;
  const body = (await (await fetch(url)).json()) as Record<string, unknown> & {
    error?: { message?: string };
  };

  if (body.error) console.log(`  ${field.padEnd(22)} REJECTED  ${body.error.message}`);
  else console.log(`  ${field.padEnd(22)} ${JSON.stringify(body[field])}`);
}

// ---- 2. Page insights: the series -----------------------------------------
console.log("\n--- Page insights (a daily series, if available) ---");

const since = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
const until = Math.floor(Date.now() / 1000);

for (const metric of [
  "page_fans",
  "page_follows",
  "page_daily_follows",
  "page_daily_follows_unique",
  "page_fan_adds",
  "page_fan_adds_unique",
  "page_fan_removes",
  "page_impressions",
  "page_impressions_unique",
  "page_views_total",
]) {
  const url =
    `${base}/${streamer.page_id}/insights?metric=${metric}&period=day` +
    `&since=${since}&until=${until}&access_token=${encodeURIComponent(token)}`;

  const body = (await (await fetch(url)).json()) as {
    data?: { name?: string; values?: { value?: unknown; end_time?: string }[] }[];
    error?: { message?: string };
  };

  if (body.error) {
    console.log(`  ${metric.padEnd(26)} REJECTED  ${body.error.message}`);
    continue;
  }

  const values = body.data?.[0]?.values ?? [];
  const withData = values.filter((v) => v.value !== undefined && v.value !== null);

  const sample = withData.at(-1);
  console.log(
    `  ${metric.padEnd(26)} OK  ${withData.length}/${values.length} points` +
      (sample ? `  latest ${JSON.stringify(sample.value)} @ ${sample.end_time?.slice(0, 10)}` : ""),
  );
}

await sql.end();
