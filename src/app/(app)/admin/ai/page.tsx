import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { PlaceholderState } from "@/components/layout/states";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "AI settings" };

/**
 * AI settings — placeholder.
 *
 * The navigation structure for Phase 16 names this screen, so the route exists
 * and is guarded. It renders nothing that pretends to be data: a mock panel
 * here would be indistinguishable from a real one that had broken.
 *
 * `requireAdmin()` runs even though there is nothing to protect yet, so the
 * guard is already in place when the content arrives rather than being
 * remembered later.
 */
export default async function Page() {
  await requireAdmin();

  return (
    <>
      <PageHeader
        title="AI settings"
        description="Comment summarisation provider, model and per-item limits."
      />
      <PlaceholderState
        title="Not built yet"
        description="Comment summarisation provider, model and per-item limits."
        arrivingIn="a later phase"
      />
    </>
  );
}
