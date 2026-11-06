import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ============================================================
// The create-draft store.
//
// WHY THIS EXISTS AT ALL: the create wizard was a tab that unmounts when you
// leave it (`{tab === 'post' && <CreateDropScreen/>}`), so state lived exactly
// as long as you stood on that tab. Switch to Chat to answer something, take a
// call, or let Android reclaim the app, and the caption, the picked clips and
// every edit were simply gone. The only thing that survived was a draft you had
// explicitly saved through a "Save as draft?" dialog, which nobody presses
// mid-flow.
//
// So the draft is written as you work, and the store is the place it lives.
// Local first, for three reasons:
//   * it must be instant — the "you have a draft" dot is read at app start;
//   * it must work offline — the moment you most need a save is the moment you
//     are being interrupted, often by a call, not by good wifi;
//   * a draft's media is a `file://` URI on THIS device, so a server copy was
//     never portable anyway.
//
// The Supabase `drafts` row is kept as a best-effort mirror (see
// CreateDropScreen). It is never the thing the UI reads.
// ============================================================

export type DraftMeta = {
  /** ms since epoch — what "2 minutes ago" is computed from */
  updatedAt: number;
  mode: 'media' | 'text';
  /** how many clips/photos are in it */
  mediaCount: number;
  /** first asset, for a thumbnail in the hub */
  thumb: string | null;
  /** one line of the caption, for the same reason */
  caption: string;
};

export type Draft = {
  meta: DraftMeta;
  /** the wizard's own shape; owned by CreateDropScreen */
  payload: Record<string, unknown>;
};

const KEY = 'genz.createDraft.v1';

let current: Draft | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a subscriber unmounted mid-notify
    }
  }
}

/** Has AsyncStorage been read yet? Until it has, nothing may be written over it. */
export function draftHydrated() {
  return loaded;
}

export function subscribeDraft(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getDraft(): Draft | null {
  return current;
}

/**
 * Read the stored draft. Safe to call on every mount: the second call is free.
 * A corrupt payload is dropped rather than crashing the create tab.
 */
export async function hydrateDraft(): Promise<Draft | null> {
  if (loaded) return current;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Draft;
      if (parsed && parsed.payload && parsed.meta) current = parsed;
    }
  } catch {
    current = null;
  }
  loaded = true;
  emit();
  return current;
}

/**
 * Write the draft. `updatedAt` defaults to now, which is what the hub shows.
 *
 * Returns synchronously-updated state even though the disk write is awaited —
 * so the dot and the banner can never show a stale answer while the write is
 * in flight.
 */
export async function writeDraft(
  payload: Record<string, unknown>,
  meta: Omit<DraftMeta, 'updatedAt'> & { updatedAt?: number }
): Promise<Draft> {
  const draft: Draft = { meta: { ...meta, updatedAt: meta.updatedAt ?? Date.now() }, payload };
  current = draft;
  loaded = true;
  emit();
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // out of space / storage unavailable: the in-memory copy still works for
    // this session, and the caller has already shown "saved".
  }
  return draft;
}

/** Adopt a draft that came from somewhere else (the cloud mirror). */
export function adoptDraft(draft: Draft | null) {
  if (!draft) return;
  current = draft;
  loaded = true;
  emit();
  void AsyncStorage.setItem(KEY, JSON.stringify(draft)).catch(() => {});
}

export async function clearDraft() {
  current = null;
  loaded = true;
  emit();
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // nothing to do — the pointer is already null
  }
}

/**
 * "Do I have a draft?" as a hook, for anything that wants to say so — the dock,
 * the hub, a settings row.
 */
export function useHasDraft(): boolean {
  const [has, setHas] = useState(() => !!current);
  useEffect(() => {
    const sync = () => setHas(!!current);
    const un = subscribeDraft(sync);
    // the store may hydrate after this component mounts
    sync();
    void hydrateDraft();
    return un;
  }, []);
  return has;
}

/** "just now" / "4 min ago" / "yesterday" — for the draft banner. */
export function draftAge(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
