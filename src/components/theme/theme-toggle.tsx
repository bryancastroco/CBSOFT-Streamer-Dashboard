"use client";

import { useTheme } from "next-themes";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/**
 * Theme switcher.
 *
 * The trigger icon is chosen by CSS, not by React state. The active theme is
 * only knowable in the browser, so rendering a sun on the server and a moon on
 * the client would be a hydration mismatch — the usual fix is a `mounted` flag
 * set in an effect, which costs a second render on every page. Rendering both
 * icons and letting the `dark:` variant hide one tracks the theme that is
 * actually applied, with no state and no mismatch.
 *
 * The menu items may read `theme` directly: Radix mounts the content only once
 * the menu is opened, which is necessarily after hydration.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change colour theme">
          <Sun className="size-4 dark:hidden" aria-hidden />
          <Moon className="hidden size-4 dark:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const isActive = theme === option.value;

          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setTheme(option.value)}
              aria-current={isActive ? "true" : undefined}
            >
              <Icon className="size-4" aria-hidden />
              {option.label}
              {isActive ? <Check className="ml-auto size-3.5" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
