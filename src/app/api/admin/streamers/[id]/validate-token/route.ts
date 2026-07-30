import { jsonError, jsonOk, requireApiAdmin, statusForFailure } from "@/lib/api/admin-guard";
import { validateStreamerToken } from "@/lib/repositories/streamers";
import { streamerIdSchema } from "@/lib/validation/streamers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/streamers/{id}/validate-token
 *
 * Re-checks the stored token against the Meta Graph API and records the
 * verdict on the streamer. Takes no body — the token comes from the database,
 * never from the request, so this endpoint cannot be used to probe an
 * arbitrary token.
 *
 * The response carries the health verdict and the scopes, never the token.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsedId = streamerIdSchema.safeParse(id);
  if (!parsedId.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  const outcome = await validateStreamerToken({ actorId: auth.user.id, id: parsedId.data });

  if (!outcome.ok) {
    return jsonError(statusForFailure(outcome.reason), outcome.reason, outcome.message);
  }

  return jsonOk({
    streamer: outcome.data.streamer,
    tokenValidation: outcome.data.validation,
  });
}
