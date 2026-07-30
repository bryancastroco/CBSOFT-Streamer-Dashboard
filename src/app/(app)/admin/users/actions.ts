"use server";

import { revalidatePath } from "next/cache";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { roleChangeSchema } from "@/lib/auth/validation";
import { changeUserRole, type RoleChangeRejection } from "@/lib/repositories/users";

export type RoleChangeState = {
  status: "idle" | "success" | "error";
  message: string | null;
};

const REJECTION_MESSAGES: Record<RoleChangeRejection, string> = {
  not_found: "That user no longer exists.",
  self_change: "You cannot change your own role. Ask another admin to do it.",
  no_change: "That user already has this role.",
  last_admin: "This is the only admin. Promote someone else before demoting this account.",
};

/**
 * Change a user's role.
 *
 * `assertAdmin()` is the authorisation point. Server Actions are ordinary POST
 * endpoints — anyone who can reach the app can invoke this one directly, so the
 * check has to live here and not in the component that renders the control.
 */
export async function changeUserRoleAction(
  _previousState: RoleChangeState,
  formData: FormData,
): Promise<RoleChangeState> {
  let actorId: string;

  try {
    const actor = await assertAdmin();
    actorId = actor.id;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }

  const parsed = roleChangeSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { status: "error", message: "That role change is not valid." };
  }

  const outcome = await changeUserRole({
    actorId,
    targetUserId: parsed.data.userId,
    newRole: parsed.data.role,
  });

  if (!outcome.ok) {
    return { status: "error", message: REJECTION_MESSAGES[outcome.reason] };
  }

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: `${outcome.email} is now ${outcome.newRole === "admin" ? "an admin" : "a viewer"}.`,
  };
}
