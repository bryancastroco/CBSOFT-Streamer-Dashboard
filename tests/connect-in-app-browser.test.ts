import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IN_APP_BROWSER_NOTICE, isInAppBrowser } from "@/lib/connect/in-app-browser";

/**
 * Recognising the webview that swallows the sign-in.
 *
 * Six invitations reached `opened` and stopped. From the server every one of
 * them looked like a clean start — the POST arrived, `opened_at` was stamped,
 * the redirect went out — because the failure happens on Facebook's side, after
 * control has been handed away, inside the in-app browser the link was tapped
 * in. There is nothing to catch and nothing to record; the only move is to warn
 * before it happens.
 */

const FACEBOOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/468.0.0.45.107;FBBV/610000000]";

const FACEBOOK_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/468.0.0.35.109;]";

const MESSENGER =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/449.0.0.44.109;] Messenger";

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("spotting an in-app browser", () => {
  it("recognises the Facebook app on both platforms", () => {
    expect(isInAppBrowser(FACEBOOK_IOS)).toBe(true);
    expect(isInAppBrowser(FACEBOOK_ANDROID)).toBe(true);
  });

  it("recognises Messenger, which is how the link is usually delivered", () => {
    expect(isInAppBrowser(MESSENGER)).toBe(true);
  });

  it("leaves a real mobile browser alone", () => {
    // The false positive is the expensive one: this warning tells someone their
    // browser will not work, and saying that to a working browser sends them
    // hunting for a menu item that is not there.
    expect(isInAppBrowser(CHROME_ANDROID)).toBe(false);
    expect(isInAppBrowser(SAFARI_IOS)).toBe(false);
  });

  it("treats a missing user agent as an ordinary browser", () => {
    expect(isInAppBrowser(null)).toBe(false);
    expect(isInAppBrowser(undefined)).toBe(false);
    expect(isInAppBrowser("")).toBe(false);
  });

  it("matches regardless of casing", () => {
    expect(isInAppBrowser("something fban/fbios something")).toBe(true);
  });
});

describe("what the notice says", () => {
  it("gives an instruction rather than naming the technology", () => {
    // The reader does not work here and has no reason to know what a webview
    // is. What they need is which menu to open.
    expect(IN_APP_BROWSER_NOTICE).toMatch(/open in browser/i);
    expect(IN_APP_BROWSER_NOTICE).not.toMatch(/webview|oauth|user agent/i);
  });

  it("hedges, because the flow sometimes does complete in there", () => {
    expect(IN_APP_BROWSER_NOTICE).toMatch(/often does not finish/i);
  });
});

describe("the warning does not become a gate", () => {
  it("leaves the sign-in button reachable", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "app", "connect", "[token]", "page.tsx"),
      "utf8",
    );

    /*
     * User-agent matching is guesswork. Hiding the button behind it would turn
     * a wrong guess into a streamer who cannot connect at all, which is worse
     * than the failure being warned about.
     */
    expect(source).toContain("<ConnectButton token={token} />");
    expect(source).not.toMatch(/inAppBrowser\s*\?\s*[\s\S]{0,80}?:\s*<ConnectButton/);
  });
});
