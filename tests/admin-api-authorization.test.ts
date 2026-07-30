import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CurrentUser } from "@/lib/auth/session";

/**
 * Admin authorization for the Phase 3 API surface.
 *
 * The routes are ordinary POST/GET endpoints — a viewer who is signed in can
 * call them directly with fetch. These tests pin the behaviour that matters:
 * a viewer gets 403, an anonymous caller gets 401, and neither gets a body
 * that reveals anything.
 */

const assertAdminMock = vi.fn<() => Promise<CurrentUser>>();

vi.mock("@/lib/auth/guards", async () => {
  // Keep the real AuthorizationError so `instanceof` still works.
  const actual = await vi.importActual<typeof import("@/lib/auth/guards")>("@/lib/auth/guards");
  return { ...actual, assertAdmin: () => assertAdminMock() };
});

const { AuthorizationError } = await import("@/lib/auth/guards");
const { requireApiAdmin, statusForFailure, jsonError, jsonOk } =
  await import("@/lib/api/admin-guard");

const ADMIN: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@cbsoft.test",
  fullName: "Admin",
  role: "admin",
};

beforeEach(() => {
  assertAdminMock.mockReset();
});

describe("requireApiAdmin", () => {
  it("admits an admin and returns the actor", async () => {
    assertAdminMock.mockResolvedValue(ADMIN);

    const result = await requireApiAdmin();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe(ADMIN.id);
  });

  it("returns 403 for a signed-in viewer", async () => {
    assertAdminMock.mockRejectedValue(
      new AuthorizationError("forbidden", "This action requires an administrator."),
    );

    const result = await requireApiAdmin();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toMatchObject({ error: "forbidden" });
  });

  it("returns 401 for an anonymous caller", async () => {
    assertAdminMock.mockRejectedValue(
      new AuthorizationError("unauthenticated", "You must be signed in to do that."),
    );

    const result = await requireApiAdmin();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toMatchObject({ error: "unauthenticated" });
  });

  it("never caches an authorization response", async () => {
    assertAdminMock.mockRejectedValue(new AuthorizationError("forbidden", "no"));

    const result = await requireApiAdmin();
    if (result.ok) return;

    expect(result.response.headers.get("cache-control")).toBe("no-store");
  });

  it("propagates non-authorization failures instead of swallowing them as 403", async () => {
    // A database outage must not be reported to the client as "forbidden".
    assertAdminMock.mockRejectedValue(new Error("connection refused"));

    await expect(requireApiAdmin()).rejects.toThrow("connection refused");
  });
});

describe("failure mapping", () => {
  it("maps every repository failure to a sensible status", () => {
    expect(statusForFailure("not_found")).toBe(404);
    expect(statusForFailure("duplicate_code")).toBe(409);
    expect(statusForFailure("duplicate_page")).toBe(409);
    expect(statusForFailure("already_deleted")).toBe(410);
    expect(statusForFailure("token_rejected")).toBe(422);
    expect(statusForFailure("no_token")).toBe(422);
  });
});

describe("response helpers", () => {
  it("marks every response no-store", async () => {
    expect(jsonOk({ a: 1 }).headers.get("cache-control")).toBe("no-store");
    expect(jsonError(400, "bad", "nope").headers.get("cache-control")).toBe("no-store");
  });

  it("includes details only when supplied", async () => {
    await expect(jsonError(422, "validation_failed", "bad").json()).resolves.toEqual({
      error: "validation_failed",
      message: "bad",
    });
  });
});
