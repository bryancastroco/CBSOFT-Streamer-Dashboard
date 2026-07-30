import { describe, expect, it } from "vitest";

import {
  META_ERROR_CATEGORIES,
  META_ERROR_LABELS,
  indicatesTokenProblem,
  normalizeGraphApiError,
  normalizeTransportError,
  normalizeUnknownError,
} from "@/lib/meta/errors";

/**
 * Error normalisation is pure, so every Meta failure mode is reproducible here
 * exactly — the real codes, from the real documentation, without HTTP.
 */

describe("token errors", () => {
  it("maps a plain OAuth rejection to invalid_token", () => {
    const result = normalizeGraphApiError(
      { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 },
      400,
    );

    expect(result.category).toBe("invalid_token");
    expect(result.retryable).toBe(false);
  });

  it.each([
    [458, "app not installed"],
    [459, "user checkpointed"],
    [460, "password changed"],
    [463, "session expired"],
    [464, "unconfirmed user"],
    [467, "session invalidated"],
  ])("maps OAuth subcode %i to expired_token", (subcode) => {
    const result = normalizeGraphApiError(
      { message: "Session issue", code: 190, error_subcode: subcode },
      400,
    );

    expect(result.category).toBe("expired_token");
    expect(result.retryable).toBe(false);
  });

  it("never retries a token failure", () => {
    // Retrying with a dead credential burns quota and delays real feedback.
    for (const subcode of [undefined, 463]) {
      const result = normalizeGraphApiError({ code: 190, error_subcode: subcode }, 400);
      expect(result.retryable).toBe(false);
    }
  });
});

describe("rate limiting", () => {
  it.each([4, 17, 32, 613])("maps code %i to rate_limited", (code) => {
    const result = normalizeGraphApiError({ message: "Too many calls", code }, 400);

    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("maps business-use-case throttling to rate_limited", () => {
    for (const code of [80000, 80004, 80014]) {
      expect(normalizeGraphApiError({ code }, 400).category).toBe("rate_limited");
    }
  });

  it("does not treat an adjacent code as throttling", () => {
    expect(normalizeGraphApiError({ code: 79999 }, 400).category).not.toBe("rate_limited");
    expect(normalizeGraphApiError({ code: 80015 }, 400).category).not.toBe("rate_limited");
  });
});

describe("permissions", () => {
  it("maps code 10 to missing_permission", () => {
    const result = normalizeGraphApiError({ message: "Permission denied", code: 10 }, 403);

    expect(result.category).toBe("missing_permission");
    expect(result.retryable).toBe(false);
  });

  it("maps the 200-299 band to missing_permission", () => {
    for (const code of [200, 210, 299]) {
      expect(normalizeGraphApiError({ code }, 403).category).toBe("missing_permission");
    }
  });
});

describe("availability", () => {
  it("distinguishes a missing page from missing content by context", () => {
    const envelope = { message: "Unsupported get request.", code: 100, error_subcode: 33 };

    expect(normalizeGraphApiError(envelope, 400, "page").category).toBe("page_unavailable");
    expect(normalizeGraphApiError(envelope, 400, "content").category).toBe("content_unavailable");
  });

  it("maps code 803 to unavailability", () => {
    expect(normalizeGraphApiError({ code: 803 }, 400, "page").category).toBe("page_unavailable");
  });

  it("treats code 100 without subcode 33 as a malformed request, not unavailability", () => {
    // A bad field name is our bug, and retrying identically cannot fix it.
    const result = normalizeGraphApiError({ message: "Invalid field", code: 100 }, 400, "page");

    expect(result.category).toBe("meta_api_error");
    expect(result.retryable).toBe(false);
  });
});

describe("generic and transport failures", () => {
  it("retries Meta 5xx but not Meta 4xx", () => {
    expect(normalizeGraphApiError({ code: 1, message: "oops" }, 500).retryable).toBe(true);
    expect(normalizeGraphApiError({ code: 1, message: "oops" }, 400).retryable).toBe(false);
  });

  it("retries the transient internal error code 2", () => {
    expect(normalizeGraphApiError({ code: 2, message: "temporary" }, 400).retryable).toBe(true);
  });

  it("classifies a timeout as a retryable network_error", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";

    const result = normalizeTransportError(timeout);

    expect(result.category).toBe("network_error");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("timed out");
  });

  it("classifies a connection failure as a retryable network_error", () => {
    const result = normalizeTransportError(new Error("ECONNRESET"));

    expect(result.category).toBe("network_error");
    expect(result.retryable).toBe(true);
  });

  it("falls back to unknown_error for an empty envelope", () => {
    expect(normalizeGraphApiError({}, 418).category).toBe("unknown_error");
  });

  it("does not retry an unknown non-Meta failure", () => {
    expect(normalizeUnknownError(new Error("boom")).retryable).toBe(false);
  });
});

describe("message selection", () => {
  it("prefers Meta's user-facing message when present", () => {
    const result = normalizeGraphApiError(
      {
        message: "technical",
        error_user_msg: "Your Page is unpublished.",
        code: 100,
        error_subcode: 33,
      },
      400,
      "page",
    );

    expect(result.message).toBe("Your Page is unpublished.");
  });

  it("carries the trace id through for support tickets", () => {
    const result = normalizeGraphApiError({ code: 190, fbtrace_id: "AbC123" }, 400);
    expect(result.fbtraceId).toBe("AbC123");
  });
});

describe("taxonomy completeness", () => {
  it("labels every category", () => {
    for (const category of META_ERROR_CATEGORIES) {
      expect(META_ERROR_LABELS[category]).toBeTypeOf("string");
    }
  });

  it("declares exactly the nine specified categories", () => {
    expect([...META_ERROR_CATEGORIES]).toEqual([
      "invalid_token",
      "expired_token",
      "missing_permission",
      "rate_limited",
      "page_unavailable",
      "content_unavailable",
      "network_error",
      "meta_api_error",
      "unknown_error",
    ]);
  });

  it("flags only the categories an admin can act on", () => {
    expect(indicatesTokenProblem("invalid_token")).toBe(true);
    expect(indicatesTokenProblem("expired_token")).toBe(true);
    expect(indicatesTokenProblem("missing_permission")).toBe(true);

    expect(indicatesTokenProblem("rate_limited")).toBe(false);
    expect(indicatesTokenProblem("network_error")).toBe(false);
    expect(indicatesTokenProblem("page_unavailable")).toBe(false);
  });
});
