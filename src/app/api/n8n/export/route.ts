import { authenticateMachineRequest, machineAuthErrorResponse } from "@/lib/security/machine-auth";
import { EXPORT_DATASETS } from "@/lib/google-sheets/export-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * n8n → application: superseded by `/api/automation/exports/*`.
 *
 * This was the Phase 1 placeholder for a single "export" endpoint. Phase 8
 * replaced it with seven dataset endpoints, because one endpoint returning
 * whichever shape a `dataset` parameter asked for cannot have a stable column
 * contract — and a stable column contract is the whole point when the
 * destination is a spreadsheet.
 *
 * It still authenticates before answering, so an operator testing a credential
 * against the old path gets `401` for a wrong secret rather than a confusing
 * `410`. With a valid secret it returns `410 Gone` and the replacement paths;
 * a redirect would be worse, because n8n's HTTP Request node follows redirects
 * silently and the workflow would keep working against a URL nobody updated.
 */
export async function GET(request: Request) {
  const auth = authenticateMachineRequest(request, "n8n");

  if (!auth.ok) {
    return machineAuthErrorResponse(auth);
  }

  return Response.json(
    {
      ok: false,
      error: "endpoint_replaced",
      message:
        "This endpoint has been replaced by the per-dataset automation exports. " +
        "See docs/N8N-AUTOMATION.md.",
      replacements: EXPORT_DATASETS.map(
        (dataset) => `/api/automation/exports/${dataset.replace(/_/g, "-")}`,
      ),
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
