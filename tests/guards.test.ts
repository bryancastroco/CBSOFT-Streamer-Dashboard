import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionResult } from "@/lib/auth/session";

/**
 * `redirect()` in Next.js throws a control-flow error rather than returning.
 * The mock must throw too, otherwise a guard that "redirects" would carry on
 * and return an undefined user — which is exactly the failure mode these tests
 * exist to catch.
 */
class RedirectError extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

const redirectMock = vi.fn((to: string) => {
  throw new RedirectError(to);
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
}));

const getSessionMock = vi.fn<() => Promise<SessionResult>>();

vi.mock("@/lib/auth/session", () => ({
  getSession: () => getSessionMock(),
}));

const {
  AuthorizationError,
  assertAdmin,
  assertPermission,
  assertUser,
  requireAdmin,
  requirePermission,
  requireRole,
  requireUser,
} = await import("@/lib/auth/guards");

const ADMIN: SessionResult = {
  ok: true,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "a@x.test",
    fullName: null,
    role: "admin",
  },
};

const VIEWER: SessionResult = {
  ok: true,
  user: {
    id: "22222222-2222-4222-8222-222222222222",
    email: "v@x.test",
    fullName: null,
    role: "viewer",
  },
};

async function expectRedirect(promise: Promise<unknown>, to: string) {
  await expect(promise).rejects.toBeInstanceOf(RedirectError);
  expect(redirectMock).toHaveBeenCalledWith(to);
}

beforeEach(() => {
  redirectMock.mockClear();
  getSessionMock.mockReset();
});

describe("requireUser", () => {
  it("returns the user when a session exists", async () => {
    getSessionMock.mockResolvedValue(VIEWER);
    await expect(requireUser()).resolves.toMatchObject({ role: "viewer" });
  });

  it("redirects an anonymous visitor to the login page", async () => {
    getSessionMock.mockResolvedValue({ ok: false, reason: "no_session" });
    await expectRedirect(requireUser(), "/login");
  });

  it("redirects an authenticated user with no profile to /unauthorized", async () => {
    getSessionMock.mockResolvedValue({ ok: false, reason: "no_profile" });
    await expectRedirect(requireUser(), "/unauthorized");
  });

  it("redirects when the stored role is not one this build recognises", async () => {
    // Fail closed rather than coercing an unknown role to a default.
    getSessionMock.mockResolvedValue({ ok: false, reason: "invalid_role" });
    await expectRedirect(requireUser(), "/unauthorized");
  });
});

describe("requireAdmin / requireRole", () => {
  it("admits an admin", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    await expect(requireAdmin()).resolves.toMatchObject({ role: "admin" });
  });

  it("refuses a viewer", async () => {
    getSessionMock.mockResolvedValue(VIEWER);
    await expectRedirect(requireAdmin(), "/unauthorized");
  });

  it("refuses an anonymous visitor at the login step, not the role step", async () => {
    getSessionMock.mockResolvedValue({ ok: false, reason: "no_session" });
    await expectRedirect(requireAdmin(), "/login");
  });

  it("enforces an arbitrary role", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    await expectRedirect(requireRole("viewer"), "/unauthorized");
  });
});

describe("requirePermission", () => {
  it("admits an admin to an administrative capability", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    await expect(requirePermission("users.manage")).resolves.toMatchObject({ role: "admin" });
  });

  it("refuses a viewer the administrative capabilities", async () => {
    for (const permission of [
      "users.manage",
      "streamers.manage",
      "tokens.manage",
      "sync.trigger",
    ] as const) {
      getSessionMock.mockResolvedValue(VIEWER);
      redirectMock.mockClear();
      await expectRedirect(requirePermission(permission), "/unauthorized");
    }
  });

  it("admits a viewer to a read capability", async () => {
    getSessionMock.mockResolvedValue(VIEWER);
    await expect(requirePermission("reports.view")).resolves.toMatchObject({ role: "viewer" });
  });
});

describe("assert* guards for Server Actions", () => {
  it("throws unauthenticated when there is no session", async () => {
    getSessionMock.mockResolvedValue({ ok: false, reason: "no_session" });

    await expect(assertUser()).rejects.toBeInstanceOf(AuthorizationError);
    await expect(assertUser()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("throws forbidden when a viewer attempts an admin action", async () => {
    getSessionMock.mockResolvedValue(VIEWER);

    await expect(assertAdmin()).rejects.toBeInstanceOf(AuthorizationError);
    await expect(assertAdmin()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns the actor when an admin attempts an admin action", async () => {
    getSessionMock.mockResolvedValue(ADMIN);
    await expect(assertAdmin()).resolves.toMatchObject({ role: "admin" });
  });

  it("throws rather than redirecting, so a mutation cannot half-succeed", async () => {
    getSessionMock.mockResolvedValue(VIEWER);

    await expect(assertPermission("users.manage")).rejects.toBeInstanceOf(AuthorizationError);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("throws forbidden for an authenticated user with no profile", async () => {
    getSessionMock.mockResolvedValue({ ok: false, reason: "no_profile" });
    await expect(assertUser()).rejects.toMatchObject({ code: "forbidden" });
  });
});
