import type { Metadata } from "next";

import { LoginForm } from "@/app/(auth)/login/login-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sanitiseNextPath } from "@/lib/auth/route-policy";
import { site } from "@/config/site";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;

  // Sanitised here as well as in the action: this value is echoed into the
  // form, and an unchecked `next` would make the login page an open redirect.
  const next = sanitiseNextPath(params.next ?? null);

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>{site.name}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
