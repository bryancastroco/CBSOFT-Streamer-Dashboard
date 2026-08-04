import { describe, expect, it } from "vitest";

import { isAccountUnavailable } from "@/lib/ai/anthropic";

/**
 * Telling a billing problem apart from a bad request.
 *
 * Its own file because  mocks the whole Anthropic
 * module to drive the fallback paths, which would replace the very function
 * under test here.
 */

describe("REGRESSION: an exhausted balance is not a malformed request", () => {
  /*
   * Anthropic returns both as HTTP 400 with type `invalid_request_error`, so the
   * message is the only thing separating them. Classifying the billing case as
   * `invalid_request` marked it non-retryable, which meant the offline fallback
   * declined to run and the reader was shown "Analysis failed" for a problem
   * that had nothing to do with their comments.
   */
  it("recognises the wording Anthropic actually sends", () => {
    expect(
      isAccountUnavailable(
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    ).toBe(true);
  });

  it.each([
    "insufficient credits remaining",
    "You have exceeded your quota",
    "billing is not configured for this organisation",
    "payment method required",
  ])("recognises %s", (message) => {
    expect(isAccountUnavailable(message)).toBe(true);
  });

  it("leaves a genuine request bug classified as one", () => {
    /*
     * The narrowness is the point. If this matched loosely, a real schema
     * mistake would be hidden behind a local analysis and never fixed.
     */
    expect(isAccountUnavailable("messages: Input should be a valid list")).toBe(false);
    expect(isAccountUnavailable("max_tokens: must be greater than 0")).toBe(false);
    expect(isAccountUnavailable("model: unknown model claude-nonexistent")).toBe(false);
  });
});
