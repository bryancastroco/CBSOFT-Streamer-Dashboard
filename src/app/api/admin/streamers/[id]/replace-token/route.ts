import { jsonError, jsonOk, requireApiAdmin, statusForFailure } from "@/lib/api/admin-guard";
import { replaceStreamerToken } from "@/lib/repositories/streamers";
import { replaceTokenSchema, streamerIdSchema } from "@/lib/validation/streamers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/streamers/{id}/replace-token
 *
 * Accepts a new Page access token, validates it against Meta, and stores it as
 * AES-256-GCM ciphertext plus its last four characters.
 *
 * A token whose Page ID does not match the streamer's is refused with 422 —
 * storing it would silently attach the wrong Page's credential.
 *
 * The submitted token appears nowhere in the response, and nowhere in the
 * audit entry beyond its last four characters.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsedId = streamerIdSchema.safeParse(id);
  if (!parsedId.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = replaceTokenSchema.safeParse(body);
  if (!parsed.success) {
    // Only the issue messages — never the submitted value, which is the token.
    return jsonError(
      422,
      "validation_failed",
      parsed.error.issues[0]?.message ?? "That does not look like a Page access token.",
    );
  }

  const outcome = await replaceStreamerToken({
    actorId: auth.user.id,
    id: parsedId.data,
    token: parsed.data.pageAccessToken,
  });

  if (!outcome.ok) {
    return jsonError(statusForFailure(outcome.reason), outcome.reason, outcome.message);
  }

  return jsonOk({
    streamer: outcome.data.streamer,
    tokenValidation: outcome.data.validation,
  });
}
