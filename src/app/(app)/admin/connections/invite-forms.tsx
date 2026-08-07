"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Copy, Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  createInvitationAction,
  revokeInvitationAction,
} from "@/app/(app)/admin/connections/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/forms/action-state";

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" disabled={pending}>
      <Plus className="size-4" aria-hidden />
      {pending ? pendingLabel : label}
    </Button>
  );
}

/**
 * The link, shown once.
 *
 * Only the hash is stored, so this is genuinely the only moment it exists here
 * — hence the copy button and the warning rather than a quiet toast that
 * scrolls away. Somebody who closes this without copying has to issue another
 * invitation, and it is better to say so than to let them find out.
 */
function IssuedLink({
  url,
  ttlDays,
  onDone,
}: {
  url: string;
  /*
   * Passed in rather than imported. `lib/connect/invitations` reaches for
   * `node:crypto`, so a Client Component cannot have it — which is why this
   * number was typed out by hand and would have kept saying fourteen after the
   * constant changed. A prop is the cheapest way to make the screen wrong only
   * if the server is wrong too.
   */
  ttlDays: number;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied.");
    } catch {
      // A clipboard write can be refused — an insecure context, a permission
      // policy. The input beside it is selectable, so the fallback is manual
      // rather than nothing.
      toast.error("Could not copy automatically. Select the link and copy it.");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <p className="text-sm font-medium">Invitation link — copy it now</p>
      <p className="text-xs text-muted-foreground">
        This is the only time it can be shown. Send it to the streamer however you normally reach
        them. It expires in {ttlDays} day{ttlDays === 1 ? "" : "s"} and can be revoked at any time.
      </p>
      {/*
       * Said where the link is copied, because both are things the admin has to
       * pass on in the same message. Learned from the first batch: the ones
       * that stalled were opened inside Messenger, and the hold between signing
       * in and choosing a Page is fifteen minutes.
       */}
      <p className="text-xs text-amber-700 dark:text-amber-500">
        Ask them to open it in Chrome or Safari rather than inside Messenger, and to finish in one
        sitting — the Facebook sign-in step times out after 15 minutes.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

export function InviteForm({
  streamers,
  ttlDays,
}: {
  streamers: readonly { id: string; streamerCode: string; streamerName: string }[];
  /** How long an issued link lasts. See the note on `IssuedLink`. */
  ttlDays: number;
}) {
  const [state, formAction] = useActionState(createInvitationAction, idleState);

  /*
   * Which link was dismissed, not whether one was.
   *
   * A boolean would need resetting when a second invitation is issued, and the
   * obvious place to reset it is an effect — which React rightly refuses,
   * because it is a cascading render for something derivable. Keying on the URL
   * makes a new link inherently undismissed.
   */
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "error") toast.error(state.message ?? "Could not create the invitation.");
  }, [state]);

  const issued = state.status === "success" && state.message ? state.message : null;
  const showIssued = issued !== null && issued !== dismissedUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a streamer</CardTitle>
        <CardDescription>
          Creates a link that lets them connect their own Page with Facebook Login. They copy
          nothing and see no tokens.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {showIssued ? <IssuedLink url={issued} ttlDays={ttlDays} onDone={() => setDismissedUrl(issued)} /> : null}

        <form action={formAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="inviteeLabel">Streamer name</Label>
              <Input id="inviteeLabel" name="inviteeLabel" required maxLength={120} placeholder="GM Blade" />
              <p className="text-xs text-muted-foreground">
                Shown to them on the page, and used as the roster name if they are new.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="inviteeEmail">Email (optional)</Label>
              <Input id="inviteeEmail" name="inviteeEmail" type="email" maxLength={320} />
              <p className="text-xs text-muted-foreground">
                For your own reference only. Nothing is sent from here.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="streamerId">Attach to an existing streamer</Label>
            <select
              id="streamerId"
              name="streamerId"
              className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm shadow-xs dark:border-input dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground"
              defaultValue=""
            >
              {/*
               * Blank is the common case and therefore first: most invitations
               * go to somebody not on the roster yet, and the connection
               * creates the record. Choosing an existing streamer is for
               * replacing a token on one that is already there.
               */}
              <option value="">Create a new streamer when they connect</option>
              {streamers.map((streamer) => (
                <option key={streamer.id} value={streamer.id}>
                  {streamer.streamerCode} · {streamer.streamerName}
                </option>
              ))}
            </select>
          </div>

          <Submit label="Create invitation link" pendingLabel="Creating…" />
        </form>
      </CardContent>
    </Card>
  );
}

/** Cancels a link that has not been used. */
export function RevokeButton({ id, label }: { id: string; label: string }) {
  const [state, formAction] = useActionState(revokeInvitationAction, idleState);

  useEffect(() => {
    if (state.status === "success") toast.success(state.message ?? "Revoked.");
    if (state.status === "error") toast.error(state.message ?? "Could not revoke.");
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" aria-label={`Revoke the invitation for ${label}`}>
        <X className="size-4" aria-hidden />
        Revoke
      </Button>
    </form>
  );
}
