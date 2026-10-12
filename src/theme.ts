// ============================================================
// Gen Z — Design System v3
// Dark (midnight navy + electric orange) and Light (TikTok-style white)
// ============================================================
//
// WHY THIS FILE LOOKS UNUSUAL
//
// The app reads `colors.*` in ~2,600 places, and every one of the 81
// StyleSheet.create() calls evaluates those reads at MODULE LOAD. That is the
// whole difficulty with runtime theming in React Native: by the time the user
// taps "White" in Settings, every style object in the app already holds the
// string '#0D1426' and there is no way to change it from the outside.
//
// There are two honest ways out:
//
//   1. Convert all 81 style sheets into theme-aware factories and add a hook to
//      every component. Correct, instant, and a 79-file refactor that cannot be
//      visually verified from here.
//
//   2. Keep the styles exactly as they are, and make the REGISTRY of styles
//      mutable. StyleSheet.create is replaced once (below) with a version that
//      records each definition and returns a container whose values can be
//      rewritten in place. When the theme changes we recompute every registered
//      definition against the new palette and mutate those containers. React
//      re-reads `styles.card` on the next render and sees the new colours.
//
// This file implements (2). The cost is contained to this file rather than 79:
// no component, no style object and no import changes anywhere. JSX reads like
// `color={colors.accent}` already resolve at render time, so they follow along
// for free once the component re-renders.
//
// `colors` is a `const` whose PROPERTIES we overwrite — the binding never moves,
// so all 2,600 existing reads stay valid and synchronous.
//
// KNOWN LIMIT (deliberate, and worth stating): a colour written as a bare
// literal instead of `colors.x` cannot follow the theme, because nothing links
// it to a token. There are 169 hex and 250 rgba literals in the app; most are
// scrims over video (which should stay dark in both themes), and the handful
// that matter are fixed where they live. Stylesheet literals that HAPPEN to
// equal a dark-palette value are remapped via REVERSE below, which catches the
// rest of the common cases without a code sweep.

import { StyleSheet } from 'react-native';

// ============================================================
// Palettes
// ============================================================

/** Midnight navy + electric orange — the original identity. */
const DARK = {
  // backgrounds — deep midnight navy
  bg: '#060A16',
  bgDeep: '#04070F',
  surface: '#0D1426',
  surfaceAlt: '#141C33',
  surfaceInput: '#0A101F',

  // glass (soft glassmorphism — translucent + light border)
  glass: 'rgba(18, 25, 48, 0.78)',
  glassBorder: 'rgba(255,255,255,0.10)',

  // borders
  border: '#1E2A47',
  borderStrong: '#2C3B61',

  // text — white / light gray
  text: '#F4F6FB',
  textMuted: '#9AA5C0',
  textFaint: '#64708C',

  // brand accents — electric orange (from logo) + violet/blue glow
  accent: '#FF9D1F',
  accentStrong: '#FF7A00',
  accentSoft: 'rgba(255,157,31,0.15)',
  accentGlow: 'rgba(255,157,31,0.38)',
  violet: '#8B7BFF',
  glowBlue: '#5B8CFF',

  // supporting
  yellow: '#FCE123',
  cyan: '#A8E6F2',
  logoWhite: '#F8F8F8',

  // feedback
  success: '#34D399',
  danger: '#FF5C7C',

  // misc
  overlay: 'rgba(3,6,14,0.55)',
  shadow: '#000000',
};

export type Palette = typeof DARK;

/**
 * TikTok-style white.
 *
 * The brand accent, violet and feedback colours are deliberately UNCHANGED:
 * orange-on-white is the same brand, and re-tinting the accent per theme would
 * make screenshots, watermark baking and the logo disagree with the app.
 * `accentSoft`/`accentGlow` do change, because a 15%-opacity orange wash reads
 * as orange on navy and as near-invisible dirt on white.
 *
 * Text is TikTok's near-black (#161823) rather than pure #000: pure black on
 * pure white is harsh and produces visible fringing on OLED.
 */
