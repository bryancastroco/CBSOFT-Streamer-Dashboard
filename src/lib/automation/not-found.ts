import "server-only";

import { NextResponse } from "next/server";

import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/observability/request-id";

/**
 * A JSON 404 for a machine path that does not exist.
 *
 * ## Why this exists at all
 *
 * `resolveRouteAccess` classifies `/api/automation`, `/api/n8n` and `/api/cron`
 * by prefix, so any path under them is treated as a machine endpoint and handed
 * straight to Next. When no route file matches, Next renders the application's
 * HTML not-found page — and served this way it comes back **200 text/html**.
 *
 * That is the worst possible answer for an automation client. A typo in an n8n
 * base URL or endpoint yields `200 OK`, the HTTP node reports success, the
 * export node finds no `rows`, and the Sheet nodes are configured to continue
 * on error. The result is a green workflow run and a spreadsheet that silently
 * never changed — the failure mode that takes days to notice because every
 * indicator says fine.
 *
 * A caller that gets a 404 with a JSON body stops instead.
 *
 * ## Why a catch-all route rather than a check in the proxy
 *
 * Listing the valid paths in the proxy would duplicate the route tree, and the
 * copy would drift the first time someone adds an endpoint. Next resolves
 * static and dynamic segments ahead of catch-alls, so a real route always wins
 * and this only answers what nothing else claimed. Nothing to keep in sync.
 */
export function machineRouteNotFound(request: Request, pathname: string): NextResponse {
  const requestId = resolveRequestId(request);

  return NextResponse.json(
    {
      error: "not_found",
      message: `No automation endpoint exists at ${pathname}. Check the path against docs/N8N-PRODUCTION-WORKFLOW.md.`,
      request_id: requestId,
    },
    {
      status: 404,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        // Never let a negative answer be cached; a route added later must not
        // keep returning 404 from an edge cache.
        "Cache-Control": "no-store",
      },
    },
  );
}
