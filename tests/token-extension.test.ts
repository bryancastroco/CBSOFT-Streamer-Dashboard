import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renewing a Page token before it dies.
 *
 * ## The fact this whole module exists for
 *
 * An expired token cannot be recovered. Meta answers `(190) Session has
 * expired` to every refresh, exchange and re-read, so once a token lapses the
 * only remedy is a human signing into Facebook. That happened here: one Page's
 * token expired mid-project and took that streamer's collection down.
 *
 * So the behaviour under test is mostly about *timing and honesty* — renew
 * while it still works, and when it cannot be renewed, say which of the two
 * situations it is. An operator retrying a button that physically cannot
 * succeed is worse served than one told to go and generate a new token.
 */

const mocks = vi.hoisted(() => ({ graphRequest: vi.fn() }));

vi.mock("@/lib/meta/client", () => ({ graphRequest: mocks.graphRequest }));

const { extendPageToken } = await import("@/lib/meta/token-extension");

const APP = { appId: "app", appSecret: "secret" };

/** `debug_token` reply. `0` is Meta's encoding for "no expiry". */
function debug(expiresAt: number) {
  return { ok: true as const, data: { data: { expires_at: expiresAt, is_valid: true } } };
}

function pageToken(token: string) {
  return { ok: true as const, data: { access_token: token } };
}

function graphError(message: string, code?: number) {
  return {
    ok: false as const,
    error: { category: "auth_error", message, retryable: false, ...(code ? { code } : {}) },
  };
}

const IN_SIXTY_DAYS = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a token that still works", () => {
  it("is replaced with one that never expires", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS)) // current
      .mockResolvedValueOnce(pageToken("permanent-token")) // page re-read
      .mockResolvedValueOnce(debug(0)); // the replacement

    const outcome = await extendPageToken({ token: "old", pageId: "page1", ...APP });

    expect(outcome.status).toBe("extended");
    if (outcome.status !== "extended") return;

    expect(outcome.token).toBe("permanent-token");
    // Null, not a date. The whole point of the exercise.
    expect(outcome.expiresAt).toBeNull();
  });

  it("reads the Page's own token field, not the oauth exchange", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS))
      .mockResolvedValueOnce(pageToken("t"))
      .mockResolvedValueOnce(debug(0));

    await extendPageToken({ token: "old", pageId: "page1", ...APP });

    const paths = mocks.graphRequest.mock.calls.map((call) => call[0]);

    expect(paths).toContain("page1");
    expect(paths).not.toContain("oauth/access_token");
  });
});

describe("a token that is already permanent", () => {
  it("is left alone, and reports the expiry it observed", async () => {
    mocks.graphRequest.mockResolvedValueOnce(debug(0));

    const outcome = await extendPageToken({ token: "already", pageId: "page1", ...APP });

    expect(outcome.status).toBe("unchanged");
    if (outcome.status !== "unchanged") return;

    /*
     * The observed value matters even when nothing is rotated. `token_expires_at`
     * is a cache written at the last validation and it drifts — one Page's
     * column read "28 September" while Meta already treated the token as
     * permanent, so the UI counted down to a deadline that did not exist.
     */
    expect(outcome.expiresAt).toBeNull();
  });

  it("does not call Meta again once it knows there is nothing to do", async () => {
    mocks.graphRequest.mockResolvedValueOnce(debug(0));

    await extendPageToken({ token: "already", pageId: "page1", ...APP });

    // One debug_token call, and no Page read. This runs on every sweep.
    expect(mocks.graphRequest).toHaveBeenCalledTimes(1);
  });
});

describe("a token that has expired", () => {
  it("says a human has to replace it, rather than reporting a generic failure", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS))
      .mockResolvedValueOnce(
        graphError("Error validating access token: Session has expired on Friday.", 190),
      );

    const outcome = await extendPageToken({ token: "dead", pageId: "page1", ...APP });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;

    /*
     * The distinction an operator needs. Retrying does nothing for an expired
     * token — no server-side path recovers one — so the UI must send them to
     * Facebook instead of offering a button that cannot work.
     */
    expect(outcome.needsReauthentication).toBe(true);
  });

  it("does not mistake an ordinary failure for one needing re-authentication", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS))
      .mockResolvedValueOnce(graphError("Please reduce the amount of data you're asking for", 1));

    const outcome = await extendPageToken({ token: "fine", pageId: "page1", ...APP });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;

    expect(outcome.needsReauthentication).toBe(false);
  });
});

describe("refusing a pointless rotation", () => {
  it("keeps the existing token when the replacement is no longer-lived", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS))
      .mockResolvedValueOnce(pageToken("no-better"))
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS));

    const outcome = await extendPageToken({ token: "old", pageId: "page1", ...APP });

    // Rotating a credential for nothing costs audit noise and buys no safety.
    expect(outcome.status).toBe("unchanged");
  });

  it("refuses to store a replacement it could not inspect", async () => {
    mocks.graphRequest
      .mockResolvedValueOnce(debug(IN_SIXTY_DAYS))
      .mockResolvedValueOnce(pageToken("unverifiable"))
      .mockResolvedValueOnce(graphError("temporarily unavailable"));

    const outcome = await extendPageToken({ token: "old", pageId: "page1", ...APP });

    /*
     * Storing a token whose expiry is unknown would replace a credential we
     * understand with one we do not, on the strength of a call that failed.
     */
    expect(outcome.status).toBe("failed");
  });
});
