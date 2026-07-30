"use client";

import { RefreshCw } from "lucide-react";

import { idleState, syncPostsAction } from "@/app/(app)/admin/streamers/actions";
import { ConfirmAction } from "@/components/data/confirm-action";

/**
 * Runs synchronisation inline, so the admin sees the outcome rather than a
 * fire-and-forget confirmation. A Page with a long history can take a while —
 * the button reports progress by staying in its pending state.
 *
 * Behind a confirmation because a sync spends Meta API quota against a shared
 * app rate limit, and because it is slow enough that a stray click is not
 * obviously a stray click.
 */
export function SyncPostsPanel({
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
        action={syncPostsAction}
        initialState={idleState}
        label="Sync Posts"
        pendingLabel="Syncing posts…"
        icon={RefreshCw}
        variant="default"
        disabled={disabled}
        {...(disabledReason ? { disabledReason } : {})}
        title="Collect posts from Meta?"
        description="This fetches every published post and each insight Meta returns for it, spending Meta API quota. Existing posts are updated in place — nothing is duplicated or deleted."
        confirmLabel="Run sync"
        hiddenFields={{ id: streamerId }}
      />

      {!disabledReason ? (
        <p className="max-w-xs text-xs text-muted-foreground">
          Fetches published posts and every insight Meta returns for them.
        </p>
      ) : null}
    </div>
  );
}
