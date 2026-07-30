import "server-only";

import { getServerEnvSafe } from "@/config/env";
import { secureCompare } from "@/lib/crypto/tokens";

/**
 * Authentication for non-browser callers: n8n workflows and Vercel Cron.
 *
 * These callers have no Supabase session, so they present a shared secret in
 * the `Authorization: Bearer <secret>` header. Two distinct secrets are used so
 * that rotating one does not disturb the other, and so an n8n compromise cannot
 * invoke cron-only endpoints.
 *
 * This module authenticates the *caller*. It grants no access to Page tokens —
 * those never leave the server regardless of who is calling.
 */

export type MachineCaller = "n8n" | "cron";

export type MachineAuthResult =
  { ok: true; caller: MachineCaller } | { ok: false; status: 401 | 500; reason: string };

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;

  const value = rest.join(" ").trim();
  return value.length > 0 ? value : null;
}

/**
 * Verify that a request carries a valid secret for the given caller.
 * Returns a discriminated result rather than throwing, so route handlers can
 * decide the response shape.
 */
export function authenticateMachineRequest(
  request: Request,
  caller: MachineCaller,
): MachineAuthResult {
  const env = getServerEnvSafe();

  if (!env.ok) {
    return {
      ok: false,
      status: 500,
      reason: "Server is not configured for machine authentication",
    };
  }

  const presented = extractBearer(request);

  if (!presented) {
    return { ok: false, status: 401, reason: "Missing bearer credentials" };
  }

  const expected = caller === "n8n" ? env.env.N8N_API_SECRET : env.env.CRON_SECRET;

  if (!secureCompare(presented, expected)) {
    return { ok: false, status: 401, reason: "Invalid credentials" };
  }

  return { ok: true, caller };
}

/** Standard error body for machine endpoints — deliberately terse. */
export function machineAuthErrorResponse(result: Extract<MachineAuthResult, { ok: false }>) {
  return Response.json(
    { error: result.reason },
    {
      status: result.status,
      headers: { "cache-control": "no-store" },
    },
  );
}
