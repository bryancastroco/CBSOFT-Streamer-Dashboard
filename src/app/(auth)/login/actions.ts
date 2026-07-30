"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { DEFAULT_SIGNED_IN_PATH, LOGIN_PATH, sanitiseNextPath } from "@/lib/auth/route-policy";
import { signInSchema } from "@/lib/auth/validation";
import {
  checkLoginAttempt,
  clearLoginAttempts,
  clientAddressFrom,
} from "@/lib/security/login-throttle";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SignInState = {
  error: string | null;
};

/**
 * Email + password sign-in.
 *
 * Failure messaging is deliberately uniform: "Invalid email or password",
 * whatever actually went wrong. Distinguishing "no such account" from "wrong
 * password" turns the login form into an account-enumeration oracle.
 */
export async function signInAction(
  _previousState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your email and password." };
  }

  /*
   * Throttle before the credentials are checked.
   *
   * A refused attempt never reaches Supabase, which is the point: password
   * verification is the expensive operation, and an attacker should not be able
   * to make us perform it thousands of times.
   */
  const throttle = checkLoginAttempt({
    email: parsed.data.email,
    clientAddress: clientAddressFrom(await headers()),
  });

  if (!throttle.allowed) {
    const minutes = Math.max(1, Math.ceil(throttle.retryAfterSeconds / 60));

    await recordAuditLogSafe({
      userId: null,
      action: AUDIT_ACTIONS.userSignInThrottled,
      entityType: AUDIT_ENTITY_TYPES.user,
      entityId: null,
      metadata: { email: parsed.data.email, retryAfterSeconds: throttle.retryAfterSeconds },
    });

    return {
      error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    await recordAuditLogSafe({
      userId: null,
      action: AUDIT_ACTIONS.userSignInFailed,
      entityType: AUDIT_ENTITY_TYPES.user,
      entityId: null,
      // The attempted address is recorded; the password never is.
      metadata: { email: parsed.data.email },
    });

    return { error: "Invalid email or password." };
  }

  // Succeeding clears the address's failure count. Somebody who mistypes their
  // password four times and then gets it right is not punished for the rest of
  // the window.
  clearLoginAttempts(parsed.data.email);

  await recordAuditLogSafe({
    userId: data.user.id,
    action: AUDIT_ACTIONS.userSignedIn,
    entityType: AUDIT_ENTITY_TYPES.user,
    entityId: data.user.id,
  });

  // `next` came from the URL, so it is attacker-influenced: only same-origin
  // absolute paths survive sanitisation.
  const next = sanitiseNextPath(parsed.data.next ?? null) ?? DEFAULT_SIGNED_IN_PATH;

  revalidatePath("/", "layout");
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  await supabase.auth.signOut();

  if (user) {
    await recordAuditLogSafe({
      userId: user.id,
      action: AUDIT_ACTIONS.userSignedOut,
      entityType: AUDIT_ENTITY_TYPES.user,
      entityId: user.id,
    });
  }

  revalidatePath("/", "layout");
  redirect(LOGIN_PATH);
}
