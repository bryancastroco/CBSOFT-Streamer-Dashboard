import "server-only";

import { AuthorizationError, assertAdmin, assertUser } from "@/lib/auth/guards";
import { can, type Permission } from "@/lib/auth/roles";
import type { CurrentUser } from "@/lib/auth/session";
import type { StreamerFailure } from "@/lib/repositories/streamers";

/**
 * Admin authorisation for Route Handlers.
 *
 * `requireAdmin()` redirects, which is right for a page and wrong for an API:
 * an HTTP client asking for JSON should get 401/403, not a 307 to a login
 * page. This wraps `assertAdmin()` and turns its exception into the correct
 * status.
 *
 * These routes authenticate by session cookie, so they are for the admin UI
 * and for an operator with a browser session — not for n8n, which uses the
 * bearer-secret endpoints under `/api/n8n/*`.
 */

export type AdminGuardResult = { ok: true; user: CurrentUser } | { ok: false; response: Response };

export async function requireApiAdmin(): Promise<AdminGuardResult> {
  try {
    return { ok: true, user: await assertAdmin() };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        response: jsonError(
          error.code === "unauthenticated" ? 401 : 403,
          error.code,
          error.message,
        ),
      };
    }
    throw error;
  }
}

/**
 * Permission check for a Route Handler that is not admin-only.
 *
 * The CSV exports serve viewers too, so they authorise on a capability rather
 * than on a role. Deny-by-default still holds: `can()` reads the same
 * `PERMISSIONS` matrix as every page guard, and a permission that is not granted
 * to a role is refused.
 */
export async function requireApiPermission(permission: Permission): Promise<AdminGuardResult> {
  try {
    const user = await assertUser();

    if (!can(user.role, permission)) {
      return {
        ok: false,
        response: jsonError(403, "forbidden", "Your role does not allow that."),
      };
    }

    return { ok: true, user };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        response: jsonError(
          error.code === "unauthenticated" ? 401 : 403,
          error.code,
          error.message,
        ),
      };
    }
    throw error;
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: unknown,
): Response {
  return Response.json(
    { error: code, message, ...(extra ? { details: extra } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Map a repository failure onto an HTTP status. */
export function statusForFailure(reason: StreamerFailure): number {
  switch (reason) {
    case "not_found":
      return 404;
    case "duplicate_code":
    case "duplicate_page":
      return 409;
    case "already_deleted":
      return 410;
    case "token_rejected":
    case "no_token":
      return 422;
  }
}
