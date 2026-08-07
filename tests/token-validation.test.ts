import { describe, expect, it } from "vitest";

import type { DebugTokenData, GraphMeResponse, GraphResult } from "@/lib/meta/graph";
import {
  EXPIRING_WINDOW_MS,
  REQUIRED_SCOPES,
  deriveTokenStatus,
  tokenNeedsAttention,
  tokenStatusTone,
} from "@/lib/meta/token-status";

/**
 * Token health derivation.
 *
 * `deriveTokenStatus` is pure, so every Meta failure mode is reproducible here
 * exactly — no network, no fixtures that drift, no flakiness.
 */

const PAGE_ID = "102938475610293";
const NOW = new Date("2026-07-29T12:00:00.000Z");

const ALL_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "pages_read_user_content",
  "pages_manage_metadata",
];

function identityOk(id = PAGE_ID, name = "Ana Live"): GraphResult<GraphMeResponse> {
  return { ok: true, data: { id, name } };
}

function debugOk(overrides: Partial<DebugTokenData> = {}): GraphResult<DebugTokenData> {
  return {
    ok: true,
    data: {
      app_id: "1234567890",
      type: "PAGE",
      is_valid: true,
      scopes: ALL_SCOPES,
      expires_at: 0,
      ...overrides,
    },
  };
}

function derive(
  identity: GraphResult<GraphMeResponse>,
  debug: GraphResult<DebugTokenData> | null,
  expectedPageId = PAGE_ID,
) {
  return deriveTokenStatus({ expectedPageId, identity, debug, now: NOW });
}

describe("valid tokens", () => {
  it("reports a healthy non-expiring token as valid", () => {
    const result = derive(identityOk(), debugOk());

    expect(result.status).toBe("valid");
    expect(result.pageId).toBe(PAGE_ID);
    expect(result.pageName).toBe("Ana Live");
    expect(result.missingRequiredScopes).toEqual([]);
    expect(result.expiresAt).toBeNull();
  });

  it("stays valid when only optional scopes are absent", () => {
    const result = derive(identityOk(), debugOk({ scopes: [...REQUIRED_SCOPES] }));

    expect(result.status).toBe("valid");
    // Only the one now. `pages_manage_metadata` was reported here for webhook
    // subscriptions that were never built, and was never requested by the
    // connect flow — so it could only ever be listed as missing. See
    // `tests/token-scopes.test.ts`.
    expect(result.missingRecommendedScopes).toEqual(["pages_read_user_content"]);
    expect(result.message).toContain("Optional permissions not granted");
  });

  it("accepts granular_scopes in place of scopes", () => {
    const result = derive(
      identityOk(),
      debugOk({
        scopes: [],
        granular_scopes: ALL_SCOPES.map((scope) => ({ scope, target_ids: [PAGE_ID] })),
      }),
    );

    expect(result.status).toBe("valid");
  });

  it("reads a far-future expiry without flagging it", () => {
    const farFuture = Math.floor((NOW.getTime() + 90 * 24 * 3600 * 1000) / 1000);
    const result = derive(identityOk(), debugOk({ expires_at: farFuture }));

    expect(result.status).toBe("valid");
    expect(result.expiresAt?.toISOString()).toBe(new Date(farFuture * 1000).toISOString());
  });
});

describe("expiring tokens", () => {
  it("flags a token inside the expiry window", () => {
    const soon = Math.floor((NOW.getTime() + 3 * 24 * 3600 * 1000) / 1000);
    const result = derive(identityOk(), debugOk({ expires_at: soon }));

    expect(result.status).toBe("expiring");
    expect(result.message).toContain("expires on");
  });

  it("does not flag a token just outside the window", () => {
    const later = Math.floor((NOW.getTime() + EXPIRING_WINDOW_MS + 60_000) / 1000);
    expect(derive(identityOk(), debugOk({ expires_at: later })).status).toBe("valid");
  });
});

describe("expired tokens", () => {
  it("detects expiry from the clock", () => {
    const past = Math.floor((NOW.getTime() - 3600_000) / 1000);
    const result = derive(identityOk(), debugOk({ expires_at: past }));

    expect(result.status).toBe("expired");
  });

  it("detects expiry from is_valid=false with subcode 463", () => {
    const result = derive(
      identityOk(),
      debugOk({ is_valid: false, error: { code: 190, subcode: 463, message: "Session expired" } }),
    );

    expect(result.status).toBe("expired");
    expect(result.message).toContain("Session expired");
  });

  it("detects expiry reported by /me as OAuth subcode 463", () => {
    const result = derive(
      {
        ok: false,
        kind: "api_error",
        httpStatus: 400,
        error: {
          message: "Error validating access token: Session has expired",
          type: "OAuthException",
          code: 190,
          error_subcode: 463,
        },
      },
      null,
    );

    expect(result.status).toBe("expired");
    expect(result.message).toContain("expired or revoked");
  });

  it("treats a password change as an expiry, not a generic failure", () => {
    const result = derive(
      {
        ok: false,
        kind: "api_error",
        httpStatus: 400,
        error: { message: "changed password", code: 190, error_subcode: 460 },
      },
      null,
    );

    expect(result.status).toBe("expired");
  });

  it("expired beats missing_permission", () => {
    // An expired token's scope list is moot; reporting scopes would misdirect.
    const past = Math.floor((NOW.getTime() - 3600_000) / 1000);
    const result = derive(identityOk(), debugOk({ expires_at: past, scopes: [] }));

    expect(result.status).toBe("expired");
  });
});

