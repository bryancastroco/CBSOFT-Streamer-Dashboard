"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, LogIn } from "lucide-react";

import { connectPageAction } from "@/app/connect/[token]/actions";
import { Button } from "@/components/ui/button";
import { idleState } from "@/lib/forms/action-state";

/**
 * The two things a streamer ever touches.
 *
 * Written for someone who does not work here: no jargon, no ids, no mention of
 * tokens. They see the name of their Page and a button.
 */

export function ConnectButton({ token }: { token: string }) {
  const [pending, setPending] = useState(false);

  return (
    // A real form POST to a Route Handler, which 302s to Facebook. Not a fetch:
    // the browser has to *navigate* to Facebook, and not a link, because
    // starting the flow sets a CSRF cookie and is a state change.
    <form action={`/api/connect/${encodeURIComponent(token)}/start`} method="post">
      <Button type="submit" size="lg" className="w-full" disabled={pending} onClick={() => setPending(true)}>
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