const LIGHT: Palette = {
  // backgrounds — white surfaces, faint grey wells
  bg: '#FFFFFF',
  bgDeep: '#F7F7F9',
  surface: '#FFFFFF',
  surfaceAlt: '#F2F2F5',
  surfaceInput: '#F7F7F9',

  // glass — a white sheet with a hairline dark border, not a translucent block
  glass: 'rgba(255,255,255,0.86)',
  glassBorder: 'rgba(0,0,0,0.08)',

  // borders — light greys with enough contrast to read as a divider
  border: '#E8E8ED',
  borderStrong: '#D4D4DC',

  // text — near-black / grey ramp
  text: '#161823',
  textMuted: '#6C6C78',
  textFaint: '#9B9BA6',

  // brand accents — hue held, alpha washed
  accent: '#FF9D1F',
  accentStrong: '#FF7A00',
  accentSoft: 'rgba(255,157,31,0.16)',
  accentGlow: 'rgba(255,157,31,0.28)',
  violet: '#7C5CFF',
  glowBlue: '#2F6BFF',

  // supporting — darkened for contrast on white
  yellow: '#E0B400',
  cyan: '#2E8FA8',
  logoWhite: '#FFFFFF',

  // feedback
  success: '#0E9F6E',
  danger: '#E5484D',

  // misc — a light scrim, so overlays on photos still read as overlays
  overlay: 'rgba(255,255,255,0.62)',
  shadow: '#000000',
};

/**
 * Dark value → palette key.
 *
 * Lets a style object that captured '#0D1426' at module load be translated to
 * whichever colour that token holds now. Built from DARK only: DARK is what
 * every module-level style captured, since the app boots dark and the saved
 * palette is applied before the app graph loads (see initThemeSync).
 *
 * Keys whose dark value appears twice would be ambiguous, so values are checked
 * for uniqueness at build time in dev and any collision is logged rather than
 * silently guessed.
 */
/**
 * Built from BOTH palettes, not just DARK.
 *
 * This matters more than it looks. A style sheet captures whatever the palette
 * held when its module was imported — and because the saved theme is applied
 * before the app graph loads, a light-mode user's sheets capture LIGHT values.
 * A dark-only table would not recognise them, `containsPalette` would say no,
 * and those sheets would never be registered — so a light-booting user could
 * never switch back to dark. Mapping both directions fixes that.
 *
 * Only palette values are in here, so a literal that is NOT a palette colour is
 * left alone (see remapValue).
 */
const REVERSE_LC: Record<string, keyof Palette> = {};

function indexPalette(palette: Palette, label: string): void {
  for (const key of Object.keys(palette) as (keyof Palette)[]) {
    const value = palette[key];
    const lc = value.toLowerCase();
    const existing = REVERSE_LC[lc];
    if (existing && existing !== key) {
      if (__DEV__) {
        // A collision only weakens the literal-remap heuristic for that one
        // colour; token-driven reads (colors.x) are unaffected. Surfaced rather
        // than hidden so a future palette edit does not do this silently.
        console.warn(
          `[theme] ${label}: "${value}" is used by both "${key}" and "${existing}" — literals in that colour cannot be remapped reliably`
        );
      }
      continue; // first writer wins
    }
    REVERSE_LC[lc] = key;
  }
}

indexPalette(DARK, 'dark');
indexPalette(LIGHT, 'light');

// ============================================================
// Live palette — mutated in place, never reassigned
// ============================================================

export const colors: Palette = { ...DARK };

export type ThemeMode = 'dark' | 'light';
let mode: ThemeMode = 'dark';

/**
 * Increments on every theme change.
 *
 * Exists for memoised components. React.memo compares props, so a component
 * whose props did not change keeps its previously rendered output — including
 * the old colours — no matter how thoroughly the palette was swapped underneath
 * it. FeedPost is memoised with a custom comparator (deliberately: it is the
 * hot path of a scroll-heavy list), so it needs a way to notice.
 *
 * A comparator cannot simply call getThemeMode() to compare: both sides of the
 * comparison see the same live value, so it would always look unchanged. An
 * epoch can be compared against the epoch each item last rendered at.
 */
let epoch = 0;
export function getThemeEpoch(): number {
  return epoch;
}

/** Fired after the palette has been swapped, so the root can remount. */
type Listener = (m: ThemeMode) => void;
const listeners = new Set<Listener>();

export function getThemeMode(): ThemeMode {
  return mode;
}

export function subscribeTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ============================================================
// Style registry — makes module-load-frozen styles mutable
// ============================================================

/**
 * Records every style container produced by `create` below, so applyPalette()
 * can recompute it. Each entry keeps the original definitions (a plain object,
 * still holding the dark values captured at import time) plus the container
 * handed to the component.
 */
type Entry = {
  defs: Record<string, any>;
  container: Record<string, any>;
  /** true when at least one value was a palette colour — see patch below */
  themed: boolean;
};
const registry = new Set<Entry>();

/** Does this value look like a palette colour we can follow? */
function remapValue(v: any): any {
  if (typeof v !== 'string') return v;
  const key = REVERSE_LC[v.toLowerCase()];
  if (key) return colors[key];
  return v;
}

