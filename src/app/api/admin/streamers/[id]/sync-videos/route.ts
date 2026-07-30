import { jsonError, jsonOk, requireApiAdmin } from "@/lib/api/admin-guard";
import { syncStreamerVideos } from "@/lib/services/sync-videos";
import { streamerIdSchema } from "@/lib/validation/streamers";
import { syncVideosSchema } from "@/lib/validation/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Paging plus one insights call per video. */
export const maxDuration = 300;

/**
 * POST /api/admin/streamers/{id}/sync-videos
 *
 * Collects Page videos and their insights. Reads `/{page-id}/videos` rather
 * than `/live_videos`, which can require separate Meta App Review — ended
 * broadcasts appear on the general edge as VODs.
 *
 * A partially successful run returns 200 with `status: "partial"`: the videos
 * that were collected are real, and reporting the whole run as a failure would
 * hide them.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const parsedId = streamerIdSchema.safeParse(id);
  if (!parsedId.success) return jsonError(400, "invalid_id", "That is not a valid streamer id.");

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = syncVideosSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "validation_failed", "Check the submitted options.", parsed.error.issues);
  }

  const outcome = await syncStreamerVideos({
    actorId: auth.user.id,
    streamerId: parsedId.data,
    ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    ...(parsed.data.maxPages !== undefined ? { maxPages: parsed.data.maxPages } : {}),
    ...(parsed.data.concurrency !== undefined ? { concurrency: parsed.data.concurrency } : {}),
  });

  if (!outcome.ok) {
    const status = outcome.reason === "not_found" ? 404 : outcome.reason === "deleted" ? 410 : 422;
    return jsonError(status, outcome.reason, outcome.message);
  }

  return jsonOk({ sync: outcome.result });
}
