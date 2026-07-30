import { describe, expect, it } from "vitest";

import { buildLogRecord, redact } from "@/lib/observability/logger";

/**
 * The logger is the last place a secret can escape: a Graph URL carries the
 * access token in its query string, so anything that logs one must be scrubbed.
 * These tests pin the redaction rules.
 */

const FAKE_TOKEN = "EAABwzLixnjYBO1ZCfakepagetokenforunittests9f2Q";
const FAKE_CIPHERTEXT = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSJ9.11rGbUddTFPFk9pJWrfU9DK";

describe("secret-named fields", () => {
  it.each([
    "access_token",
    "input_token",
    "token",
    "page_access_token",
    "encrypted_page_token",
    "password",
    "secret",
    "api_key",
    "authorization",
    "cookie",
  ])("redacts the field %s wholesale", (key) => {
    const output = redact({ [key]: "anything at all" }) as Record<string, unknown>;
    expect(output[key]).toBe("[redacted]");
  });

  it("is case insensitive", () => {
    const output = redact({ Access_Token: "x", TOKEN: "y" }) as Record<string, unknown>;
    expect(output["Access_Token"]).toBe("[redacted]");
    expect(output["TOKEN"]).toBe("[redacted]");
  });

  it("leaves innocuous fields untouched", () => {
    const output = redact({ tokenStatus: "valid", postsProcessed: 12 }) as Record<string, unknown>;

    expect(output["tokenStatus"]).toBe("valid");
    expect(output["postsProcessed"]).toBe(12);
  });
});

describe("secret-shaped values", () => {
  it("redacts a Meta token wherever it appears", () => {
    const output = redact({ note: `failed with ${FAKE_TOKEN} attached` }) as Record<
      string,
      unknown
    >;

    expect(output["note"]).not.toContain(FAKE_TOKEN);
    expect(output["note"]).toContain("[redacted-token]");
  });

  it("redacts our own ciphertext envelope", () => {
    const output = redact({ note: FAKE_CIPHERTEXT }) as Record<string, unknown>;
    expect(output["note"]).toBe("[redacted-ciphertext]");
  });

  it("redacts a JWT", () => {
    const output = redact({ note: FAKE_JWT }) as Record<string, unknown>;
    expect(output["note"]).toBe("[redacted-jwt]");
  });

  it("redacts credentials carried in a URL query string", () => {
    const url = `https://graph.facebook.com/v25.0/me?fields=id&access_token=${FAKE_TOKEN}`;
    const output = redact({ url }) as Record<string, unknown>;

    expect(output["url"]).not.toContain(FAKE_TOKEN);
    expect(output["url"]).toContain("access_token=[redacted]");
    // The useful part of the URL survives.
    expect(output["url"]).toContain("graph.facebook.com/v25.0/me");
  });

  it("redacts input_token and client_secret in a URL too", () => {
    const url = `https://graph.facebook.com/debug_token?input_token=${FAKE_TOKEN}&client_secret=abc123def456`;
    const output = redact({ url }) as string extends never ? never : Record<string, unknown>;

    expect(output["url"]).toContain("input_token=[redacted]");
    expect(output["url"]).toContain("client_secret=[redacted]");
  });
});

describe("nested structures", () => {
  it("scrubs deeply nested values", () => {
    const output = redact({
      run: { streamer: { credentials: { access_token: FAKE_TOKEN } } },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

    expect(output["run"]?.["streamer"]?.["credentials"]?.["access_token"]).toBe("[redacted]");
  });

  it("scrubs values inside arrays", () => {
    const output = redact({ errors: [{ message: `bad ${FAKE_TOKEN}` }] }) as {
      errors: { message: string }[];
    };

    expect(output.errors[0]?.message).not.toContain(FAKE_TOKEN);
  });

  it("reduces an Error to name and message, scrubbing the message", () => {
    const output = redact(new Error(`request failed for ${FAKE_TOKEN}`)) as {
      name: string;
      message: string;
    };

    expect(output.name).toBe("Error");
    expect(output.message).not.toContain(FAKE_TOKEN);
  });

  it("truncates rather than recursing without bound", () => {
    // Guards against a cyclic-ish or pathologically deep payload.
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };

    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
  });
});

describe("log records", () => {
  it("carries level, event and an ISO timestamp", () => {
    const record = buildLogRecord("info", "sync.started", { streamerCode: "CBS-001" });

    expect(record.level).toBe("info");
    expect(record.event).toBe("sync.started");
    expect(record["streamerCode"]).toBe("CBS-001");
    expect(() => new Date(record.timestamp).toISOString()).not.toThrow();
  });

  it("scrubs fields before they are ever emitted", () => {
    const record = buildLogRecord("error", "graph.request.failed", {
      url: `https://graph.facebook.com/v25.0/me?access_token=${FAKE_TOKEN}`,
      access_token: FAKE_TOKEN,
    });

    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("EAAB");
  });
});

/**
 * The credential shapes that reach a log by a route the key check cannot see.
 *
 * Each of these is on the phase's never-log list, and each arrives as free text
 * inside some other field — typically an error message — rather than under a
 * key named after the secret. The key pattern is blind to that; only the value
 * scan catches it.
 */
describe("credentials embedded in free text", () => {
  it("strips the password from a database URL but keeps the host", () => {
    // The real shape: postgres.js puts the connection string into the message
    // of a connection error, under a key called `error`.
    const line = JSON.stringify(
      redact({
        error:
          "connect ECONNREFUSED postgresql://postgres:hunter2@db.abcdef.supabase.co:5432/postgres",
      }),
    );

    expect(line).not.toContain("hunter2");
    // Still diagnosable — the point of redacting rather than dropping.
    expect(line).toContain("db.abcdef.supabase.co");
  });

  it("redacts a Supabase secret key, which is not a JWT", () => {
    const line = JSON.stringify(
      redact({ note: "used sb_secret_9N7jYuqmj24Sf7I1cwJTQz35NDbfc here" }),
    );

    expect(line).not.toContain("sb_secret_9N7");
    expect(line).toContain("[redacted-supabase-key]");
  });

  it("redacts an Anthropic API key", () => {
    const line = JSON.stringify(redact({ detail: "401 from sk-ant-api03-AAAAAAAAAAAAAAAA" }));

    expect(line).not.toContain("sk-ant-api03-AAAA");
  });

  it("redacts a database url under its own key name", () => {
    const line = JSON.stringify(redact({ DATABASE_URL: "postgresql://u:p@h/db" }));

    expect(line).not.toContain("postgresql://u:p");
  });
});
