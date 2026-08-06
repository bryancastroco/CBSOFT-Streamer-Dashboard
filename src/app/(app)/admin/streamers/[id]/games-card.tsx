"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { setStreamerGamesAction } from "@/app/(app)/admin/games/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { idleState } from "@/lib/forms/action-state";
import type { StreamerGameAssignment } from "@/lib/ui/game-shapes";

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" disabled={pending}>
      <Save className="size-4" aria-hidden />
      {pending ? "Saving…" : "Save games"}
    </Button>
  );
}

/**
 * Which games this streamer covers, and which one to assume.
 *
 * ## Why a primary exists at all
 *
 * The primary is the fallback for content with no matching hashtag — which is
 * nearly all of it. Measured on this project's own data, 102 of 1,624 posts
 * carry any hashtag. Without a primary, a streamer's archive stays invisible to
 * every game filter no matter how carefully the hashtags are configured.
 *
 * It is optional, and deliberately so. A streamer who genuinely splits their
 * output between two titles has no honest default, and inventing one would file
 * half their posts under the wrong game — worse than leaving them unattributed,
 * because a wrong answer looks like a right one in a report.
 *
 * The radio is disabled until its game is ticked: a primary outside the selected
 * set is a contradiction, and the repository drops it anyway.
 */
export function StreamerGamesCard({
  streamerId,
  options,
  assignments,
}: {
  streamerId: string;
  options: readonly { id: string; name: string }[];
  assignments: readonly StreamerGameAssignment[];
}) {
  const [state, formAction] = useActionState(setStreamerGamesAction, idleState);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(assignments.map((row) => row.gameId)),
  );
  const [primary, setPrimary] = useState<string>(
    () => assignments.find((row) => row.isPrimary)?.gameId ?? "",
  );

  useEffect(() => {
    if (!state.message) return;
    if (state.status === "success") toast.success(state.message);
    if (state.status === "error") toast.error(state.message);
  }, [state]);

  const toggle = (gameId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(gameId);
      else next.delete(gameId);
      return next;
    });

    // Unticking the primary clears it here too, so the form never submits a
    // combination the server has to silently correct.
    if (!checked && primary === gameId) setPrimary("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Games</CardTitle>
        <CardDescription>
          Which titles this streamer covers. The primary is what a post with no matching hashtag is
          filed under — most posts carry no hashtag, so without one this streamer&apos;s content
          stays outside every game filter.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No games registered yet.{" "}
            <Link href="/admin/games" className="underline underline-offset-4">
              Add one
            </Link>{" "}
            before assigning.
          </p>
        ) : (
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="streamerId" value={streamerId} />
            <input type="hidden" name="primaryGameId" value={primary} />

            <fieldset className="space-y-3">
              <legend className="sr-only">Games this streamer covers</legend>

              {options.map((game) => {
                const checked = selected.has(game.id);

                return (
                  <div key={game.id} className="flex flex-wrap items-center gap-3">
                    {/*
                     * Native inputs. A checkbox and a radio are exactly what
                     * this is, they submit inside a Server Action form without
                     * a hidden mirror, and they are keyboard- and
                     * screen-reader-correct with no ARIA of our own.
                     */}
                    <input
                      type="checkbox"
                      id={`game-${game.id}`}
                      name="gameIds"
                      value={game.id}
                      checked={checked}
                      onChange={(event) => toggle(game.id, event.target.checked)}
                      className="size-4 accent-primary"
                    />
                    <Label htmlFor={`game-${game.id}`} className="flex-1 text-sm font-normal">
                      {game.name}
                    </Label>

                    <label
                      className={`flex items-center gap-1.5 text-xs ${
                        checked ? "text-muted-foreground" : "text-muted-foreground/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="primaryChoice"
                        value={game.id}
                        checked={primary === game.id}
                        disabled={!checked}
                        onChange={() => setPrimary(game.id)}
                        className="size-3.5 accent-primary"
                      />
                      Primary
                    </label>
                  </div>
                );
              })}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Submit />
              {primary ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setPrimary("")}>
                  Clear primary
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
