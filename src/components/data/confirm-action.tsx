"use client";

import { useActionState, useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * A Server Action behind a confirmation dialog, reporting through a toast.
 *
 * The actions this wraps are not free: a sync spends Meta API quota, and an
 * analysis spends Anthropic tokens. Both are also slow enough that a mis-click
 * is not obviously a mis-click, so they get a dialog naming the cost before they
 * run. Destructive actions get one for the ordinary reason.
 *
 * The confirmation is a courtesy, never a control: every wrapped action still
 * calls `assertAdmin()` server-side before it mutates anything.
 *
 * The form sits outside the dialog and is submitted via `requestSubmit()`. If it
 * lived inside, closing the dialog would unmount the element mid-flight and the
 * button could never show its own pending state.
 */

export type ActionState = {
  status: "idle" | "success" | "error";
  message: string | null;
};

export function ConfirmAction<S extends ActionState>({
  action,
  initialState,
  label,
  pendingLabel,
  icon: Icon,
  variant = "outline",
  disabled = false,
  disabledReason,
  title,
  description,
  confirmLabel,
  hiddenFields = {},
}: {
  action: (state: Awaited<S>, formData: FormData) => Promise<S>;
  initialState: Awaited<S>;
  label: string;
  pendingLabel: string;
  icon?: LucideIcon | undefined;
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
  disabledReason?: string | undefined;
  title: string;
  description: string;
  confirmLabel?: string;
  /** Values the action needs, e.g. the streamer or content id. */
  hiddenFields?: Record<string, string>;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.message) return;
    if (state.status === "success") toast.success(state.message, { duration: 8000 });
    if (state.status === "error") toast.error(state.message, { duration: 10000 });
  }, [state]);

  const trigger = (
    <Button size="sm" variant={variant} disabled={disabled || isPending}>
      {isPending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : Icon ? (
        <Icon className="size-4" aria-hidden />
      ) : null}
      {isPending ? pendingLabel : label}
    </Button>
  );

  if (disabled) {
    return (
      <div className="space-y-1">
        {trigger}
        {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <form ref={formRef} action={formAction} className="hidden">
        {Object.entries(hiddenFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>

      <AlertDialog>
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => formRef.current?.requestSubmit()}>
              {confirmLabel ?? label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
