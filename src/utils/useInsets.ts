import { Platform, StatusBar } from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Insets for the whole app. Two exports, because the codebase uses both styles:
 *
 *   TOP_INSET   — a plain number, for the ~45 screens/components that put
 *                 `paddingTop: TOP_INSET + n` in a StyleSheet. A StyleSheet is
 *                 built once at module load, so it cannot call a hook; this is
 *                 the only thing that works there.
 *   useInsets() — the real, live insets, for anything that can call a hook.
 *
 * WHY THE FLOOR EXISTS
 *
 * `StatusBar.currentHeight ?? 24` was the old definition, and it is wrong on
 * Android edge-to-edge. Edge-to-edge means the app window is laid out behind
 * the system bars, which is exactly what Expo SDK 54+ forces and what
 * `newArchEnabled: true` gives us: content draws UNDER the status bar unless it
 * is inset away. In that mode `StatusBar.currentHeight` is not a dependable
 * measurement of what we need to clear.
 *
 * Worse, `??` only falls back on null/undefined. If the getter returns 0 — the
 * tell-tale edge-to-edge value — `0 ?? 24` is 0, so the whole app silently
 * collapsed to `paddingTop: 0 + 8`. That is content sitting under the status
 * bar, and using `||` plus a real floor is what makes that impossible rather
 * than merely unlikely.
 *
 * 24dp is the floor because no Android phone has a status bar shorter than
 * that: a slightly-too-large inset is invisible, a too-small one cuts off the
 * top of a header. iOS reports 20 for a standard status bar.
 */
const ANDROID_STATUS_BAR_FLOOR = 24;
const IOS_STATUS_BAR = 20;

export const TOP_INSET: number =
  Platform.OS === 'android'
    ? Math.max(StatusBar.currentHeight || 0, ANDROID_STATUS_BAR_FLOOR)
    : IOS_STATUS_BAR;

/** Metrics captured natively at launch — available even before the provider reports. */
const WINDOW_INSETS = initialWindowMetrics?.insets;

/**
 * Live safe-area insets, with the same floor applied to `top`.
 *
 * The previous version wrapped useSafeAreaInsets() in a try/catch and returned
 * zeros on failure. That was wrong twice over: calling a hook inside a try/catch
 * can change the hook count between renders (a genuine crash risk), and
 * returning zeros meant a missing provider degraded silently into "no insets
 * anywhere" instead of being fixed. App.tsx now mounts the provider
 * unconditionally, which is what makes calling the hook directly safe.
 *
 * `top` is floored rather than trusted alone so that no future provider problem
 * can push content back under the status bar.
 */
export function useInsets(): { top: number; bottom: number; left: number; right: number } {
  const insets = useSafeAreaInsets();

  return {
    top: Math.max(insets.top, WINDOW_INSETS?.top ?? 0, TOP_INSET),
    bottom: Math.max(insets.bottom, WINDOW_INSETS?.bottom ?? 0),
    left: insets.left,
    right: insets.right,
  };
}
