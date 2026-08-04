"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, CircleCheck, PlugZap } from "lucide-react";
import { toast } from "sonner";

import { testAiConnectionAction, type AiTestState } from "@/app/(app)/admin/ai/actions";
import { Button } from "@/components/ui/button";

const initialState: AiTestState = { status: "idle", message: null };

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      <PlugZap className="size-4" aria-hidden />
      {pending ? "Asking Anthropic…" : "Test connection"}
    </Button>
  );
}

/**
 * A one-click answer to "is the key working".
 *
 * The result stays on the page as well as raising a toast. A rejected key is
 * something an operator reads twice and then acts on, and a toast that has
 * already faded is no use while they are in another tab pasting a new one.
 */
export function AiTestButton() {
  const [state, formAction] = useActionState(testAiConnectionAction, initialState);

  useEffect(() => {
    if (state.status === "success" && state.message) toast.success(state.message);
    if (state.status === "error" && state.message) toast.error(state.message);
  }, [state]);

  return (
    <div className="space-y-3">
      <form action={formAction}>
        <Submit />
      </form>

      {state.status !== "idle" && state.message ? (
        <div
          className={
            state.status === "success"
              ? "flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3"
              : "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          }
        >
          {state.status === "success" ? (
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500"
              aria-hidden
            />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          )}

          <div className="min-w-0">
            <p className="text-sm">{state.message}</p>

            {/*
             * The remedy differs by category and is not obvious from the
             * message alone — a 401 needs a new key, a 429 needs patience, and
             * a model error needs a different ANTHROPIC_MODEL.
             */}
            {state.category === "authentication" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Set a new key in Vercel → Settings → Environment Variables, then redeploy. Vercel
                captures environment variables at build time, so a change does not reach the running
                application until a new deployment.
              </p>
            ) : null}

            {state.category === "rate_limited" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                The key is valid. This is a throttle, not a configuration problem.
              </p>
            ) : null}

            {state.category === "unknown" || state.category === "invalid_request" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                The key was accepted. Check <code>ANTHROPIC_MODEL</code> — a model this account
                cannot use fails here rather than at authentication.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
