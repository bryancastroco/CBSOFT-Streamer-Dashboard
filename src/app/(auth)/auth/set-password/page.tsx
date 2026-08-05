import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SetPasswordForm } from "@/app/(auth)/auth/set-password/set-password-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { site } from "@/config/site";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Set your password" };
export const dynamic = "force-dynamic";

/**
 * Where an invitation ends: choosing a password for the first time.
 *
 * The invitation link proved the invitee controls the mailbox and nothing more.
 * `/auth/callback` turned that into a session; without this step they would
 * have an account they can never sign into again, because there is no
 * credential to sign in with.
 *
 * Reachable without a session by route policy — `/auth` is public — so the
 * session check happens here and again inside the action. A visitor arriving
 * with no session is sent to sign in rather than shown a form that cannot work.
 */
export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();

  // Verified against Supabase rather than read from the cookie. This page
  // exists to hand someone a credential; trusting the cookie alone would let a
  // forged one reach the form.
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/login?reason=link_expired");
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set your password</CardTitle>
          <CardDescription>
            {site.name} — {data.user.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SetPasswordForm />

          <p className="text-xs text-muted-foreground">
            You are signed in from the invitation link. Choose a password so you can sign in again
            later.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
