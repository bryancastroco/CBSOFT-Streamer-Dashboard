"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { setGameFilterOptionsAction } from "@/app/(app)/admin/games/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { idleState } from "@/lib/forms/action-state";
import type { GameFilterOptions } from "@/lib/settings/game-filter";

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" disabled={pending}>
      <Save className="size-4" aria-hidden />
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

/**
 * Which of the two wide views the Game control offers.
 *
 * Both off is the default and the right setting for a configured workspace: the
 * control reads as a list of games, and every screen lands on the catalogue.
 *
 * Both are worth turning on while a workspace is still being set up, when most
 * of the archive has no game and the figures on every screen are a fraction of
 * the truth. Which of those a workspace is in is not something the code can
 * tell, so it is stated here rather than guessed at — and the count on the card
 * above is the evidence for the decision.
 */
export function GameFilterOptionsCard({
  options,
  unattributed,
}: {
  options: GameFilterOptions;
  unattributed: number;
}) {
  const [state, formAction] = useActionState(setGameFilterOptionsAction, idleState);

  const [showAllContent, setShowAllContent] = useState(options.showAllContent);
  const [showUnregistered, setShowUnregistered] = useState(options.showUnregistered);

  useEffect(() => {
    if (!state.message) return;
    if (state.status === "success") toast.success(state.message);
    if (state.status === "error") toast.error(state.message);
  }, [state]);

  const bothHidden = !showAllContent && !showUnregistered;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What the Game filter offers</CardTitle>
        <CardDescription>
          Every screen with a Game control lists your registered games and defaults to{" "}
          <span className="font-medium">All games</span>. These two entries are wider than a single
          game, and are hidden unless you turn them on.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="space-y-5">
          {/*
           * Hidden inputs alongside the switches. A shadcn Switch is a button
           * rather than a checkbox, so it submits nothing of its own — without
           * these the form would post an empty body and both settings would
           * read as false.
           */}
          <input type="hidden" name="showAllContent" value={String(showAllContent)} />
          <input type="hidden" name="showUnregistered" value={String(showUnregistered)} />

          <div className="flex items-start gap-3">
            <Switch
              id="show-all-content"
              checked={showAllContent}
              onCheckedChange={setShowAllContent}
            />
            <div className="space-y-1">
              <Label htmlFor="show-all-content" className="text-sm font-normal">
                All content
              </Label>
              <p className="text-xs text-muted-foreground">
                The unfiltered view — everything, whether or not a game reaches it. Worth offering
                while the catalogue is incomplete, so a reader can still see the whole archive.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Switch
              id="show-unregistered"
              checked={showUnregistered}
              onCheckedChange={setShowUnregistered}
            />
            <div className="space-y-1">
              <Label htmlFor="show-unregistered" className="text-sm font-normal">
                Not registered games
              </Label>
              <p className="text-xs text-muted-foreground">
                Content no game reaches. A configuration view rather than a reading one — the links
                above open it whether or not this is on.
              </p>
            </div>
          </div>

          {/*
           * Stated rather than left to be discovered. With both off and a
           * catalogue that reaches little of the archive, every screen shows a
           * small fraction of it and nothing on those screens explains why.
           */}
          {bothHidden && unattributed > 0 ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-500">
              With both hidden, {unattributed.toLocaleString("en-GB")} item
              {unattributed === 1 ? "" : "s"} cannot be reached from any screen — the Game filter
              has no setting that includes them. Registering more hashtags, or setting a primary
              game on each streamer, is what shrinks that number.
            </p>
          ) : null}

          <Submit />
        </form>
      </CardContent>
    </Card>
  );
}
