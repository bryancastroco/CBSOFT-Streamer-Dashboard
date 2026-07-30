import "server-only";

import { AuthorizationError, assertUser } from "@/lib/auth/guards";
import type { CurrentUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/api/admin-guard";

/**
 * Authentication for Route Handlers that any signed-in role may call.
 *
 * The post endpoints are readable by viewers — that is the whole point of the
 * viewer role — so they need authentication without the admin requirement.
 * Anonymous callers still get 401, and an authenticated account with no
 * profile still gets 403.
 */
export type UserGuardResult = { ok: true; user: CurrentUser } | { ok: false; response: Response };

export async function requireApiUser(): Promise<UserGuardResult> {
  try {
    return { ok: true, user: await assertUser() };
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