describe("invalid tokens", () => {
  it("rejects a token whose Page ID does not match the entered one", () => {
    const result = derive(identityOk("999999999999999", "Someone Else"), debugOk());

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("999999999999999");
    expect(result.message).toContain(PAGE_ID);
    expect(result.pageId).toBe("999999999999999");
  });

  it("rejects a personal profile token, which can never match a Page ID", () => {
    // A user token resolves to a person on /me. The Page ID comparison is what
    // enforces "Facebook Pages only".
    const result = derive(identityOk("77777777777", "Bryan Castro"), debugOk());

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("not " + PAGE_ID);
  });

  it("rejects a response with no id at all", () => {
    const result = derive({ ok: true, data: { id: "" } }, debugOk());

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("Personal profile tokens are not supported");
  });

  it("reports a generic OAuth rejection as invalid", () => {
    const result = derive(
      {
        ok: false,
        kind: "api_error",
        httpStatus: 400,
        error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 },
      },
      null,
    );

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("Invalid OAuth access token");
  });

  it("reports is_valid=false without an expiry signal as invalid", () => {
    const result = derive(
      identityOk(),
      debugOk({ is_valid: false, error: { code: 190, message: "Token was revoked" } }),
    );

    expect(result.status).toBe("invalid");
  });

  it("does not check the Page ID before checking authentication", () => {
    // A token that cannot authenticate has no Page to compare against.
    const result = derive(
      { ok: false, kind: "api_error", httpStatus: 400, error: { message: "nope", code: 190 } },
      null,
    );

    expect(result.pageId).toBeNull();
  });
});

describe("missing permissions", () => {
  it("flags a token missing a required scope", () => {
    const result = derive(
      identityOk(),
      debugOk({ scopes: ["pages_show_list", "pages_read_engagement"] }),
    );

    expect(result.status).toBe("missing_permission");
    expect(result.missingRequiredScopes).toEqual(["read_insights"]);
    expect(result.message).toContain("read_insights");
  });

  it("lists every missing required scope", () => {
    const result = derive(identityOk(), debugOk({ scopes: [] }));

    expect(result.status).toBe("missing_permission");
    expect(result.missingRequiredScopes).toEqual([...REQUIRED_SCOPES]);
  });

  it("reports missing permission ahead of an approaching expiry", () => {
    const soon = Math.floor((NOW.getTime() + 2 * 24 * 3600 * 1000) / 1000);
    const result = derive(identityOk(), debugOk({ scopes: [], expires_at: soon }));

    expect(result.status).toBe("missing_permission");
  });
});

describe("unknown status", () => {
  it("reports unknown when Meta is unreachable", () => {
    const result = derive({ ok: false, kind: "network_error", message: "timed out" }, null);

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("timed out");
  });

  it("reports unknown when the token works but debug_token fails", () => {
    // Usually a misconfigured META_APP_ID / META_APP_SECRET. The token itself
    // demonstrably works, so calling it invalid would be wrong.
    const result = derive(identityOk(), {
      ok: false,
      kind: "api_error",
      httpStatus: 400,
      error: { message: "Invalid appsecret", code: 1 },
    });

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("META_APP_ID");
  });

  it("reports unknown when the debug call was skipped", () => {
    expect(derive(identityOk(), null).status).toBe("unknown");
  });
});

describe("no message ever carries token material", () => {
  it("keeps every derived message free of the token", () => {
    // deriveTokenStatus takes no token argument at all — this asserts the
    // property holds for the shapes callers actually produce.
    const cases = [
      derive(identityOk(), debugOk()),
      derive(identityOk("999"), debugOk()),
      derive(identityOk(), debugOk({ scopes: [] })),
      derive({ ok: false, kind: "network_error", message: "boom" }, null),
    ];

    for (const result of cases) {
      expect(result.message).not.toMatch(/EAAB/);
      expect(JSON.stringify(result)).not.toMatch(/EAAB/);
    }
  });
});

describe("presentation helpers", () => {
  it("marks the statuses that need an admin to act", () => {
    expect(tokenNeedsAttention("expired")).toBe(true);
    expect(tokenNeedsAttention("invalid")).toBe(true);
    expect(tokenNeedsAttention("missing_permission")).toBe(true);

    expect(tokenNeedsAttention("valid")).toBe(false);
    expect(tokenNeedsAttention("expiring")).toBe(false);
    expect(tokenNeedsAttention("missing")).toBe(false);
    expect(tokenNeedsAttention("unknown")).toBe(false);
  });

  it("gives every status a badge tone", () => {
    for (const status of [
      "missing",
      "valid",
      "expiring",
      "expired",
      "invalid",
      "missing_permission",
      "unknown",
    ] as const) {
      expect(tokenStatusTone(status)).toBeTypeOf("string");
    }
  });
});
