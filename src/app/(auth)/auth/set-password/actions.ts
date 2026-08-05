"use server";

import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { DEFAULT_SIGNED_IN_PATH } from "@/lib/auth/route-policy";
import { setPasswordSchema } from "@/lib/auth/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SetPasswordState = { error: string | null };

/**
 * Choose a password for an account that has never had one.
 *
 * An invited user arrives with a session but no credential — the invitation
 * link proved they control the mailbox, nothing more. Until this runs they
 * cannot sign in again, because there is nothing to sign in with.
 *
 * The password never touches this application's database, and is not logged,
 * echoed into the returned state, or included in the audit metadata. Supabase
 * Auth owns the credential; this hands it over and forgets it.
 */
export async function setPasswordAction(
  _previous: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const parsed = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Choose a password." };
  }

  const supabase = await createSupabaseServerClient();

  /*
   * `getUser()` rather than `getSession()`: it verifies the token with Supabase
   * instead of trusting a cookie this request happens to carry. Setting a
   * password is exactly the operation where that difference matters.
   */
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    return {
      error: "That link is no longer valid. Ask an administrator to send a new invitation.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    /*
     * Supabase owns the password policy — length, breach lists, whatever the
     * project is configured with — so its message is the actionable one, and it
     * describes the rule rather than the value.
     */
    return { error: error.message };
  }

  await recordAuditLogSafe({
    userId: userData.user.id,
    action: AUDIT_ACTIONS.userPasswordSet,
    entityType: AUDIT_ENTITY_TYPES.user,
    entityId: userData.user.id,
    metadata: { method: "invitation" },
  });

  redirect(DEFAULT_SIGNED_IN_PATH);
}
