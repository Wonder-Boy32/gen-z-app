// ============================================================
// Chat visual tokens + accessibility helpers.
//
// The visual language lives here so the bubbles, the list and the
// composer cannot drift apart. Values match the spec in
// MESSAGING_PARADISE_ARCHITECTURE.md §11.2.
// ============================================================

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { spacing } from '../../theme';

/** Our signature: a 2px vertical rail down incoming message runs. */
export const RAIL_WIDTH = 2;
export const RAIL_RADIUS = 1;

/** Tight gap inside a run, wide gap between runs (speaker change / long pause). */
export const GROUP_GAP = 3;
export const RUN_GAP = spacing.md;

/** Tail-less bubbles — the rail carries the attribution instead of a tail. */
export const BUBBLE_RADIUS = 18;
export const BUBBLE_RADIUS_TAIL = 6;

export const MAX_WIDTH_MINE = '84%' as const;
export const MAX_WIDTH_THEIRS = '78%' as const;

/** Motion. Every value here has a reduced-motion escape hatch. */
export const MOTION = {
  appear: 180,
  reaction: 220,
  composer: 140,
  moment: 260,
  call: 300,
} as const;

export const REACTION_BAR = ['❤️', '😂', '🔥', '👏', '😮', '💯'] as const;

// ------------------------------------------------------------
// Contrast guard (§11.7). A theme must not be able to destroy
// readability, so the foreground is DERIVED rather than trusted.
// ------------------------------------------------------------

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return 0;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

function isDark(hex: string): boolean {
  return luminance(hex) < 0.4;
}

/**
 * Returns `fg` if it reads on `bg` at WCAG AA (4.5:1), otherwise a safe
 * fallback. This is what makes §15's "customisation must not ruin
 * readability" structurally true instead of a warning in a settings screen.
 */
export function ensureReadable(fg: string, bg: string): string {
  if (contrastRatio(fg, bg) >= 4.5) return fg;
  return isDark(bg) ? '#FFFFFF' : '#111111';
}

/** Timestamps sit on the bubble but must stay legible on any palette. */
export function readableTime(preferred: string, bubbleBg: string): string {
  return contrastRatio(preferred, bubbleBg) >= 3 ? preferred : ensureReadable(preferred, bubbleBg);
}

// ------------------------------------------------------------
// Reduced motion — an accessibility requirement, not a preference.
// ------------------------------------------------------------

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => {
        /* platform without the API — animated is the safe default */
      });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value: boolean) => {
      if (mounted) setReduced(value);
    });

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return reduced;
}

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === today.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString([], opts);
}

/** A new run starts on a speaker change or a gap longer than 5 minutes. */
export const RUN_BREAK_MS = 5 * 60 * 1000;

/** The tail-less corner: the last bubble in a run gets one tighter corner. */
export function cornerFor(isMine: boolean, lastInRun: boolean): { borderBottomLeftRadius?: number; borderBottomRightRadius?: number } {
  if (lastInRun) return {};
  return isMine ? { borderBottomRightRadius: BUBBLE_RADIUS_TAIL } : { borderBottomLeftRadius: BUBBLE_RADIUS_TAIL };
}
