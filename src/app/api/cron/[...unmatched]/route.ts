import type { NextRequest } from "next/server";

import { machineRouteNotFound } from "@/lib/automation/not-found";

/**
 * Catch-all for `/api/cron/*` paths that match no real route.
 *
 * Without this, Next renders the HTML not-found page and returns **200**, which
 * tells an automation client the call succeeded. See
 * `src/lib/automation/not-found.ts` for why that is the expensive failure.
 *
 * Every method is answered, because a typo is just as likely on a POST as on a
 * GET and a 405 would be a misleading answer to a path that does not exist.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handle(request: NextRequest) {
  return machineRouteNotFound(request, new URL(request.url).pathname);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
