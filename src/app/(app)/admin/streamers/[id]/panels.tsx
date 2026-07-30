"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import {
  deleteStreamerAction,
  idleState,
  replaceTokenAction,
  requestSyncAction,
  setStreamerActiveAction,
  updateStreamerAction,
  validateTokenAction,
  type ActionState,
} from "@/app/(app)/admin/streamers/actions";
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

  useActionToast(replaceState);
  useActionToast(validateState);

  return (
    <div className="space-y-6">
      <form action={validateAction}>
        <input type="hidden" name="id" value={streamerId} />
        <Submit pendingLabel="Checking with Meta…" variant="outline" size="sm">
          {hasToken ? "Validate token now" : "No token to validate"}
        </Submit>
      </form>

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
          Soft delete. The record and its sync history are kept, the streamer is deactivated, and
          the stored Page token is destroyed. The code and Page ID become reusable.
        </p>
      </div>

      <Submit pendingLabel="Deleting…" variant="destructive" size="sm">
        Delete streamer
      </Submit>
    </form>
  );
}
