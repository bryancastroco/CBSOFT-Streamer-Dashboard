"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";

import {
  changeUserRoleAction,
  inviteUserAction,
  sendPasswordLinkAction,
  setUserActiveAction,
  type RoleChangeState,
} from "@/app/(app)/admin/users/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UserRole } from "@/lib/auth/roles";

const initialState: RoleChangeState = { status: "idle", message: null };

/**
 * A sign-in link, shown once.
 *
 * Supabase stores only a hash of the token, so this really is the only moment
 * it exists here — hence a field and a copy button rather than a toast that
 * scrolls away. Somebody who closes it without copying generates another,
 * which is cheap; discovering later that it is gone forever is not.
 *
 * Keyed on the link rather than a boolean `dismissed`, so a second link is
 * inherently undismissed and no effect is needed to reset anything.
 */
function IssuedLink({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied.");
    } catch {
      // Refused in an insecure context or by a permission policy. The field is
      // selectable, so the fallback is manual rather than nothing.
      toast.error("Could not copy automatically. Select the link and copy it.");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <p className="text-sm font-medium">Send this link — it is shown once</p>
      <p className="text-xs text-muted-foreground">
        It takes them straight to a page where they choose their password. Nothing is emailed from
        here, so deliver it however you normally reach them.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          readOnly
          value={url}
          className="font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
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

/**
 * A fresh way in for an account that already exists.
 *
 * Covers an invitation that was never completed and a forgotten password with
 * one button, because both end at the same screen and an admin should not have
 * to diagnose which case they are looking at.
 */
export function PasswordLinkForm({ userId, email }: { userId: string; email: string }) {
  const [state, formAction] = useActionState(sendPasswordLinkAction, initialState);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  const link = state.status === "success" ? (state.link ?? null) : null;

  return (
    <div className="space-y-3">
      <form action={formAction}>
        <input type="hidden" name="userId" value={userId} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`Create a password link for ${email}`}
        >
          <KeyRound className="size-4" aria-hidden />
          Password link
        </Button>
      </form>

      {link && link !== dismissed ? (
        <IssuedLink url={link} onDone={() => setDismissed(link)} />
      ) : null}
    </div>
  );
}

function SubmitButton({ label, disabled }: { label: string; disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending || disabled}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

/**
 * Role toggle for one user.
 *
 * `isSelf` only removes the control from the page — the same rule is enforced
 * in the Server Action, in the database transaction, and in the RLS policy.
 */
export function RoleForm({
  userId,
  currentRole,
  isSelf,
}: {
  userId: string;
  currentRole: UserRole;
  isSelf: boolean;
}) {
  const [state, formAction] = useActionState(changeUserRoleAction, initialState);

  useEffect(() => {
    if (state.status === "success" && state.message) toast.success(state.message);
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  if (isSelf) {
    return <span className="text-xs text-muted-foreground">Your own account</span>;
  }

  const nextRole: UserRole = currentRole === "admin" ? "viewer" : "admin";
  const label = nextRole === "admin" ? "Make admin" : "Make viewer";

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="role" value={nextRole} />
      <SubmitButton label={label} disabled={false} />
    </form>
  );
}

/**
 * Switch an account off, or back on.
 *
 * `isSelf` removes the control; the rule is enforced again in the action and
 * once more in the database transaction. Deactivating yourself would lock you
 * out of the workspace on the next request.
 */
export function ActivationForm({
  userId,
  active,
  isSelf,
}: {
  userId: string;
  active: boolean;
  isSelf: boolean;
}) {
  const [state, formAction] = useActionState(setUserActiveAction, initialState);

  useEffect(() => {
    if (state.status === "success" && state.message) toast.success(state.message);
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  if (isSelf) return null;

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <SubmitButton label={active ? "Deactivate" : "Reactivate"} disabled={false} />
    </form>
  );
}

/**
 * Add someone, and get a link to send them.
 *
 * No password field, deliberately: the invitee sets their own credential
 * through the link, so this application never handles one.
 *
 * Nothing is emailed. Supabase's own template ends in a URL fragment that never
 * reaches a server, editing it requires a paid plan, and the free tier caps
 * auth email at a handful an hour — so the admin delivers the link, which is
 * what they were already doing for Page connections.
 */
export function InviteForm() {
  const [state, formAction] = useActionState(inviteUserAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "success" && state.message) {
      toast.success(state.message);
      // Cleared only on success, so a rejected invitation keeps what was typed.
      formRef.current?.reset();
    }
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  const link = state.status === "success" ? (state.link ?? null) : null;

  return (
    <div className="space-y-4">
      {link && link !== dismissed ? (
        <IssuedLink url={link} onDone={() => setDismissed(link)} />
      ) : null}

      <form ref={formRef} action={formAction} className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr_auto]">
      <div className="grid gap-1.5">
        <Label htmlFor="invite-email" className="text-xs text-muted-foreground">
          Email
        </Label>
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          autoComplete="off"
          placeholder="person@cbsoft.example"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="invite-name" className="text-xs text-muted-foreground">
          Full name (optional)
        </Label>
        <Input id="invite-name" name="fullName" autoComplete="off" placeholder="Jane Dela Cruz" />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="invite-role" className="text-xs text-muted-foreground">
          Role
        </Label>
        <select
          id="invite-role"
          name="role"
          defaultValue="viewer"
          className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm dark:border-input dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground"
        >
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <div className="flex items-end">
        <SubmitButton label="Create invitation link" disabled={false} />
      </div>
      </form>
    </div>
  );
}
