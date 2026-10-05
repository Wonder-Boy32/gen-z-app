// ============================================================
// src/utils/sharedClock.ts
// ============================================================
// ONE one-second tick for the whole app.
//
// THE PROBLEM
// DropCountdown ran `setInterval(() => setNow(Date.now()), 1000)` per INSTANCE,
// and TimeLeft ran one more at 30s.
//
// Be precise about the scale, because it is easy to overstate: DropCountdown is
// NOT rendered per feed post. It appears in the feed banner (one instance, or
// two via the live/voting branch), once per drop card in DiscoverScreen, and
// once in DropExperienceScreen. So this is a handful of timers, not dozens.
//
// The per-POST timer is TimeLeft in FeedPost, and it ticks at 30s, not 1s — so
// with ~5 rows mounted that is ~5 ticks every 30 seconds. Real, but small.
//
// Honest conclusion: this is a MINOR win, not the cause of general sluggishness.
// It is here because one shared timer is strictly better than N private ones and
// it costs nothing while idle. What actually made the UI slow was the missing
// memoisation in FeedPost.
//
// THE FIX
// A single interval, started only while at least one component is subscribed,
// notifying every subscriber on the same tick. Subscribing with `active=false`
// keeps a row silent while it is offscreen.
//
// Cost when idle: zero. The interval stops itself when the last listener leaves.
// ============================================================

import { useEffect, useState } from 'react';

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    // Snapshot: a listener may unsubscribe while we are notifying.
    for (const listener of Array.from(listeners)) listener(now);
  }, 1000);
}

function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Subscribe to the shared tick. Returns an unsubscribe function.
 * The current time is delivered immediately so nothing waits a full second to
 * show a value.
 */
export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  start();
  listener(Date.now());

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * The current time, updated once a second by the shared clock.
 *
 * Pass `active = false` for offscreen content: the value freezes rather than
 * ticking, so a post two screens away costs nothing. It refreshes the moment it
 * becomes active again.
 */
export function useSharedNow(active = true): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!active) return;
    return subscribeClock(setNow);
  }, [active]);

  return now;
}
