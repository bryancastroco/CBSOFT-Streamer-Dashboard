import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INVITATION_TTL_DAYS,
  effectiveStatus,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  isUsable,
  tokenHashesMatch,
  unusableReason,
  userTokenHoldExpiry,
} from "@/lib/connect/invitations";
import { resolveRouteAccess } from "@/lib/auth/route-policy";

/**
 * Source with comments stripped.
 *
 * The assertions below are about what the code *does*, and the prose beside it
 * names exactly what it must not do — that explanation is most of the value, so
 * matching the raw file would fail on the reasoning rather than the behaviour.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * The invitation link, and what it is allowed to do.
 *
 * The link is a bearer credential handed to somebody outside the organisation,
 * so the properties worth pinning are the ones that bound it: unguessable, not
 * recoverable from the database, and dead after a fixed window.
 */

describe("the invitation token", () => {
  it("carries enough entropy to be unguessable", () => {
    const token = generateInvitationToken();

    // 32 bytes in base64url is 43 characters with no padding. A uuid would be
    // 36 and generated for uniqueness rather than secrecy — the distinction
    // that matters when the value is the only thing guarding the endpoint.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(200);
  });

  it("survives being pasted into a URL untouched", () => {
    // base64url exists precisely so this holds. A `+` or `/` from standard
    // base64 would be mangled by a chat client or a redirect.
    for (let i = 0; i < 50; i += 1) {
      const token = generateInvitationToken();
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it("hashes deterministically, and the hash does not contain the token", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);

    expect(hashInvitationToken(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it("compares hashes without leaking a length", () => {
    const hash = hashInvitationToken("a");

    expect(tokenHashesMatch(hash, hash)).toBe(true);
    expect(tokenHashesMatch(hash, hashInvitationToken("b"))).toBe(false);
    // A length mismatch must return false rather than throwing — the throw
    // would itself be an observable difference.
    expect(tokenHashesMatch(hash, "short")).toBe(false);
  });
});

describe("expiry", () => {
  const now = new Date("2026-08-06T12:00:00Z");

  it("gives a link a fortnight", () => {
    const expiry = invitationExpiry(now);
    const days = (expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);

    expect(days).toBe(INVITATION_TTL_DAYS);
  });

  it("holds the user token for minutes, not days", () => {
    const held = userTokenHoldExpiry(now);
    const minutes = (held.getTime() - now.getTime()) / 60_000;

    // The credential is parked only while the streamer picks a Page. Anything
    // approaching the sixty days Meta grants would be a stored credential with
    // no remaining purpose.
    expect(minutes).toBe(15);
    expect(held.getTime()).toBeLessThan(invitationExpiry(now).getTime());
  });
});

describe("what an invitation is right now", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  const future = new Date("2026-08-20T12:00:00Z");
  const past = new Date("2026-08-01T12:00:00Z");

  it("reports expiry without anything having written it", () => {
    // Derived rather than stored: a stored `expired` needs a job to set it, and
    // until that job runs the table disagrees with the clock.
    expect(effectiveStatus({ status: "pending", expiresAt: past, now })).toBe("expired");
    expect(effectiveStatus({ status: "opened", expiresAt: past, now })).toBe("expired");
  });

  it("lets both terminal states outrank expiry", () => {
    // A spent link is spent, not stale, and a revoked one was ended
    // deliberately — both are more useful to show than "expired".
    expect(effectiveStatus({ status: "connected", expiresAt: past, now })).toBe("connected");
    expect(effectiveStatus({ status: "revoked", expiresAt: past, now })).toBe("revoked");
  });

  it("passes through the live states", () => {
    expect(effectiveStatus({ status: "pending", expiresAt: future, now })).toBe("pending");
    expect(effectiveStatus({ status: "opened", expiresAt: future, now })).toBe("opened");
  });

  it("treats an unknown status as pending rather than as usable-by-accident", () => {
    expect(effectiveStatus({ status: "something-else", expiresAt: future, now })).toBe("pending");
  });

  it("allows exactly the two states that can still connect a Page", () => {
    expect(isUsable({ status: "pending", expiresAt: future, now })).toBe(true);
    expect(isUsable({ status: "opened", expiresAt: future, now })).toBe(true);

    expect(isUsable({ status: "connected", expiresAt: future, now })).toBe(false);
    expect(isUsable({ status: "revoked", expiresAt: future, now })).toBe(false);
    expect(isUsable({ status: "pending", expiresAt: past, now })).toBe(false);
  });

  it("expires on the boundary rather than after it", () => {
    expect(isUsable({ status: "pending", expiresAt: now, now })).toBe(false);
  });

  it("explains itself without naming internals", () => {
    for (const state of ["connected", "expired", "revoked"] as const) {
      const reason = unusableReason(state);

      expect(reason.length).toBeGreaterThan(0);
      // Read by somebody outside the organisation. No ids, no jargon, no
      // mention of the credential machinery behind it.
      expect(reason).not.toMatch(/token|invitation id|uuid|hash/i);
    }
  });
});

describe("the public connect surface", () => {
  it("is reachable without a session", () => {
    // These people have no account and never will. Requiring one would mean
    // creating a dashboard user for everyone we want a Page from.
    expect(resolveRouteAccess("/connect/abc123")).toBe("public");
    expect(resolveRouteAccess("/api/connect/abc123/start")).toBe("public");
    expect(resolveRouteAccess("/api/connect/callback")).toBe("public");
  });

  it("does not open anything else", () => {
    // The prefix is narrow on purpose — `resolveRouteAccess` matches by
    // `/`-delimited prefix, and a neighbour starting with the same letters
    // must not inherit public access.
    expect(resolveRouteAccess("/admin/connections")).toBe("admin");
    expect(resolveRouteAccess("/dashboard")).toBe("authenticated");
    expect(resolveRouteAccess("/connections")).toBe("authenticated");
  });
});

/**
 * The button that starts the Facebook sign-in.
 *
 * ## The failure this guards against
 *
 * It disabled itself from the button's `onClick`. React flushes state from a
 * click synchronously, so the submitter became `disabled` before the browser
 * reached the click's default action — and a disabled submitter cancels form
 * submission. The request was never made.
 *
 * Nothing threw. The label changed to "Opening Facebook…" and stayed there,
 * which reads as a slow network, or Facebook being down, or a CSP still
 * misconfigured — every explanation except the real one. The only proof was
 * server-side: `opened_at` still null on the invitation, because the route that
 * writes it never ran.
 *
 * A source assertion rather than a rendered test, because reproducing it needs
 * a real browser performing a real form submission — jsdom does not implement
 * navigation, so a DOM test would pass against the broken version.
 */
describe("the connect button submits its form", () => {
  it("never disables the submitter before the browser can act on it", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/app/connect/[token]/page-picker.tsx"),
      "utf8",
    );

    const bare = code(source);
    const start = bare.indexOf("export function ConnectButton");
    const end = bare.indexOf("function Submit(");
    const button = bare.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    // `useFormStatus` reports pending only once submission is under way, so the
    // other forms in this codebase can disable safely. This one cannot: its
    // pending state comes from the click itself.
    expect(button).not.toMatch(/disabled=\{[^}]*pending/);
    expect(button).not.toContain("onClick");
  });

  it("marks itself busy from the submit event, which cannot be cancelled", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/app/connect/[token]/page-picker.tsx"),
      "utf8",
    );

    const button = source.slice(
      source.indexOf("export function ConnectButton"),
      source.indexOf("function Submit("),
    );

    expect(button).toContain("onSubmit");
    // Pointer-events, not `disabled`: it guards a double click without being
    // able to interfere with a submission already in flight.
    expect(button).toContain("pointer-events-none");
  });
});
