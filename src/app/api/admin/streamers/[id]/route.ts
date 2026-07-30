import { jsonError, jsonOk, requireApiAdmin, statusForFailure } from "@/lib/api/admin-guard";
import {
  getStreamerById,
  listSyncRunsForStreamer,
  softDeleteStreamer,
  updateStreamer,
} from "@/lib/repositories/streamers";
import { streamerIdSchema, updateStreamerSchema } from "@/lib/validation/streamers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function readId(context: RouteContext) {
  const { id } = await context.params;
  return streamerIdSchema.safeParse(id);
}

/** GET /api/admin/streamers/{id} — one streamer, plus recent sync runs. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const id = await readId(context);
  if (!id.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  const streamer = await getStreamerById(id.data);
  if (!streamer) return jsonError(404, "not_found", "No such streamer.");

  const syncRuns = await listSyncRunsForStreamer(id.data);

  return jsonOk({ streamer, syncRuns });
}

/**
 * PATCH /api/admin/streamers/{id} — edit details, or enable/disable.
 *
 * The Page token is not editable here. Replacing a credential goes through
 * `/replace-token` so it is always a distinct, separately audited act.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const id = await readId(context);
  if (!id.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = updateStreamerSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "validation_failed", "Check the submitted fields.", parsed.error.issues);
  }

  const outcome = await updateStreamer({
    actorId: auth.user.id,
    id: id.data,
    input: parsed.data,
  });

  if (!outcome.ok) {
    return jsonError(statusForFailure(outcome.reason), outcome.reason, outcome.message);
  }

  return jsonOk({ streamer: outcome.data });
}

/**
 * DELETE /api/admin/streamers/{id} — soft delete.
 *
 * Sets `deleted_at`, deactivates the row and destroys the stored token. The
 * record itself is retained so sync history stays meaningful.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const id = await readId(context);
  if (!id.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  const outcome = await softDeleteStreamer({ actorId: auth.user.id, id: id.data });

  if (!outcome.ok) {
    return jsonError(statusForFailure(outcome.reason), outcome.reason, outcome.message);
  }

  return jsonOk({ deleted: outcome.data });
}
