"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert } from "lucide-react";

import { createStreamerAction } from "@/app/(app)/admin/streamers/actions";
import { idleState } from "@/lib/forms/action-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Validating token…" : "Add streamer"}
    </Button>
  );
}

/**
 * Add-streamer form.
 *
 * The token field is `type="password"` with autocomplete off: it must not be
 * shoulder-surfable, and no password manager should offer to remember it. The
 * value is submitted once, validated and encrypted server-side, and never
 * returned to this form — on error the field is left for the admin to re-paste
 * rather than being repopulated from the server.
 */
export function StreamerForm() {
  const [state, formAction] = useActionState(createStreamerAction, idleState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-6">
      {state.status === "error" && state.message ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="streamerName">Streamer name</Label>
          <Input id="streamerName" name="streamerName" required maxLength={120} autoFocus />
          <FieldError message={errors["streamerName"]} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="streamerCode">Internal streamer code</Label>
          <Input
            id="streamerCode"
            name="streamerCode"
            required
            placeholder="CBS-014"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Uppercase letters, digits and hyphens. Must be unique.
          </p>
          <FieldError message={errors["streamerCode"]} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="pageId">Facebook Page ID</Label>
          <Input
            id="pageId"
            name="pageId"
            required
            inputMode="numeric"
            placeholder="102938475610293"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Numeric Page ID, not the vanity URL. The token must belong to this Page.
          </p>
          <FieldError message={errors["pageId"]} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="pageName">Facebook Page name</Label>
          <Input id="pageName" name="pageName" required maxLength={120} />
          <FieldError message={errors["pageName"]} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pageAccessToken">Facebook Page access token</Label>
        <Input
          id="pageAccessToken"
          name="pageAccessToken"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Optional — can be added later"
        />
        <p className="text-xs text-muted-foreground">
          Validated against Meta before saving, then encrypted with AES-256-GCM. Only the ciphertext
          and the last four characters are stored — the token is never displayed again.
        </p>
        <FieldError message={errors["pageAccessToken"]} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} maxLength={4000} />
        <FieldError message={errors["notes"]} />
      </div>

      <div className="flex items-center gap-3">
        <Switch id="active" name="active" defaultChecked />
        <Label htmlFor="active" className="font-normal">
          Active — include this streamer in synchronisation and reports
        </Label>
      </div>

      <SubmitButton />
    </form>
  );
}
