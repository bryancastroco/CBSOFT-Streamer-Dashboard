"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { syncAllAction } from "@/app/(app)/dashboard/actions";
import { Button } from "@/components/ui/button";
import { idleState } from "@/lib/forms/action-state";

/**
 * One button, every streamer.
 *
 * Replaces a link that said "Sync all" and navigated to the roster instead —
 * which is worse than no button, because somebody clicking it and landing on a
 * list would reasonably conclude the sync had started.
 */
function Submit() {
  const { pending } = useFormStatus();

  return (
    /*
     * `disabled` is safe here, unlike the connect button.
     *
     * `useFormStatus` reports pending only once submission is already under
     * way, so disabling cannot cancel it. The connect page had to avoid this
     * because its pending state came from the click itself — see the note in
     * `connect/[token]/page-picker.tsx`.
     */
    <Button type="submit" size="sm" disabled={pending}>
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} aria-hidden />
      {pending ? "Syncing…" : "Sync all"}
    </Button>
  );
}

export function SyncAllButton() {
  const [state, formAction] = useActionState(syncAllAction, idleState);

  useEffect(() => {
    if (!state.message) return;

    /*
     * A long toast, deliberately. The summary carries counts an admin will want
     * to read — and on a partial sweep it carries the instruction to run it
     * again, which vanishing after four seconds would lose.
     */
    if (state.status === "success") toast.success(state.message, { duration: 12_000 });
    if (state.status === "error") toast.error(state.message, { duration: 15_000 });
  }, [state]);

  return (
    <form action={formAction}>
      <Submit />
    </form>
  );
}
