"use client";

import { MessagesSquare, RefreshCw } from "lucide-react";

import {
  regenerateVideoSummaryAction,
  syncVideoCommentsAction,
} from "@/app/(app)/videos/[id]/actions";
import { idleState as idleVideoCommentState } from "@/lib/forms/action-state";
import { ConfirmAction } from "@/components/data/confirm-action";

/**
 * Admin controls for video comment collection and analysis.
 *
 * Both are confirmed first: collecting spends Meta quota, and either can spend
 * Anthropic tokens. Regeneration is the deliberate, admin-initiated one of the
 * three conditions under which the AI is called at all, so asking is consistent
 * with treating it as deliberate.
 */
export function VideoCommentActions({
  videoId,
  hasSummary,
}: {
  videoId: string;
  hasSummary: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmAction
        action={syncVideoCommentsAction}
        initialState={idleVideoCommentState}
        label="Sync comments"
        pendingLabel="Collecting…"
        icon={MessagesSquare}
        variant="default"
        title="Collect comments for this video?"
        description="Fetches comments from Meta, then analyses them only if the set has changed. Commenter names are never requested. If nothing changed, no AI call is made and nothing is charged."
        confirmLabel="Collect"
        hiddenFields={{ videoId }}
      />

      {hasSummary ? (
        <ConfirmAction
          action={regenerateVideoSummaryAction}
          initialState={idleVideoCommentState}
          label="Regenerate summary"
          pendingLabel="Analysing…"
          icon={RefreshCw}
          title="Re-run the analysis?"
          description="Re-analyses the comments already stored, bypassing the unchanged-comments gate. This always spends Anthropic tokens, and does not fetch anything new from Meta."
          confirmLabel="Regenerate"
          hiddenFields={{ videoId }}
        />
      ) : null}
    </div>
  );
}
