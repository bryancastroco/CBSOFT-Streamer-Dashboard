import { StatusBadge } from "@/components/ui/status-badge";
import type { TokenStatus } from "@/lib/meta/token-status";

/**
 * Token health, rendered by the one status system.
 *
 * This used to carry its own tone mapping onto a plain `Badge`, which made an
 * expired token look different here from everywhere else and gave colour as
 * the only cue. `StatusBadge` supplies the wording, the icon and the tone from
 * `src/lib/ui/status.ts`, keyed by the same database enum this prop already
 * holds — so the two cannot drift apart.
 */
export function TokenStatusBadge({ status }: { status: TokenStatus }) {
  return <StatusBadge domain="token" status={status} />;
}
