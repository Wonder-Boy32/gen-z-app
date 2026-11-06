// ============================================================
// The rules for playing a post's attached sound.
//
// Pure, dependency-free, and deliberately separate from the React
// component that uses it — because the two bugs reported against the
// old inline version were both arithmetic, not rendering:
//
//   1. A stored `sound_end` past the real file length made the wrap
//      condition unreachable, so the track stopped when the bytes ran
//      out and the rest of the video played mute.
//   2. A track shorter than the video hit its real end, the player went
//      idle, and nothing restarted it — the wrap only fired while
//      `playing` was true.
//
// Both are testable without a phone. `scripts/test-sound-window.mjs`
// asserts them; if this file changes, that test must still pass.
// ============================================================

export type SoundWindow = {
  /** first second of the track that plays */
  from: number;
  /** second it wraps back to `from`, or null when nothing will be played */
  to: number | null;
};

/** how close to the end counts as "at the end", in seconds */
export const EDGE = 0.15;

/** a start this close to the end of the file is useless — pull it back */
const MIN_TAIL = 0.2;

/**
 * Resolve the window that playback will actually use.
 *
 * - `end` past the file is clamped to the file: the wrap must be reachable.
 * - `end` null or not after `from` means "to the end of the file".
 * - `from` past the file is pulled back, so a re-trim of a replaced track
 *   cannot seek past the bytes.
 * - `fileDur` 0 (not measured yet) leaves the window unclamped.
 */
export function resolveSoundWindow(
  start: number | null | undefined,
  end: number | null | undefined,
  fileDur: number
): SoundWindow {
  const dur = fileDur > 0 ? fileDur : 0;

  let from = Math.max(0, Number.isFinite(start as number) ? (start as number) : 0);
  if (dur > 0 && from > dur - MIN_TAIL) from = Math.max(0, dur - MIN_TAIL);

  let to: number | null;
  if (end != null && Number.isFinite(end) && end > from) {
    to = dur > 0 ? Math.min(end, dur) : end;
  } else {
    to = dur > 0 ? dur : null;
  }

  return { from, to };
}

export type LoopAction = 'wrap' | 'restart' | null;

/**
 * What to do with the current playback position.
 *
 * 'wrap'    — the window end has been reached while playing: seek to `from`
 *             and keep going.
 * 'restart' — the FILE ran out before the window did (the player went idle at
 *             the last sample). Seek to `from` and play again, otherwise the
 *             rest of the video is silent.
 * null      — nothing to do.
 */
export function loopAction(
  state: { currentTime: number; playing: boolean },
  window: SoundWindow,
  fileDur: number
): LoopAction {
  const t = state.currentTime;
  if (!Number.isFinite(t) || t < 0) return null;

  // playing, and inside the "about to end" band of the window
  if (state.playing && window.to != null && t >= window.to - EDGE) return 'wrap';

  // not playing, sitting at the very end of the file
  if (!state.playing && fileDur > 0 && t >= fileDur - 0.25) return 'restart';

  return null;
}
