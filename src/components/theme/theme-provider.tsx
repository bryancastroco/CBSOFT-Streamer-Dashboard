"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Light/dark theming.
 *
 * `next-themes` writes the resolved theme onto `<html>` as a class before first
 * paint, which is what `@custom-variant dark (&:is(.dark *))` in `globals.css`
 * keys off. It also means the class is applied by an inline script rather than
 * by React, so `<html>` carries `suppressHydrationWarning` in the root layout —
 * the server cannot know the visitor's preference and the mismatch is expected.
 *
 * `system` is the default so the app follows the operating system until someone
 * chooses otherwise.
 */
export function ThemeProvider({
  children,
  nonce,
}: {
  children: React.ReactNode;
  /**
   * The per-request Content-Security-Policy nonce.
   *
   * next-themes emits its own inline anti-flash script — the one that sets the
   * theme class before first paint. Next cannot nonce a script it did not
   * write, so under `script-src 'nonce-…' 'strict-dynamic'` the browser refuses
   * to run it: every page would load in light mode and snap to dark once React
   * hydrated. Threading the nonce through is what lets the strict policy and
   * the flash-free theme coexist.
   */
  nonce?: string | undefined;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce ? { nonce } : {})}
    >
      {children}
    </NextThemesProvider>
  );
}
