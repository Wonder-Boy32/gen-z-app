// ============================================================
// src/utils/coverPicker.ts
// ============================================================
// What "the best cover" means, stated in one place.
//
// THE BUG THIS ANSWERS
// The app used to take exactly ONE frame, hard-coded at 0.5 seconds, as the
// automatic cover. Videos routinely open on black, on a fade-in, on a title
// card, or on the tail of whatever was recorded before — so "automatic" often
// meant "a black tile in the feed". The user's report is the honest version of
// that: they want the app to choose well enough that forgetting to pick a cover
// is not a problem at all.
//
// THE POLICY
//   1. Scan SEVERAL start points across the video, never one. The windows come
//      from the duration and never sit in the closing seconds, where outros
//      fade to black.
//   2. Inside each window, ffmpeg's `thumbnail` filter picks the frame closest
//      to that window's average — representative rather than an accidental
//      outlier.
//   3. Score every candidate by average luma. A frame that is essentially
//      black, or blown out to white, loses to one carrying real midtones.
//   4. Never return nothing. Even if every candidate is poor, the least poor
//      one still beats a post with no cover image.
//
// This module is pure on purpose: no ffmpeg, no filesystem, no React. The
// scoring is therefore testable (scripts/test-cover-picker.mjs) instead of
// being a claim about a native binary.

/** Average luma (0-255) at or below this is treated as a black frame. */
export const LUMA_BLACK = 24;

/** The luma a well-exposed cover frame sits near. */
export const LUMA_IDEAL = 118;

/** Average luma at or above this is treated as blown out. */
export const LUMA_WHITE = 236;

/** How far the two extremes are from the ideal, for normalising the score. */
const SPAN = 137; // 255 - 118

/**
 * Where to look for a cover, given the clip's length.
 *
 * Returns start offsets in seconds. Short clips collapse to fewer windows
 * because a 1.5s video has no room for three of them — asking for a window
 * past the end just makes ffmpeg fail and wastes a decode.
 */
export function coverWindows(durationSec: number | null | undefined): number[] {
  const d =
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : 0;

  // Duration unknown (no probe, or a container that did not report one):
  // probe the opening at a few fixed points rather than giving up.
  if (d === 0) return [0, 2, 5];
  if (d < 2) return [0];

  const lastSafe = Math.max(0, d - 1.2); // never the closing second
  const wanted = [0, d * 0.12, d * 0.3];

  const out: number[] = [];
  for (const t of wanted) {
    const at = Math.round(Math.min(t, lastSafe) * 10) / 10;
    // Two windows on top of each other would decode the same frames twice.
    if (!out.some((x) => Math.abs(x - at) < 0.4)) out.push(at);
  }
  return out;
}

/**
 * Rate one candidate frame by its average luma.
 *
 * Returns 0 for a black frame, 1 for a well-exposed one, and something small
 * for a blown-out one — so a ranking always prefers usable midtones.
 */
export function coverScore(yavg: number): number {
  if (!Number.isFinite(yavg)) return 0;
  const y = Math.max(0, Math.min(255, yavg));

  // Black is a hard floor, not a slope. An "almost black" frame is still a
  // black tile in the feed, and a soft penalty let one win whenever it was the
  // only candidate that was not literally 0.
  if (y <= LUMA_BLACK) return (y / 255) * 0.2; // 0 … 0.019

  const centre = Math.max(0, 1 - Math.abs(y - LUMA_IDEAL) / SPAN); // 1 at 118, 0 at the ends
  const alive = Math.min(1, (y - LUMA_BLACK) / (LUMA_BLACK * 2)); // ramps in over the dark band
  const blown = y > LUMA_WHITE ? Math.max(0.05, 1 - (y - LUMA_WHITE) / 40) : 1;

  return centre * alive * blown;
}

export type CoverCandidate = { at: number; yavg: number };

/**
 * Pick the best candidate. Ties and unmeasurable frames fall back to the
 * middle window — the most representative part of a clip that opens on a
 * title card and closes on a fade.
 */
export function pickBestCover<T extends CoverCandidate>(cands: T[]): T | null {
  if (!cands.length) return null;

  let best: T | null = null;
  let bestScore = -1;
  let measurable = false;

  for (const c of cands) {
    if (!Number.isFinite(c.yavg)) continue; // no signalstats in this build
    measurable = true;
    const s = coverScore(c.yavg);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  if (measurable && best) return best;
  // Nothing could be measured: take the middle window rather than the opening
  // frame, which is exactly the one this module exists to avoid.
  return cands[Math.floor(cands.length / 2)] ?? cands[0];
}
