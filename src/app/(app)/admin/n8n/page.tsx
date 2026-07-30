import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { PlaceholderState } from "@/components/layout/states";
import { requireAdmin } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "n8n integration" };

/**
 * n8n integration — placeholder.
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
        title="n8n integration"
        description="Automation endpoints, the bearer secret's health, and recent workflow calls."
      />
      <PlaceholderState
        title="Not built yet"
        description="Automation endpoints, the bearer secret's health, and recent workflow calls."
        arrivingIn="a later phase"
      />
    </>
  );
}
