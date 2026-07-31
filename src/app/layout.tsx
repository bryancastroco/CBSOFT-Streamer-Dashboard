import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { site } from "@/config/site";
import { resolveAppOrigin } from "@/lib/config/app-origin";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/*
 * Resolved, never hard-coded to one vercel.app address.
 *
 * `resolveAppOrigin()` prefers NEXT_PUBLIC_APP_URL, falls back to this
 * deployment's own hostname on a preview, and to localhost in development — so
 * a preview advertises itself rather than the production domain, and attaching
 * a custom domain later needs one environment variable rather than a code
 * change.
 */
const origin = resolveAppOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: {
    default: site.name,
    template: `%s · ${site.shortName}`,
  },
  description: site.description,
  applicationName: site.shortName,
  alternates: { canonical: "/" },
  /*
   * `noindex` stays. This is an internal dashboard behind authentication, and
   * the Open Graph block below is for a link pasted into Slack or a DM — not
   * for search. The two are unrelated: `robots` governs indexing, `openGraph`
   * governs how an already-shared link renders.
   */
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    type: "website",
    siteName: site.shortName,
    title: site.name,
    description: site.description,
    url: origin,
  },
  twitter: {
    card: "summary",
    title: site.name,
    description: site.description,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /*
   * The per-request CSP nonce, set by `src/proxy.ts`.
   *
   * Next stamps its own scripts automatically by reading the policy off the
   * request. The one script it cannot reach is next-themes' inline anti-flash
   * snippet, which the library emits itself — so the raw value is read here and
   * handed to the provider.
   */
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    /*
     * `suppressHydrationWarning` is required by next-themes: the theme class is
     * written onto <html> by an inline script before React hydrates, so the
     * server-rendered markup necessarily differs by that one attribute.
     */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <ThemeProvider nonce={nonce}>
          {/*
           * Radix tooltips throw at render without a provider ancestor — not a
           * warning, an exception that takes the whole page down. The dashboard
           * renders eight of them, so it died on load; the collapsed sidebar
           * would have done the same. It sits at the root because a tooltip is
           * the kind of thing any screen adds later, and the failure mode is
           * far too loud for the mistake to be worth repeating.
           *
           * `delayDuration` is a little longer than the Radix default: these
           * explain a metric rather than name an icon, so firing them the
           * instant a pointer crosses a card is noise.
           */}
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
