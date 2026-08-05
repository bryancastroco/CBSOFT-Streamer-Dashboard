"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import {
  deleteStreamerAction,
  purgeStreamerAction,
  replaceTokenAction,
  requestSyncAction,
  setStreamerActiveAction,
  updateStreamerAction,
  extendTokenAction,
  validateTokenAction,
} from "@/app/(app)/admin/streamers/actions";
import { idleState, type ActionState } from "@/lib/forms/action-state";
import { purgeConfirmationFor } from "@/lib/validation/streamers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/** Surfaces action results as toasts, so every panel reports consistently. */
function useActionToast(state: ActionState) {
  useEffect(() => {
    if (!state.message) return;
    if (state.status === "success") toast.success(state.message);
    if (state.status === "error") toast.error(state.message);
  }, [state]);
}

function Submit({
  children,
  pendingLabel,
  variant = "default",
  size = "default",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  size?: "default" | "sm";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

// ---------------------------------------------------------------------------

export function EditStreamerPanel({
  streamer,
}: {
  streamer: {
    id: string;
    streamerName: string;
    streamerCode: string;
    pageId: string;
    pageName: string;
    notes: string | null;
    active: boolean;
  };
}) {
  const [state, formAction] = useActionState(updateStreamerAction, idleState);
  useActionToast(state);

  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={streamer.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="edit-name">Streamer name</Label>
          <Input id="edit-name" name="streamerName" defaultValue={streamer.streamerName} required />
          {errors["streamerName"] ? (
            <p className="text-xs text-destructive">{errors["streamerName"]}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="edit-code">Streamer code</Label>
          <Input
            id="edit-code"
            name="streamerCode"
            defaultValue={streamer.streamerCode}
            className="font-mono"
            required
          />
          {errors["streamerCode"] ? (
            <p className="text-xs text-destructive">{errors["streamerCode"]}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="edit-page-id">Facebook Page ID</Label>
          <Input
            id="edit-page-id"
            name="pageId"
            defaultValue={streamer.pageId}
            className="font-mono"
            required
          />
          <p className="text-xs text-muted-foreground">
            Changing this does not re-check the stored token. Validate it afterwards.
          </p>
          {errors["pageId"] ? <p className="text-xs text-destructive">{errors["pageId"]}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="edit-page-name">Facebook Page name</Label>
          <Input id="edit-page-name" name="pageName" defaultValue={streamer.pageName} required />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-notes">Notes</Label>
        <Textarea id="edit-notes" name="notes" rows={3} defaultValue={streamer.notes ?? ""} />
      </div>

      <div className="flex items-center gap-3">
        <Switch id="edit-active" name="active" defaultChecked={streamer.active} />
        <Label htmlFor="edit-active" className="font-normal">
          Active
        </Label>
      </div>

      <Submit pendingLabel="Saving…">Save changes</Submit>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function TokenPanel({ streamerId, hasToken }: { streamerId: string; hasToken: boolean }) {
  const [replaceState, replaceAction] = useActionState(replaceTokenAction, idleState);
  const [validateState, validateAction] = useActionState(validateTokenAction, idleState);
  const [extendState, extendAction] = useActionState(extendTokenAction, idleState);

  useActionToast(replaceState);
  useActionToast(validateState);
  useActionToast(extendState);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <form action={validateAction}>
          <input type="hidden" name="id" value={streamerId} />
          <Submit pendingLabel="Checking with Meta…" variant="outline" size="sm">
            {hasToken ? "Validate token now" : "No token to validate"}
          </Submit>
        </form>

        {hasToken ? (
          <form action={extendAction}>
            <input type="hidden" name="id" value={streamerId} />
            <Submit pendingLabel="Asking Meta…" variant="outline" size="sm">
              Extend token
            </Submit>
          </form>
        ) : null}
      </div>

      {hasToken ? (
        <p className="text-xs text-muted-foreground">
          Extending swaps this token for a non-expiring one. It only works while the current token
          is still valid — once a token expires, Meta refuses every renewal path and a replacement
          has to be generated from Facebook by hand. The nightly sweep does this automatically.
        </p>
      ) : null}

      <form action={replaceAction} className="space-y-3 border-t pt-6">
        <input type="hidden" name="id" value={streamerId} />

        <div className="space-y-2">
          <Label htmlFor="replace-token">
            {hasToken ? "Replace Page access token" : "Add Page access token"}
          </Label>
          <Input
            id="replace-token"
            name="pageAccessToken"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the new token"
            required
          />
          <p className="text-xs text-muted-foreground">
            Validated against Meta first. A token belonging to a different Page is refused. The old
            token is overwritten and cannot be recovered.
          </p>
        </div>

        <Submit pendingLabel="Validating and saving…" variant="outline" size="sm">
          {hasToken ? "Replace token" : "Save token"}
        </Submit>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SyncPanel({ streamerId, disabled }: { streamerId: string; disabled: boolean }) {
  const [state, formAction] = useActionState(requestSyncAction, idleState);
  useActionToast(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={streamerId} />
      <Button type="submit" variant="outline" size="sm" disabled={disabled}>
        Queue manual sync
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function ActiveTogglePanel({ streamerId, active }: { streamerId: string; active: boolean }) {
  const [state, formAction] = useActionState(setStreamerActiveAction, idleState);
  useActionToast(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={streamerId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <Submit pendingLabel="Saving…" variant="outline" size="sm">
        {active ? "Disable streamer" : "Enable streamer"}
      </Submit>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function DeletePanel({
  streamerId,
  streamerCode,
}: {
  streamerId: string;
  streamerCode: string;
}) {
  const [state, formAction] = useActionState(deleteStreamerAction, idleState);
  useActionToast(state);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="id" value={streamerId} />
      <input type="hidden" name="streamerCode" value={streamerCode} />

      <div className="space-y-2">
        <Label htmlFor="confirm-delete">
          Type <span className="font-mono font-semibold">{streamerCode}</span> to confirm
        </Label>
        <Input
          id="confirm-delete"
          name="confirm"
          autoComplete="off"
          className="font-mono"
          required
        />
        <p className="text-xs text-muted-foreground">
          The posts, videos, comments and analyses stay in the system and keep appearing in
          historical reports. The streamer leaves the roster, stops syncing, and its stored Page
          token is destroyed. The code and Page ID become reusable.
        </p>
      </div>

      <Submit pendingLabel="Removing…" variant="outline" size="sm">
        Remove from roster
      </Submit>
    </form>
  );
}

// ---------------------------------------------------------------------------

/**
 * Permanent deletion, with the size of the loss stated before the decision.
 *
 * The counts are the point. "Delete this streamer" and "delete forty thousand
 * comments that Meta will not serve again" are the same click, and only the
 * first is what the wording suggests. Nothing here is recoverable — Meta's
 * insight retention window has long passed for older content.
 */
export function PurgePanel({
  streamerId,
  streamerCode,
  footprint,
}: {
  streamerId: string;
  streamerCode: string;
  footprint: {
    posts: number;
    videos: number;
    comments: number;
    summaries: number;
    postInsights: number;
    videoInsights: number;
    canonicalMetrics: number;
    syncRuns: number;
  };
}) {
  const [state, formAction] = useActionState(purgeStreamerAction, idleState);
  useActionToast(state);

  const phrase = purgeConfirmationFor(streamerCode);
  const format = new Intl.NumberFormat("en-GB");

  const rows: { label: string; value: number }[] = [
    { label: "Posts", value: footprint.posts },
    { label: "Videos", value: footprint.videos },
    { label: "Comments", value: footprint.comments },
    { label: "Comment analyses", value: footprint.summaries },
    { label: "Post insights", value: footprint.postInsights },
    { label: "Video insights", value: footprint.videoInsights },
    { label: "Canonical metrics", value: footprint.canonicalMetrics },
    { label: "Sync runs", value: footprint.syncRuns },
  ];

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="id" value={streamerId} />
      <input type="hidden" name="streamerCode" value={streamerCode} />

      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-xs font-medium">
          {format.format(total)} row{total === 1 ? "" : "s"} will be destroyed
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-mono">{format.format(row.value)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-purge">
          Type <span className="font-mono font-semibold">{phrase}</span> to confirm
        </Label>
        <Input
          id="confirm-purge"
          name="confirm"
          autoComplete="off"
          className="font-mono"
          placeholder={phrase}
          required
        />
        <p className="text-xs text-muted-foreground">
          This cannot be undone and there is no backup. Meta will not re-serve insights for older
          content, so anything deleted here is gone even if the Page is re-added. Only the audit
          entry recording this deletion survives.
        </p>
      </div>

      <Submit pendingLabel="Deleting…" variant="destructive" size="sm">
        Permanently delete everything
      </Submit>
    </form>
  );
}
