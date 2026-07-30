import { authenticateMachineRequest, machineAuthErrorResponse } from "@/lib/security/machine-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * n8n → application: superseded by `/api/automation/sync-all`.
 *
 * The Phase 1 placeholder. Kept so that a credential configured against the old
 * path still fails in the informative order — `401` for a wrong secret, `410`
 * with the replacement for a valid one — rather than a bare 404 that tells an
 * operator nothing about which of the two is wrong.
 *
 * Not a redirect: n8n's HTTP Request node follows redirects silently, and a
 * workflow that keeps working against a retired URL is a workflow nobody
 * updates.
 */
export async function POST(request: Request) {
  const auth = authenticateMachineRequest(request, "n8n");

  if (!auth.ok) {
    return machineAuthErrorResponse(auth);
  }

  return Response.json(
    {
      ok: false,
      error: "endpoint_replaced",
      message:
        "This endpoint has been replaced. Use POST /api/automation/sync-all, then poll " +
        "GET /api/automation/sync-runs/{id}. See docs/N8N-AUTOMATION.md.",
      replacements: ["/api/automation/sync-all", "/api/automation/sync-streamer/{id}"],
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
