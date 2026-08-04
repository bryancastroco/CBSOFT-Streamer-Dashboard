"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, CircleCheck, ListTree } from "lucide-react";

import { listGeminiModelsAction, type GeminiModelsState } from "@/app/(app)/admin/ai/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const initialState: GeminiModelsState = {
  status: "idle",
  message: null,
  models: [],
  configured: null,
};

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      <ListTree className="size-4" aria-hidden />
      {pending ? "Asking Google…" : "List available models"}
    </Button>
  );
}

const numberFormat = new Intl.NumberFormat("en-GB");

/**
 * What this key may actually use, read from the key.
 *
 * Google retires model ids and restricts others to existing accounts, so the
 * correct value for `GEMINI_MODEL` is a property of the key rather than
 * something a default can encode. This turns "try a name and redeploy" into
 * reading a list.
 */
export function GeminiModelList() {
  const [state, formAction] = useActionState(listGeminiModelsAction, initialState);

  const configuredIsAvailable =
    state.status === "success" &&
    state.configured !== null &&
    state.models.some((model) => model.id === state.configured);

  return (
    <div className="space-y-3">
      <form action={formAction}>
        <Submit />
      </form>

      {state.status === "error" && state.message ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-sm">{state.message}</p>
        </div>
      ) : null}

      {state.status === "success" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Currently set:</span>
            <code className="font-mono text-xs">{state.configured ?? "—"}</code>
            {configuredIsAvailable ? (
              <Badge variant="secondary" className="gap-1">
                <CircleCheck className="size-3" aria-hidden />
                available
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-destructive">
                <CircleAlert className="size-3" aria-hidden />
                not in this list
              </Badge>
            )}
          </div>

          {!configuredIsAvailable ? (
            <p className="text-xs text-muted-foreground">
              Set <code>GEMINI_MODEL</code> in Vercel to one of the ids below, then redeploy. A
              flash model is the right choice here — comment analysis is short, high volume, and
              does not need a reasoning tier.
            </p>
          ) : null}

          <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {state.models.map((model) => (
              <div key={model.id} className="px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <code className="font-mono text-xs font-medium break-all">{model.id}</code>
                  {model.id === state.configured ? (
                    <Badge variant="secondary" className="text-[10px]">
                      in use
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{model.displayName}</p>
                {model.inputTokenLimit ? (
                  <p className="text-[11px] text-muted-foreground">
                    {numberFormat.format(model.inputTokenLimit)} input tokens
                  </p>
                ) : null}
              </div>
            ))}

            {state.models.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                This key can use no models that support content generation.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
