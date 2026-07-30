import "server-only";

import type { NotImplementedResponse } from "@/types";

/**
 * A `501 Not Implemented` response used by every endpoint that is scaffolded
 * but not yet built. This keeps the API surface discoverable — n8n workflows
 * can be wired and their auth verified now — while making it unambiguous that
 * no real data is being served.
 */
export function notImplemented(endpoint: string, phase: number, message: string): Response {
  const body: NotImplementedResponse = {
    error: "not_implemented",
    phase,
    endpoint,
    message,
  };

  return Response.json(body, {
    status: 501,
    headers: { "cache-control": "no-store" },
  });
}
