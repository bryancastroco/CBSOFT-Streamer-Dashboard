import { Badge } from "@/components/ui/badge";

/**
 * The game a piece of content was filed under.
 *
 * Shown on every content row once games are configured, because a filter nobody
 * can check is a filter nobody trusts: an admin who adds `#CabalMobile` needs to
 * see it take effect on the posts themselves, not infer it from a row count.
 *
 * The `title` carries how the attribution was decided. A post matched by its own
 * hashtag and a post inheriting its streamer's primary game are both correctly
 * filed, but only the first is evidence that the hashtag works — and that
 * distinction is what someone debugging their configuration is looking for.
 *
 * Renders nothing at all when no game is registered yet (`show` false), and an
 * explicit "No game" when games exist but this item matched none. The second is
 * a finding; the first is noise.
 */
export function GameBadge({
  name,
  source,
  show = true,
}: {
  name: string | null;
  source?: string | null;
  show?: boolean;
}) {
  if (!show) return null;

  if (!name) {
    return (
      <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
        No game
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      className="text-[10px] font-normal"
      title={
        source === "hashtag"
          ? "Matched by a hashtag in the text"
          : source === "streamer"
            ? "Inherited from the streamer's primary game"
            : undefined
      }
    >
      {name}
    </Badge>
  );
}
