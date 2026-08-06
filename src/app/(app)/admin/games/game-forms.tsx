"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { CircleAlert, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteGameAction, saveGameAction } from "@/app/(app)/admin/games/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { idleState, type ActionState } from "@/lib/forms/action-state";
import type { GameRow } from "@/lib/ui/game-shapes";

/** Surfaces action results as toasts, matching every other admin form. */
function useActionToast(state: ActionState) {
  useEffect(() => {
    if (!state.message) return;
    if (state.status === "success") toast.success(state.message);
    if (state.status === "error") toast.error(state.message);
  }, [state]);
}

function Submit({
  children,
  pendingLabel,
  variant = "default",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline" | "destructive";
}) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

/**
 * Create or edit one game.
 *
 * Hashtags are a textarea rather than a repeating field set. Admins paste them
 * from a content calendar or a chat message, and a form that demands one entry
 * per box turns a paste into twenty clicks.
 */
export function GameForm({ game, onDone }: { game?: GameRow; onDone?: () => void }) {
  const [state, formAction] = useActionState(saveGameAction, idleState);
  useActionToast(state);

  useEffect(() => {
    if (state.status === "success") onDone?.();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4">
      {game ? <input type="hidden" name="id" value={game.id} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`name-${game?.id ?? "new"}`}>Game name</Label>
          <Input
            id={`name-${game?.id ?? "new"}`}
            name="name"
            defaultValue={game?.name ?? ""}
            placeholder="Cabal Mobile"
            required
            maxLength={120}
          />
          <FieldError message={state.fieldErrors?.["name"]} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`slug-${game?.id ?? "new"}`}>Slug</Label>
          <Input
            id={`slug-${game?.id ?? "new"}`}
            name="slug"
            defaultValue={game?.slug ?? ""}
            placeholder="Generated from the name"
            className="font-mono"
            maxLength={60}
          />
          {/* Derived when blank so nobody has to think about URLs, but
              editable so somebody who cares about the link can set it. */}
          <p className="text-xs text-muted-foreground">
            Used in filter links. Leave blank to derive it from the name.
          </p>
          <FieldError message={state.fieldErrors?.["slug"]} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`hashtags-${game?.id ?? "new"}`}>Hashtags</Label>
        <Textarea
          id={`hashtags-${game?.id ?? "new"}`}
          name="hashtags"
          defaultValue={game?.hashtags.map((tag) => `#${tag}`).join(" ") ?? ""}
          placeholder="#CabalMobile #CabalMSEA"
          rows={3}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Separate with spaces, commas or new lines. The <code>#</code> is optional and case does
          not matter. A post containing any of these is filed under this game, whichever streamer
          wrote it — so a hashtag can only belong to one game.
        </p>
        <FieldError message={state.fieldErrors?.["hashtags"]} />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`notes-${game?.id ?? "new"}`}>Notes</Label>
        <Textarea
          id={`notes-${game?.id ?? "new"}`}
          name="notes"
          defaultValue={game?.notes ?? ""}
          rows={2}
          maxLength={2000}
        />
      </div>

      <div className="flex items-center gap-3">
        <Switch id={`active-${game?.id ?? "new"}`} name="active" defaultChecked={game?.active ?? true} />
        <Label htmlFor={`active-${game?.id ?? "new"}`} className="text-sm font-normal">
          Offer this game in filters
        </Label>
      </div>

      <Submit pendingLabel="Saving…">
        <Save className="size-4" aria-hidden />
        {game ? "Save changes" : "Add game"}
      </Submit>
    </form>
  );
}

/** Deleting unfiles content rather than removing it, and the wording says so. */
function DeleteGame({ game }: { game: GameRow }) {
  const [state, formAction] = useActionState(deleteGameAction, idleState);
  useActionToast(state);

  const attributed = game.postCount + game.videoCount;

  return (
    <form action={formAction} className="space-y-3 border-t pt-4">
      <input type="hidden" name="id" value={game.id} />
      <input type="hidden" name="gameName" value={game.name} />

      <div className="space-y-2">
        <Label htmlFor={`confirm-${game.id}`} className="text-destructive">
          Type <span className="font-mono font-semibold">{game.name}</span> to delete
        </Label>
        <Input id={`confirm-${game.id}`} name="confirm" autoComplete="off" className="font-mono" required />
        <p className="text-xs text-muted-foreground">
          {attributed > 0
            ? `${attributed} post(s) and video(s) are filed under this. They are kept — they simply stop being attributed to a game.`
            : "Nothing is filed under this game yet."}
        </p>
      </div>

      <Submit pendingLabel="Deleting…" variant="destructive">
        <Trash2 className="size-4" aria-hidden />
        Delete game
      </Submit>
    </form>
  );
}

/**
 * The registry.
 *
 * Editing happens in place rather than on a separate route: there are only ever
 * a handful of games, and a round trip per edit would be more navigation than
 * the task deserves.
 */
export function GamesManager({ games }: { games: GameRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Games</CardTitle>
              <CardDescription>
                {games.length === 0
                  ? "None yet. Add the titles your streamers cover."
                  : `${games.length} game${games.length === 1 ? "" : "s"}.`}
              </CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant={adding ? "outline" : "default"}
              onClick={() => setAdding((open) => !open)}
            >
              <Plus className="size-4" aria-hidden />
              {adding ? "Cancel" : "Add game"}
            </Button>
          </div>
        </CardHeader>

        {adding ? (
          <CardContent className="border-t pt-4">
            <GameForm onDone={() => setAdding(false)} />
          </CardContent>
        ) : null}
      </Card>

      {games.map((game) => (
        <Card key={game.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {game.name}
                  <code className="font-mono text-xs font-normal text-muted-foreground">
                    {game.slug}
                  </code>
                  {!game.active ? <Badge variant="outline">Hidden from filters</Badge> : null}
                </CardTitle>
                <CardDescription>
                  {game.streamerCount} streamer{game.streamerCount === 1 ? "" : "s"} ·{" "}
                  {game.postCount} post{game.postCount === 1 ? "" : "s"} · {game.videoCount} video
                  {game.videoCount === 1 ? "" : "s"}
                </CardDescription>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing((open) => (open === game.id ? null : game.id))}
              >
                {editing === game.id ? "Close" : "Edit"}
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {game.hashtags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {game.hashtags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="font-mono text-xs font-normal">
                    #{tag}
                  </Badge>
                ))}
              </div>
            ) : (
              /*
               * Worth saying plainly. A game with no hashtags still works via
               * the streamer's primary game, but it can never pick a specific
               * post out of a streamer who covers several titles.
               */
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleAlert className="size-3.5" aria-hidden />
                No hashtags. Content reaches this game only through a streamer whose primary game
                it is.
              </p>
            )}

            {editing === game.id ? (
              <div className="space-y-4 border-t pt-4">
                <GameForm game={game} onDone={() => setEditing(null)} />
                <DeleteGame game={game} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
