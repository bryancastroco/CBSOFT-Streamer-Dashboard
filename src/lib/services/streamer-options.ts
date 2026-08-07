import "server-only";

import { listStreamerOptions, type StreamerOption } from "@/lib/repositories/streamers";

/**
 * Streamer choices for a filter bar.
 *
 * A pass-through, and deliberately so. The shared video library lives under
 * `src/app` rather than in a route file, and a component may not import a
 * repository — by lint rule, and by `server-only` underneath it. Everything it
 * needs therefore arrives through a service, and this is the thin one.
 *
 * The alternative was threading the list down from both pages as a prop, which
 * makes the two routes responsible for a detail neither of them cares about.
 */
export async function listStreamerFilterOptions(): Promise<StreamerOption[]> {
  return listStreamerOptions();
}
