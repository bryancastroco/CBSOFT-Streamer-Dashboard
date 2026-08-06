"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, LogIn } from "lucide-react";

import { connectPageAction } from "@/app/connect/[token]/actions";
import { Button } from "@/components/ui/button";
import { idleState } from "@/lib/forms/action-state";
import { cn } from "@/lib/utils";

/**
 * The two things a streamer ever touches.
 *
 * Written for someone who does not work here: no jargon, no ids, no mention of
 * tokens. They see the name of their Page and a button.
 */

export function ConnectButton({ token }: { token: string }) {
  const [pending, setPending] = useState(false);

  return (
    // A real form POST to a Route Handler, which 303s to Facebook. Not a fetch:
    // the browser has to *navigate* to Facebook, and not a link, because
    // starting the flow sets a CSRF cookie and is a state change.
    <form
      action={`/api/connect/${encodeURIComponent(token)}/start`}
      method="post"
      /*
       * The pending flag is set here, on submit — NOT in the button's onClick.
       *
       * This looked like a style choice and was a total failure. React flushes
       * state from a click synchronously, so `onClick` → `setPending(true)`
       * re-rendered the button as `disabled` *before* the browser reached the
       * click's default action. A disabled submitter cancels form submission,
       * so the request was never made.
       *
       * The symptom was the cruellest possible one: the label changed to
       * "Opening Facebook…" and stayed there. It looked like a slow network, or
       * like Facebook was down, or like the CSP was still wrong. The only proof
       * was server-side — `opened_at` still null on the invitation, because the
       * route that sets it never ran.
       *
       * `onSubmit` fires as part of the submission that is already under way,
       * so nothing can cancel it.
       */
      onSubmit={() => setPending(true)}
    >
      <Button
        type="submit"
        size="lg"
        // Never `disabled`. Pointer-events guards the double click instead, and
        // cannot interfere with a submission the browser has already begun.
        className={cn("w-full", pending && "pointer-events-none opacity-90")}
        aria-busy={pending}
      >
        <LogIn className="size-5" aria-hidden />
        {pending ? "Opening Facebook…" : "Continue with Facebook"}
      </Button>
    </form>
  );
}

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="lg" className="w-full" disabled={disabled || pending}>
      {pending ? "Connecting…" : "Connect this Page"}
    </Button>
  );
}

export function PagePicker({
  token,
  pages,
}: {
  token: string;
  pages: readonly { id: string; name: string; category: string | null }[];
}) {
  const [state, formAction] = useActionState(connectPageAction, idleState);
  const [chosen, setChosen] = useState(pages.length === 1 ? (pages[0]?.id ?? "") : "");

  if (state.status === "success") {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
        <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-5" aria-hidden />
          All done
        </p>
        <p className="text-sm text-muted-foreground">{state.message}</p>
        <p className="text-sm text-muted-foreground">You can close this page.</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Choose the Page to connect</legend>

        {pages.map((page) => (
          <label
            key={page.id}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
              chosen === page.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
            }`}
          >
            <input
              type="radio"
              name="pageId"
              value={page.id}
              checked={chosen === page.id}
              onChange={() => setChosen(page.id)}
              className="size-4 accent-primary"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{page.name}</span>
              {page.category ? (
                <span className="block text-xs text-muted-foreground">{page.category}</span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      <Submit disabled={!chosen} />
    </form>
  );
}

/** Nothing to choose from — a real outcome, and one worth explaining. */
export function NoPages() {
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
      <p className="font-medium">No Pages found on that Facebook account</p>
      <p className="text-muted-foreground">
        This happens when the account you signed in with does not administer any Facebook Page, or
        when the Page was not ticked on the permission screen. Sign in again and make sure your Page
        is selected.
      </p>
    </div>
  );
}
