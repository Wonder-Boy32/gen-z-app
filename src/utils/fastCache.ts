// ============================================================
// src/utils/fastCache.ts
// ============================================================
// Two-layer cache so screens can paint before the network answers.
//
// THE PROBLEM THIS SOLVES
// Every screen used to gate on its own fetch:
//
//     const [loading, setLoading] = useState(true);
//     ...
//     return loading ? <SkeletonFeed /> : <FlatList ... />;
//
// So a returning user always paid a network round-trip before seeing anything,
// and because the FlatList did not exist yet, the first video had not even
// STARTED buffering. Two waits in series: fetch, then buffer.
//
// HOW THIS FIXES IT
//   memory  — populated by primeCache() once at startup, so a screen can read
//             its last-known data SYNCHRONOUSLY in the very first render.
//   disk    — AsyncStorage, survives app restarts.
//
// A cache hit means the list mounts on frame one and the first video begins
// buffering immediately, in parallel with the refresh.
//
// RULES
//   · This is a DISPLAY cache, never a source of truth. Always refresh behind it.
//   · Anything that can expire server-side (Moments expire after 48h) MUST be
//     re-filtered after hydration — see filterLive() below.
//   · Keys that belong to one user MUST include the user id, or a logout/login
//     on the same device shows the previous account's data.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'genz_cache:';
const memory = new Map<string, unknown>();

type Envelope<T> = { at: number; data: T };

/** Cache keys that belong to a specific account. */
export const cacheKey = {
  profile: (uid: string) => `profile:${uid}`,
  feed: (mode: string) => `feed:${mode}`,
} as const;

/** How long a cached value is still worth showing. Generous: it is only a
 *  first-paint placeholder and is always refreshed behind the user's back. */
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Load the given keys into memory BEFORE the first render.
 *
 * Call this once, early, and await it. After that peek() is synchronous, which
 * is the whole point — a screen can seed its state in useState's initialiser
 * instead of in a useEffect, so there is no empty first frame.
 */
export async function primeCache(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      if (memory.has(key)) return;
      try {
        const raw = await AsyncStorage.getItem(PREFIX + key);
        if (raw) memory.set(key, JSON.parse(raw) as Envelope<unknown>);
      } catch {
        // A corrupt or unreadable entry must never break startup.
      }
    })
  );
}

/**
 * Synchronous read. Returns null on a miss or when the entry is older than
 * maxAgeMs. Safe to call during render.
 */
export function peek<T>(key: string, maxAgeMs: number = CACHE_TTL_MS): T | null {
  const env = memory.get(key) as Envelope<T> | undefined;
  if (!env) return null;
  if (maxAgeMs > 0 && Date.now() - env.at > maxAgeMs) return null;
  return env.data;
}

/** Write through both layers. Never throws, never blocks the caller. */
export async function put<T>(key: string, data: T): Promise<void> {
  const env: Envelope<T> = { at: Date.now(), data };
  memory.set(key, env);
  try {
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(env));
  } catch {
    // Disk full or storage unavailable: the memory layer still works.
  }
}

/** Forget a key entirely. Used on logout so nothing leaks between accounts. */
export async function drop(key: string): Promise<void> {
  memory.delete(key);
  try {
    await AsyncStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/**
 * Drop cached copies that are past their server-side expiry.
 *
 * Moments are live for 48 hours. Without this, a cached feed would happily
 * show last week's expired Moments on launch — the exact opposite of what the
 * user expects from a freshness-first product.
 */
export function filterLive<T extends { expires_at?: string | null }>(items: T[]): T[] {
  const now = Date.now();
  return items.filter((it) => {
    if (!it.expires_at) return true;
    const t = Date.parse(it.expires_at);
    return Number.isNaN(t) ? true : t > now;
  });
}
