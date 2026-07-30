import { connection } from "next/server";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The 404 page.
 *
 * `connection()` opts it into dynamic rendering, which it needs for one reason:
 * the Content-Security-Policy is nonce-based, and Next can only stamp a nonce
 * onto its scripts during a *request*. A statically prerendered page is built
 * before any request exists, so its script tags carry no nonce — and under
 * `script-src 'nonce-…' 'strict-dynamic'` the browser refuses to run them.
 *
 * Without this, every other route works and the 404 page alone loads as dead
 * HTML with a console full of CSP violations. It is the one route in the
 * application that was still static.
 */
export default async function NotFound() {
  await connection();

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-4 text-center">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <Button asChild variant="outline">
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </main>
  );
}
