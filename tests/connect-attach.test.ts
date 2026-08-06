import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import type { TokenValidation } from "@/lib/meta/token-status";

import { createTestDatabase } from "./helpers/test-database";

/**
 * Storing a Page token that a streamer granted themselves.
 *
 * `streamers.page_id` is unique among live rows, so the interesting cases are
 * the ones where the choice collides with the roster. Each would otherwise be
 * an unhandled constraint violation — which reaches the streamer as a crashed
 * page and records nothing, so nobody learns it happened.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { attachConnectedPageToken } = await import("@/lib/repositories/streamers");

let client: PGlite;

/** A token Meta accepted and that matches the Page it claims. */
const VALID: TokenValidation = {
  status: "valid",
  pageId: "446757269470389",
  pageName: "GM Blade",
  scopes: ["pages_show_list", "pages_read_engagement"],
  missingRequiredScopes: [],
  missingRecommendedScopes: [],
  // Null, not a date: a Page token derived from a long-lived user token carries
  // no expiry, which is the whole reason the callback extends before storing.
  expiresAt: null,
  message: "Token is valid.",
};

async function seedStreamer(code: string, pageId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ($1, $2, $3, $4) returning id`,
    [code, `${code} name`, pageId, `${code} Page`],
  );
  return row.rows[0]!.id;
}

async function tokenOf(id: string) {
  const row = await client.query<{
    page_id: string;
    page_name: string;
    page_token_last_four: string | null;
    token_status: string;
  }>(
    `select page_id, page_name, page_token_last_four, token_status from streamers where id = $1`,
    [id],
  );
  return row.rows[0]!;
}

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");
});

describe("attaching a self-service Page token", () => {
  it("creates a streamer when the Page is new", async () => {
    const result = await attachConnectedPageToken({
      streamerId: null,
      fallbackName: "GM Blade",
      pageId: "446757269470389",
      pageName: "GM Blade",
      token: "a-page-token-1234",
      validation: VALID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await tokenOf(result.streamerId);
    expect(stored.page_id).toBe("446757269470389");
    expect(stored.token_status).toBe("valid");
    // The suffix, never the token — the same evidence a pasted one leaves.
    expect(stored.page_token_last_four).toBe("1234");
  });

  it("updates the existing streamer when that Page is already on the roster", async () => {
    /*
     * The common mistake: an admin sends a link to somebody whose Page was
     * added manually months ago and forgets to tick "attach to existing
     * streamer". A second row for the same Page is not creatable, and would be
     * wrong even if it were.
     */
    const existing = await seedStreamer("BLADE", "446757269470389");

    const result = await attachConnectedPageToken({
      streamerId: null,
      fallbackName: "GM Blade",
      pageId: "446757269470389",
      pageName: "GM Blade Renamed",
      token: "a-page-token-5678",
      validation: VALID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.streamerId).toBe(existing);
    expect(await tokenOf(existing)).toMatchObject({
      page_token_last_four: "5678",
      page_name: "GM Blade Renamed",
    });

    const count = await client.query<{ n: number }>(
      `select count(*)::int as n from streamers where deleted_at is null`,
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("refuses a Page that is not the one the invitation was for", async () => {
    /*
     * Storing Page Y's token against a streamer whose page_id is X passes here
     * and then fails every later validation, because validation compares the
     * token to the stored Page id. Repointing the streamer instead would orphan
     * every post already collected under X. Refusing is the only safe answer.
     */
    const target = await seedStreamer("BLADE", "111111111");

    const result = await attachConnectedPageToken({
      streamerId: target,
      fallbackName: "GM Blade",
      pageId: "999999999",
      pageName: "Some Other Page",
      token: "a-page-token-9999",
      validation: VALID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.message).toContain("different Page");
    // Nothing written: the streamer keeps whatever it had.
    expect((await tokenOf(target)).page_token_last_four).toBeNull();
  });

  it("lets a soft-deleted streamer's Page be reconnected", async () => {
    // The unique index is partial on `deleted_at is null`, so a retired record
    // must not block somebody reconnecting the same Page later.
    const removed = await seedStreamer("OLD", "446757269470389");
    await client.query(`update streamers set deleted_at = now() where id = $1`, [removed]);

    const result = await attachConnectedPageToken({
      streamerId: null,
      fallbackName: "GM Blade",
      pageId: "446757269470389",
      pageName: "GM Blade",
      token: "a-page-token-4321",
      validation: VALID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streamerId).not.toBe(removed);
  });

  it("records the connection with a null actor", async () => {
    // The streamer is not a dashboard user. Attributing this to whichever admin
    // sent the link would record something that did not happen.
    const result = await attachConnectedPageToken({
      streamerId: null,
      fallbackName: "GM Blade",
      pageId: "446757269470389",
      pageName: "GM Blade",
      token: "a-page-token-1234",
      validation: VALID,
    });

    expect(result.ok).toBe(true);

    const entry = await client.query<{ user_id: string | null; metadata_json: unknown }>(
      `select user_id, metadata_json from audit_logs where action = 'token.added'
        order by created_at desc limit 1`,
    );

    expect(entry.rows[0]!.user_id).toBeNull();
    expect(entry.rows[0]!.metadata_json).toMatchObject({ via: "self_service_connection" });
  });
});
