import { describe, expect, it } from "vitest";

import { CONNECT_SCOPES } from "@/lib/meta/oauth";
import {
  EXPECTED_SCOPES,
  RECOMMENDED_SCOPES,
  REQUIRED_SCOPES,
} from "@/lib/meta/token-status";

/**
 * The permissions the dashboard reports on, and the ones it asks for.
 *
 * These are two lists in two modules and they drifted. `pages_manage_metadata`
 * sat in the reported set for webhook subscriptions that were never built,
 * while nothing ever requested it — so every connected Page showed a permission
 * marked unsatisfied, forever, next to four that an admin can actually act on.
 *
 * The streamer could not have granted it either. It is not on the consent
 * dialog, because we do not ask; and asking would contradict what the connect
 * page promises them, since `manage` is a write permission on a screen that
 * says nothing is posted or changed.
 */

describe("what the dashboard reports and what the flow requests", () => {
  it("reports no permission the connect flow does not ask for", () => {
    const requested = new Set<string>(CONNECT_SCOPES);
    const unaskable = EXPECTED_SCOPES.filter((scope) => !requested.has(scope));

    /*
     * The failure this pins. A scope here is one an admin will be told is
     * missing and no streamer can supply, because it never reaches the consent
     * dialog. Adding one is only correct alongside adding it to
     * `CONNECT_SCOPES` — and that decision has to be weighed against the
     * read-only promise the connect page makes.
     */
    expect(unaskable).toEqual([]);
  });

  it("does not ask for a write permission", () => {
    // The connect page tells an outside streamer that nothing is posted or
    // changed. Every scope requested has to be readable as consistent with
    // that sentence by somebody who is not obliged to trust us.
    const writeish = CONNECT_SCOPES.filter(
      (scope) => scope.includes("manage") || scope.includes("publish"),
    );

    expect(writeish).toEqual([]);
  });

  it("keeps the three the sync engine genuinely cannot run without", () => {
    // Losing one of these silently would turn a hard failure into an empty
    // dashboard, so they are named rather than derived.
    expect([...REQUIRED_SCOPES]).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
    ]);
  });

  it("still expects the one that comment analysis actually needs", () => {
    // Recommended rather than required on purpose: a token without it syncs
    // posts and videos fine and only loses comment text.
    expect([...RECOMMENDED_SCOPES]).toContain("pages_read_user_content");
  });

  it("has no duplicates once required and recommended are combined", () => {
    expect(new Set(EXPECTED_SCOPES).size).toBe(EXPECTED_SCOPES.length);
  });
});
