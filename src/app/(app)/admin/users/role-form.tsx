"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import {
  changeUserRoleAction,
  inviteUserAction,
  setUserActiveAction,
  type RoleChangeState,
} from "@/app/(app)/admin/users/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UserRole } from "@/lib/auth/roles";

const initialState: RoleChangeState = { status: "idle", message: null };

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
 * Invite someone by email.
 *
 * No password field, deliberately. Supabase mails a link and the invitee sets
 * their own credential, so this application never handles one.
 */
export function InviteForm() {
  const [state, formAction] = useActionState(inviteUserAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success" && state.message) {
      toast.success(state.message);
      // Cleared only on success, so a rejected invitation keeps what was typed.
      formRef.current?.reset();
    }
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  return (
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
        <SubmitButton label="Send invitation" disabled={false} />
      </div>
    </form>
  );
}
