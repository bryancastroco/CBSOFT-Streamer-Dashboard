import type { Metadata } from "next";
import { BarChart3, MessageSquare, ShieldCheck } from "lucide-react";

import { ConnectButton, NoPages, PagePicker } from "@/app/connect/[token]/page-picker";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { effectiveStatus, isUsable, unusableReason } from "@/lib/connect/invitations";
import { findInvitationByToken } from "@/lib/repositories/page-connections";
import { listConnectablePages } from "@/lib/services/connect-page";

/**
 * Where an invited streamer connects their Page.
 *
 * ## Who reads this
 *
 * Somebody who does not work here, on a phone, who was sent a link. They are
 * not an admin, they have no account, and they will never see this page again.
 * So it says what will be read and what will not, in words that mean something
 * without knowing what a Page token is — and it asks for one decision.
 *
 * ## Why it is public
 *
 * The invitation token is the credential. Requiring a dashboard login would
 * defeat the purpose: these people do not have accounts and giving them one to
 * hand over a Page would be a worse trade than the link.
 *
 * `noindex` because the URL is a bearer credential. A search engine that
 * followed one would put a live invitation in an index.
 */

export const metadata: Metadata = {
  title: "Connect your Facebook Page",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** What each failure on the way back from Facebook should say. */
const ERROR_MESSAGES: Record<string, string> = {
  denied: "The Facebook sign-in was cancelled. You can try again whenever you are ready.",
  state:
    "That sign-in could not be verified — it may have been started in another browser or tab. Please try again from this page.",
  exchange:
    "Facebook accepted the sign-in but something went wrong finishing it. Please try again, and tell CBSOFT if it keeps happening.",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 p-4">
      <div className="space-y-1 text-center">
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">CBSOFT</p>
        <h1 className="text-2xl font-semibold">Connect your Facebook Page</h1>
      </div>
      {children}
    </main>
  );
}

export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);

  const invitation = await findInvitationByToken(token);

  /*
   * One message for "no such invitation" and for a malformed token.
   *
   * Telling an unauthenticated visitor which of those it was makes this page an
   * oracle: an attacker guessing links could tell a real-but-expired token from
   * a wrong one, and that difference is the whole search space.
   */
  if (!invitation) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This link is not valid</CardTitle>
            <CardDescription>
              It may have been mistyped or already used. Ask CBSOFT to send you a new one.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  const state = effectiveStatus(invitation);

  if (!isUsable(invitation)) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {state === "connected" ? "Already connected" : "This link is no longer active"}
            </CardTitle>
            <CardDescription>
              {state === "connected" && invitation.connectedPageName
                ? `${invitation.connectedPageName} is already connected. Nothing else is needed from you.`
                : unusableReason(state)}
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  const errorKey = typeof query["error"] === "string" ? query["error"] : null;
  const errorMessage = errorKey ? (ERROR_MESSAGES[errorKey] ?? ERROR_MESSAGES["denied"]) : null;

  // Set by the callback once the sign-in succeeded. Reaching this step without
  // a held credential simply shows the start screen again, which is the right
  // answer for a stale tab.
  const choosing = query["step"] === "choose";
  const pages = choosing ? await listConnectablePages(invitation.id) : null;

  return (
    <Shell>
      {errorMessage ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-500"
        >
          {errorMessage}
        </p>
      ) : null}

      {pages && !pages.ok ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {pages.message}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {pages?.ok ? "Choose your Page" : `Hello ${invitation.inviteeLabel}`}
          </CardTitle>
          <CardDescription>
            {pages?.ok
              ? "These are the Pages your Facebook account manages. Pick the one CBSOFT should follow."
              : "CBSOFT tracks how your streams perform. Connecting takes about thirty seconds and you will not need to copy or paste anything."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {pages?.ok ? (
            pages.pages.length > 0 ? (
              <PagePicker token={token} pages={pages.pages} />
            ) : (
              <NoPages />
            )
          ) : (
            <>
              {/*
               * Said before the permission dialog, not after. Facebook's own
               * screen lists permission names; this says what they mean for
               * the person reading, which is the part they actually care about.
               */}
              <ul className="space-y-3 text-sm">
                <li className="flex gap-3">
                  <BarChart3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="font-medium">Your Page&apos;s public numbers.</span> Views,
                    reactions, shares and follower counts on what you post.
                  </span>
                </li>
                <li className="flex gap-3">
                  <MessageSquare
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span>
                    <span className="font-medium">Comments on your posts.</span> The text only —
                    commenter names are never collected or stored.
                  </span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="font-medium">Nothing is posted or changed.</span> This is
                    read-only. It cannot publish, reply, or see your personal profile or messages.
                  </span>
                </li>
              </ul>

              <ConnectButton token={token} />

              <p className="text-center text-xs text-muted-foreground">
                You can disconnect at any time from Facebook → Settings → Business integrations.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}
