import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";

import { SignOutButton } from "@/components/layout/sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/roles";

export const metadata: Metadata = { title: "Not authorised" };
export const dynamic = "force-dynamic";

/**
 * Shown when a request is authenticated but not permitted.
 *
 * Public by route policy so it can never trap a signed-out user in a redirect
 * loop with `/login`. It reveals nothing beyond the viewer's own role, so
 * being public costs nothing.
 */
export default async function UnauthorizedPage() {
  const user = await getCurrentUser();

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" aria-hidden />
            <CardTitle>Not authorised</CardTitle>
          </div>
          <CardDescription>
            {user
              ? "Your account does not have permission to view that page."
              : "That page requires permissions your account does not have."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {user ? (
            <p className="text-sm text-muted-foreground">
              You are signed in as <span className="font-medium text-foreground">{user.email}</span>{" "}
              with the <span className="font-medium text-foreground">{ROLE_LABELS[user.role]}</span>{" "}
              role. If you need administrative access, ask an existing admin to grant it.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your account has not been provisioned for this workspace, or your session has ended.
              Sign in again, or contact the CBSOFT operations team.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard">Back to the dashboard</Link>
            </Button>
            <SignOutButton variant="ghost" />
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