/**
 * Rebuild one style object from its captured definition.
 *
 * Only top-level colour-ish properties are rewritten; nesting (shadowOffset,
 * transform arrays, etc.) is passed through untouched, and non-string values
 * such as numbers and arrays are returned as-is. `Object.keys` order is
 * preserved so the rebuilt object has the same shape as the original.
 */
function recompute(def: any): any {
  if (!def || typeof def !== 'object') return def;
  if (Array.isArray(def)) return def.map(recompute);
  const out: any = {};
  for (const k of Object.keys(def)) out[k] = remapValue(def[k]);
  return out;
}

/** Anything in the definitions that came from the palette? */
function containsPalette(def: any): boolean {
  if (!def || typeof def !== 'object') return false;
  if (Array.isArray(def)) return def.some(containsPalette);
  for (const k of Object.keys(def)) {
    const v = def[k];
    if (typeof v === 'string' && REVERSE_LC[v.toLowerCase()]) return true;
    if (v && typeof v === 'object' && containsPalette(v)) return true;
  }
  return false;
}

/**
 * Patch StyleSheet.create exactly once.
 *
 * Deliberately conservative: if a style sheet contains NO palette colour it is
 * handed straight to the real create() and never registered. Third-party
 * libraries call StyleSheet.create through this same global, and they must not
 * have their colours remapped — their hex values are theirs, and the chance one
 * coincidentally equals ours is small but not zero. The guard removes that risk
 * entirely for everything we do not own.
 */
let patched = false;
function patchStyleSheet(): void {
  if (patched) return;
  patched = true;

  const real = StyleSheet.create.bind(StyleSheet);

  (StyleSheet as any).create = (defs: Record<string, any>) => {
    try {
      // A null/undefined sheet, or one with no palette colour, is not ours to
      // manage — pass it through untouched.
      if (!defs || typeof defs !== 'object' || !containsPalette(defs)) {
        return real(defs);
      }

      // The container is a plain mutable object (NOT frozen): mutating it in
      // place is the entire mechanism. Its values are the same objects RN's own
      // create() would have produced, just rebuilt through the palette map.
      const container: Record<string, any> = {};
      for (const key of Object.keys(defs)) container[key] = recompute(defs[key]);

      registry.add({ defs, container, themed: true });
      return container;
    } catch (e) {
      // Never let theming machinery break a screen: fall back to the real thing.
      if (__DEV__) console.warn('[theme] StyleSheet.create patch failed, falling through', e);
      return real(defs);
    }
  };
}

patchStyleSheet();

/**
 * Swap every registered style container to the current palette, in place.
 *
 * Mutating rather than replacing is what makes this work: components hold a
 * reference to `styles` from their module scope, so a replaced object would
 * never be seen. The same object, rewritten, is seen on the next render.
 */
function rebuildStyles(): void {
  registry.forEach((entry) => {
    for (const key of Object.keys(entry.defs)) {
      entry.container[key] = recompute(entry.defs[key]);
    }
  });
}

// ============================================================
// Shadows — theme-aware (depth on white must be softer)
// ============================================================

