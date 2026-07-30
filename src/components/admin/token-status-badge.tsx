import { Badge } from "@/components/ui/badge";
import { TOKEN_STATUS_LABELS, tokenStatusTone, type TokenStatus } from "@/lib/meta/token-status";

/** One consistent rendering of token health across the admin screens. */
export function TokenStatusBadge({ status }: { status: TokenStatus }) {
  return <Badge variant={tokenStatusTone(status)}>{TOKEN_STATUS_LABELS[status]}</Badge>;
}
