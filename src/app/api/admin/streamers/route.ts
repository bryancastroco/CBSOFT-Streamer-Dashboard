import { jsonError, jsonOk, requireApiAdmin, statusForFailure } from "@/lib/api/admin-guard";
import { createStreamer, listStreamers } from "@/lib/repositories/streamers";
import { createStreamerSchema, listStreamersQuerySchema } from "@/lib/validation/streamers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/streamers — list the roster.
 *
 * Returns `StreamerView` objects, which carry `maskedToken` and
 * `pageTokenLastFour` and have no field capable of holding a token.
 */
export async function GET(request: Request) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parsed = listStreamersQuerySchema.safeParse({
    includeDeleted: url.searchParams.get("includeDeleted") ?? undefined,
    activeOnly: url.searchParams.get("activeOnly") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
  });

  if (!parsed.success) {
    return jsonError(400, "invalid_query", "Invalid query parameters.", parsed.error.issues);
  }

  const rows = await listStreamers(parsed.data);
  return jsonOk({ streamers: rows, count: rows.length });
}

/**
 * POST /api/admin/streamers — add a streamer.
 *
 * When a token is supplied it is validated against Meta before anything is
 * written, encrypted with AES-256-GCM, and stored as ciphertext plus its last
 * four characters. The plaintext is never persisted and never echoed back.
 */
export async function POST(request: Request) {
  const auth = await requireApiAdmin();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }

  const parsed = createStreamerSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "validation_failed", "Check the submitted fields.", parsed.error.issues);
  }

  const outcome = await createStreamer({ actorId: auth.user.id, input: parsed.data });

  if (!outcome.ok) {
    return jsonError(statusForFailure(outcome.reason), outcome.reason, outcome.message);
  }

  return jsonOk({ streamer: outcome.data.streamer, tokenValidation: outcome.data.validation }, 201);
}
