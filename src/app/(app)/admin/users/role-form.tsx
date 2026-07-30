"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import { changeUserRoleAction, type RoleChangeState } from "@/app/(app)/admin/users/actions";
import { Button } from "@/components/ui/button";
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
