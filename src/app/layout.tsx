import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { site } from "@/config/site";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: site.name,
    template: `%s · ${site.shortName}`,
  },
  description: site.description,
  robots: { index: false, follow: false },
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
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