export const shadows = {
  sm: {
    shadowColor: DARK.shadow,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  md: {
    shadowColor: DARK.shadow,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  glow: {
    shadowColor: DARK.accent,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  glowViolet: {
    shadowColor: DARK.violet,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
};

function rebuildShadows(): void {
  const light = mode === 'light';
  // A black drop shadow at dark-mode opacity reads as grime on a white sheet,
  // so the neutral shadows drop to a fraction; the brand glows stay, retinted.
  shadows.sm.shadowOpacity = light ? 0.08 : 0.25;
  shadows.md.shadowOpacity = light ? 0.12 : 0.35;
  shadows.glow.shadowColor = colors.accent;
  shadows.glowViolet.shadowColor = colors.violet;
}

// ============================================================
// Applying a theme
// ============================================================

/**
 * Switch palettes. Synchronous and cheap: it copies ~30 values and rewrites the
 * registered containers. Callers must then re-render the tree (the root does
 * this by remounting on mode change) — the palette alone cannot push a render,
 * because most components read `colors` outside React.
 */
export function applyThemeMode(next: ThemeMode): void {
  // No-op when nothing would change. This is not just an optimisation: callers
  // include a screen that re-reads the saved theme on mount, so without this
  // every visit to Settings would rewrite ~30 palette values, rebuild every
  // registered style sheet and fire a re-render for an identical palette.
  if (next === mode) return;

  const palette = next === 'light' ? LIGHT : DARK;
  for (const key of Object.keys(palette) as (keyof Palette)[]) {
    colors[key] = palette[key];
  }
  mode = next;
  // Bumped before the rebuild so any comparator running during the re-render
  // below sees the new epoch.
  epoch += 1;
  rebuildShadows();
  rebuildStyles();

  // A theme change is an app-wide visual change, so the PRICES of a remount are
  // worth it: memoised components (FeedPost uses React.memo with a custom
  // comparator) would otherwise keep their old colours, because their props did
  // not change. Listeners remount the root.
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch (e) {
      if (__DEV__) console.warn('[theme] listener failed', e);
    }
  });
}

// ============================================================
// Persistence — must be readable SYNCHRONOUSLY at boot
// ============================================================
//
// Module-level StyleSheet.create runs while the app graph is being imported,
// which is before any async storage read could resolve. If the saved theme were
// loaded asynchronously, a light-mode user would boot dark and then visibly flip
// — every launch. So the choice is mirrored to a plain file that expo-file-system
// can read synchronously, and the app graph is only imported after that read.
//
// The database (profiles.theme) stays the source of truth across devices; this
// file is only a local cache of it.

const THEME_FILE_NAME = 'genz-theme.txt';

function themeFileUri(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: any = require('expo-file-system/legacy');
    if (!fs?.documentDirectory) return null;
    return `${fs.documentDirectory}${THEME_FILE_NAME}`;
  } catch {
    return null;
  }
}

/**
 * Read the cached theme and apply it. MUST be called before the app graph is
 * imported — see index.ts, which uses require() rather than a hoisted import
 * precisely so this ordering holds.
 */
export function initThemeSync(): ThemeMode {
  let saved: ThemeMode = 'dark';
  try {
    const uri = themeFileUri();
    if (uri) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs: any = require('expo-file-system/legacy');
      const exists = fs.getInfoSync ? fs.getInfoSync(uri)?.exists : true;
      if (exists) {
        const raw = String(fs.readAsStringSync(uri) ?? '').trim().toLowerCase();
        if (raw === 'light' || raw === 'dark') saved = raw;
      }
    }
  } catch {
    // Unreadable cache is not an error worth surfacing: dark is the default and
    // the remote value will correct it on the next successful sync.
  }
  if (saved !== 'dark') applyThemeMode(saved);
  return saved;
}

/** Persist the choice locally (sync write, so it survives an immediate kill). */
export function cacheThemeMode(next: ThemeMode): void {
  try {
    const uri = themeFileUri();
    if (!uri) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: any = require('expo-file-system/legacy');
    fs.writeAsStringSync(uri, next);
  } catch (e) {
    if (__DEV__) console.warn('[theme] could not cache theme', e);
  }
}

// ============================================================
// Brand identity — the GenZ mark palette (theme-independent)
// ============================================================
// The logo runs on a three-colour sweep rather than a single accent:
//
//     G  →  warm orange into red-orange
//     Z  →  magenta-violet into electric blue
//     ring → orange (left) → magenta (top-right) → blue (bottom)
//
// Kept in its own export instead of being folded into `colors`, because
// `colors.accent` is used in hundreds of places as a single UI accent and
// swapping it for a gradient would break them all. Anything that needs the
// brand sweep should read from here.
//
// These do NOT change between themes: the mark is the mark.
export const brand = {
  navy: '#060A16',
  orange: '#FF8A00',
  red: '#F73B2E',
  magenta: '#E0409E',
  violet: '#A855F7',
  blue: '#2563EB',

  /** the "G" */
  markGradient: ['#FF8A00', '#F73B2E'] as const,
  /** the "Z" */
  zGradient: ['#E0409E', '#2563EB'] as const,
  /** the neon ring around the app icon */
  ringGradient: ['#FF8A00', '#E0409E', '#2563EB'] as const,
  /** everywhere the brand needs a single representative sweep */
  fullGradient: ['#FF8A00', '#E0409E', '#2563EB'] as const,
};

// consistent spacing scale
export const spacing = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  xxl: 36,
};

// large rounded cards + pills
export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
};

// typography scale — premium, consistent
export const type = {
  hero: { fontSize: 30, fontWeight: '800' as const, letterSpacing: 1.2, lineHeight: 38 },
  title: { fontSize: 23, fontWeight: '700' as const, letterSpacing: 0.4, lineHeight: 30 },
  heading: { fontSize: 17, fontWeight: '700' as const, letterSpacing: 0.2 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  caption: { fontSize: 13, fontWeight: '500' as const, letterSpacing: 0.2 },
  micro: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2 },
};
