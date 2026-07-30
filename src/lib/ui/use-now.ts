"use client";

import * as React from "react";

/**
 * The current minute, as a subscription rather than a read.
 *
 * `Date.now()` called during render is impure: it returns something different
 * on every render, so React cannot treat the component as idempotent, and the
 * server and the hydrating client disagree by however long the response took.
 * "3 min ago" rendered on the server and "4 min ago" on the client is a
 * hydration error.
 *
 * A clock is an external system, so it is subscribed to properly. The server
 * snapshot is `null`, which lets a caller render the absolute timestamp until
 * the client takes over and can say something relative.
 *
 * Ticks once a minute because nothing here displays seconds.
 */
const TICK_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = 0;

function subscribe(onChange: () => void) {
  listeners.add(onChange);

  if (timer === null) {
    snapshot = Date.now();
    timer = setInterval(() => {
      snapshot = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }

  return () => {
    listeners.delete(onChange);
    // The last subscriber leaving stops the timer; a dashboard left open on a
    // background tab should not keep waking for a badge nobody is reading.
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  // Seeded on first read so the value is correct before the first tick.
  if (snapshot === 0) snapshot = Date.now();
  return snapshot;
}

function getServerSnapshot(): null {
  return null;
}

export function useNow(): number | null {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** "just now", "12 min ago", "3 h ago", "2 d ago" — or null before hydration. */
export function useRelativeTime(iso: string | null | undefined): string | null {
  const now = useNow();

  if (!iso || now === null) return null;

  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return `${Math.round(hours / 24)} d ago`;
}
