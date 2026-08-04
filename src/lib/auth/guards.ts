import "server-only";

import { redirect } from "next/navigation";

import { can, type Permission, type UserRole } from "@/lib/auth/roles";
import { LOGIN_PATH, UNAUTHORIZED_PATH } from "@/lib/auth/route-policy";
import { getSession, type CurrentUser } from "@/lib/auth/session";

/**
 * Server-side authorisation.
 *
 * Two families, because pages and mutations need different failure modes:
 *
 *   requireX()  — for pages and layouts. Redirects, so the user lands
 *                 somewhere sensible.
 *   assertX()   — for Server Actions and Route Handlers. Throws, because a
 *                 mutation must fail loudly rather than quietly redirect.
 *
 * Every protected page calls one of these. Middleware already made the same
 * decision, but middleware is a convenience gate: matcher changes, rewrites and
 * direct Server Action invocations can all bypass it. These cannot be bypassed,
 * because they run inside the operation itself.
 */

export class AuthorizationError extends Error {
  readonly code: "unauthenticated" | "forbidden";

  constructor(code: "unauthenticated" | "forbidden", message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Page and layout guards — redirect on failure
// ---------------------------------------------------------------------------

/** Any signed-in user with a provisioned profile. */
export async function requireUser(): Promise<CurrentUser> {
  const result = await getSession();

  if (result.ok) return result.user;

  if (result.reason === "no_session") {
    redirect(LOGIN_PATH);
  }

  /*
   * Deactivated accounts are told which of the two situations they are in.
   * "Not authorised" invites someone to keep trying; "switched off" tells them
   * to talk to an administrator, which is the only thing that will help.
   */
  if (result.reason === "deactivated") {
    redirect(`${UNAUTHORIZED_PATH}?reason=deactivated`);
  }

  // Authenticated but not provisioned, or holding a role this build does not
  // recognise. Both are "you are someone, but not someone we can authorise".
  redirect(UNAUTHORIZED_PATH);
}

export async function requireRole(role: UserRole): Promise<CurrentUser> {
  const user = await requireUser();

  if (user.role !== role) {
    redirect(UNAUTHORIZED_PATH);
  }

  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  return requireRole("admin");
}

export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();

  if (!can(user.role, permission)) {
    redirect(UNAUTHORIZED_PATH);
  }

  return user;
}

// ---------------------------------------------------------------------------
// Mutation guards — throw on failure
// ---------------------------------------------------------------------------

export async function assertUser(): Promise<CurrentUser> {
  const result = await getSession();

  if (result.ok) return result.user;

  if (result.reason === "no_session") {
    throw new AuthorizationError("unauthenticated", "You must be signed in to do that.");
  }

  if (result.reason === "deactivated") {
    throw new AuthorizationError(
      "forbidden",
      "This account has been deactivated. An administrator can restore it.",
    );
  }

  throw new AuthorizationError("forbidden", "Your account is not authorised for this workspace.");
}

export async function assertAdmin(): Promise<CurrentUser> {
  const user = await assertUser();

  if (user.role !== "admin") {
    throw new AuthorizationError("forbidden", "This action requires an administrator.");
  }

  return user;
}

export async function assertPermission(permission: Permission): Promise<CurrentUser> {
  const user = await assertUser();

  if (!can(user.role, permission)) {
    throw new AuthorizationError("forbidden", "You do not have permission to do that.");
  }

  return user;
}
