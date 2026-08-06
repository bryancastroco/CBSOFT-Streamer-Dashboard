import type { Metadata } from "next";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Connection link",
  robots: { index: false, follow: false },
};

/**
 * Where a callback with no matching sign-in lands.
 *
 * Reached when the state cookie is missing — a forged callback URL, a browser
 * that dropped the cookie, or a link opened in a different browser from the one
 * that started. There is no invitation to name, so this says the only true
 * thing available and offers the way forward.
 */
export default function InvalidConnectionPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 p-4">
      <div className="space-y-1 text-center">
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">CBSOFT</p>
        <h1 className="text-2xl font-semibold">Connect your Facebook Page</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">That sign-in could not be completed</CardTitle>
          <CardDescription>
            It looks like it was started in a different browser, or the link was opened directly.
            Open the invitation link CBSOFT sent you and press Continue with Facebook there.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
