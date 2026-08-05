import type { Metadata } from "next";

import { CircleAlert } from "lucide-react";

import { LoginForm } from "@/app/(auth)/login/login-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sanitiseNextPath } from "@/lib/auth/route-policy";
import { site } from "@/config/site";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Why an email link sent someone here, in words they can act on.
 *
 * Keyed off a fixed set rather than echoing anything from the query string:
 * this is an unauthenticated page, and reflecting arbitrary text into it is how
 * a login screen becomes a phishing surface.
 */
const LINK_REASONS: Record<string, string> = {
  link_expired:
    "That invitation link has expired or was already used. Ask an administrator to send a new one.",
  link_invalid: "That link could not be verified. Ask an administrator to send a new invitation.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const params = await searchParams;

  // Sanitised here as well as in the action: this value is echoed into the
  // form, and an unchecked `next` would make the login page an open redirect.
  const next = sanitiseNextPath(params.next ?? null);
  const reason = params.reason ? LINK_REASONS[params.reason] : undefined;

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>{site.name}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {reason ? (
            <Alert>
              <CircleAlert />
              <AlertDescription>{reason}</AlertDescription>
            </Alert>
          ) : null}

          <LoginForm next={next} />

          <p className="text-xs text-muted-foreground">
            Accounts are created by an administrator. If you cannot sign in, contact the CBSOFT
            operations team.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
