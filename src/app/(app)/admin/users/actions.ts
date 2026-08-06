"use server";

import { revalidatePath } from "next/cache";

import { AuthorizationError, assertAdmin } from "@/lib/auth/guards";
import { inviteUserSchema, roleChangeSchema, setActiveSchema } from "@/lib/auth/validation";
import {
  changeUserRole,
  createPasswordLink,
  inviteUser,
  setUserActive,
  type ActivationRejection,
  type RoleChangeRejection,
} from "@/lib/repositories/users";

export type RoleChangeState = {
  status: "idle" | "success" | "error";
  message: string | null;
  /**
   * A sign-in link for the admin to deliver, shown once.
   *
   * Separate from `message` because it is not prose: the UI renders it in a
   * field with a copy button, and only the hash of the token is stored, so
   * there is no second chance to show it.
   */
  link?: string;
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

const ACTIVATION_MESSAGES: Record<ActivationRejection, string> = {
  not_found: "That user no longer exists.",
  self_change: "You cannot deactivate your own account. Ask another admin to do it.",
  no_change: "That account is already in this state.",
  last_admin: "This is the only active admin. Promote someone else before switching it off.",
};

/**
 * Switch an account off, or back on.
 *
 * Not a delete, and there is deliberately no action here that is. The audit
 * trail references these rows and has to outlive the person; a button that
 * destroys history permanently is not something this interface should offer.
 */
export async function setUserActiveAction(
  _previousState: RoleChangeState,
  formData: FormData,
): Promise<RoleChangeState> {
  let actorId: string;

  try {
    actorId = (await assertAdmin()).id;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }

  const parsed = setActiveSchema.safeParse({
    userId: formData.get("userId"),
    active: formData.get("active"),
  });

  if (!parsed.success) {
    return { status: "error", message: "That request is not valid." };
  }

  const outcome = await setUserActive({
    actorId,
    targetUserId: parsed.data.userId,
    active: parsed.data.active,
  });

  if (!outcome.ok) {
    return { status: "error", message: ACTIVATION_MESSAGES[outcome.reason] };
  }

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: outcome.active
      ? `${outcome.email} can sign in again.`
      : `${outcome.email} has been deactivated and can no longer sign in.`,
  };
}

/**
 * Invite someone by email.
 *
 * Supabase sends the mail and owns the credential — the invitee sets their own
 * password through the link. No password is ever accepted, stored or
 * transmitted by this application, which is why invitation is the primitive
 * here rather than "create a user".
 */
export async function inviteUserAction(
  _previousState: RoleChangeState,
  formData: FormData,
): Promise<RoleChangeState> {
  let actorId: string;

  try {
    actorId = (await assertAdmin()).id;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }

  const parsed = inviteUserSchema.safeParse({
    email: formData.get("email"),
    fullName: formData.get("fullName") ?? "",
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the invitation details.",
    };
  }

  const outcome = await inviteUser({
    actorId,
    email: parsed.data.email,
    fullName: parsed.data.fullName || null,
    role: parsed.data.role,
  });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: `${outcome.email} added as ${
      outcome.role === "admin" ? "an admin" : "a viewer"
    }. Send them this link — it is the only time it can be shown.`,
    link: outcome.link,
  };
}

/**
 * A fresh sign-in link for somebody who already has an account.
 *
 * The escape hatch for an invitation that was never completed and for a
 * forgotten password — one action, because both end at the same screen and an
 * admin should not have to work out which case they are in.
 */
export async function sendPasswordLinkAction(
  _previousState: RoleChangeState,
  formData: FormData,
): Promise<RoleChangeState> {
  let actorId: string;

  try {
    actorId = (await assertAdmin()).id;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "error", message: error.message };
    }
    throw error;
  }

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { status: "error", message: "No account was named." };

  const outcome = await createPasswordLink({ actorId, userId });

  if (!outcome.ok) return { status: "error", message: outcome.message };

  revalidatePath("/admin/users");

  return {
    status: "success",
    message: `Password link for ${outcome.email}. Send it to them — it is shown once.`,
    link: outcome.link,
  };
}
