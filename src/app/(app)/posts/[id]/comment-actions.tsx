"use client";

import { MessagesSquare, RefreshCw } from "lucide-react";

import {
  idleCommentState,
  regenerateSummaryAction,
  syncCommentsAction,
} from "@/app/(app)/posts/[id]/actions";
import { ConfirmAction } from "@/components/data/confirm-action";

/**
 * Admin controls for comment collection and analysis.
 *
 * Rendered only for admins — the page passes `isAdmin`. The server actions
 * re-check regardless; this only avoids showing a viewer a button that would
 * refuse them.
 *
 * Both are confirmed first: collecting spends Meta quota, and either can spend
 * Anthropic tokens.
 */
export function CommentActions({ postId, hasSummary }: { postId: string; hasSummary: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ConfirmAction
        action={syncCommentsAction}
        initialState={idleCommentState}
        label="Sync comments"
        pendingLabel="Collecting…"
        icon={MessagesSquare}
        variant="default"
        title="Collect comments for this post?"
        description="Fetches comments from Meta, then analyses them only if the set has changed. Commenter names are never requested. If nothing changed, no AI call is made and nothing is charged."
        confirmLabel="Collect"
        hiddenFields={{ postId }}
      />

      {hasSummary ? (
        <ConfirmAction
          action={regenerateSummaryAction}
          initialState={idleCommentState}
          label="Regenerate summary"
          pendingLabel="Analysing…"
          icon={RefreshCw}
          title="Re-run the analysis?"
          description="Re-analyses the comments already stored, bypassing the unchanged-comments gate. This always spends Anthropic tokens, and does not fetch anything new from Meta."
          confirmLabel="Regenerate"
          hiddenFields={{ postId }}
        />
      ) : null}
    </div>
  );
}
