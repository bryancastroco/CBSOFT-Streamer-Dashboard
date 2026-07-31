"use client";

import { Video } from "lucide-react";

import { syncVideosAction } from "@/app/(app)/admin/streamers/actions";
import { idleState } from "@/lib/forms/action-state";
import { ConfirmAction } from "@/components/data/confirm-action";

/**
 * Runs video synchronisation inline, so the admin sees the outcome.
 *
 * Reads the Page's `/videos` edge — ended live broadcasts appear there as VODs,
 * which avoids the separate Meta App Review that `/live_videos` can require.
 */
export function SyncVideosPanel({
  streamerId,
  disabled,
  disabledReason,
}: {
  streamerId: string;
  disabled: boolean;
  disabledReason: string | null;
}) {
  return (
    <div className="space-y-2">
      <ConfirmAction
        action={syncVideosAction}
        initialState={idleState}
        label="Sync Videos"
        pendingLabel="Syncing videos…"
        icon={Video}
        variant="default"
        disabled={disabled}
        {...(disabledReason ? { disabledReason } : {})}
        title="Collect videos from Meta?"
        description="This fetches the Page's videos and each insight Meta returns for them, spending Meta API quota. Existing videos are updated in place — nothing is duplicated or deleted."
        confirmLabel="Run sync"
        hiddenFields={{ id: streamerId }}
      />

      {!disabledReason ? (
        <p className="max-w-xs text-xs text-muted-foreground">
          Ended live broadcasts appear here as VODs.
        </p>
      ) : null}
    </div>
  );
}
