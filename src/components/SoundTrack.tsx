import { useCallback, useEffect, useRef } from 'react';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { loopAction, resolveSoundWindow } from '../utils/soundWindow';

// ============================================================
// SoundTrack — plays a post's (or a draft's) attached sound.
// Renders nothing.
//
// This was SoundTrackSync inside FeedPost. It moved out for one
// concrete reason: the create/preview screen was drawing a bare
// <VideoView> with the upload's OWN audio, so picking a sound
// changed nothing you could hear until the post was published.
// The same windowing rules are needed in both places, and two
// copies of a loop rule drift apart, so there is one copy — and
// the rules themselves live in utils/soundWindow.ts, where a test
// can assert them without a phone.
//
// It is its own component for a second reason. useAudioPlayerStatus()
// hands back a fresh status object continuously while audio plays, so
// reading it inside a screen re-renders that whole subtree — including
// the native video surface, whose re-render competes with video decode
// and shows up as the picture breaking up. Keeping the subscription
// here means a tick re-renders this null component alone.
// ============================================================

type Props = {
  url: string | null;
  /** where in the track playback starts (seconds) */
  start?: number | null;
  /** where it wraps back to `start` (seconds). null = play to the file end */
  end?: number | null;
  /** the video this sound belongs to is on screen and playing */
  active: boolean;
};

/** minimum gap between two corrective seeks, in ms (see the loop effect) */
const SEEK_COOLDOWN = 350;

export default function SoundTrack({ url, start = 0, end = null, active }: Props) {
  // updateInterval 250 rather than the 500 default: the wrap decision is made
  // from currentTime, and at 500ms the track can run past its window end and go
  // idle between two ticks — the loop then only ever fires from the restart
  // path, one full pass late. Twice the ticks costs nothing for audio.
  //
  // keepAudioSessionActive: the video under this is muted, so if the session is
  // torn down between passes the restart can land after a short silence.
  const player = useAudioPlayer(url ?? null, {
    updateInterval: 250,
    keepAudioSessionActive: true,
  });
  const status = useAudioPlayerStatus(player);

  const fileDur = status.duration > 0 ? status.duration : 0;
  const win = resolveSoundWindow(start, end, fileDur);
  const from = win.from;
  const to = win.to;

  // Seek, then play once the seek has landed.
  //
  // seekTo() is async. Calling play() on the next line used to race it: on a
  // slow tick the seek resolved after playback resumed, from the old position —
  // which is how a wrapped track could replay the last fraction of a second.
  const jump = useCallback(
    (at: number) => {
      try {
        const r: any = player.seekTo(at);
        if (r && typeof r.then === 'function') {
          r.then(() => {
            try {
              player.play();
            } catch {
              /* disposed mid-seek */
            }
          }).catch(() => {});
        } else {
          player.play();
        }
      } catch {
        // player disposed mid-swap
      }
    },
    [player]
  );

  // Start / stop with the video. Re-arms at the window start when the video
  // comes back into view, and when the track itself changes.
  useEffect(() => {
    if (!url) return;
    if (active) {
      const ct = status.currentTime;
      const outOfWindow = ct < from - 0.05 || (to != null && ct >= to - 0.05);
      if (outOfWindow) jump(from);
      else player.play();
    } else {
      try {
        player.pause();
      } catch {
        /* disposed */
      }
    }
    // status.currentTime is READ but deliberately not tracked: depending on it
    // would re-seek on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, from, to, url, player, jump]);

  // The loop, and the reason this file exists.
  //
  // Two outcomes, both from utils/soundWindow.ts:
  //   'wrap'    — the window end was reached: back to `from`, keep going.
  //   'restart' — the file ran out before the window did (short track, long
  //               video): back to `from`, keep going. Without this the player
  //               sat idle and the rest of the video played in silence.
  //
  // The cooldown ref makes a correction fire once, not once per tick: seeking
  // is async, so for a tick or two currentTime still reads as "at the end",
  // and re-seeking there is audible as crackle and burns JS the video decode
  // needs.
  const lastSeekRef = useRef(0);
  useEffect(() => {
    if (!active || !url) return;
    const action = loopAction(
      { currentTime: status.currentTime, playing: status.playing },
      win,
      fileDur
    );
    if (!action) return;
    const now = Date.now();
    if (now - lastSeekRef.current < SEEK_COOLDOWN) return;
    lastSeekRef.current = now;
    jump(from);
    // `win` is rebuilt every render; the values inside it are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.currentTime, status.playing, active, url, from, to, fileDur, jump]);

  // A new track starts from its own beginning — the cooldown belongs to the
  // old one.
  useEffect(() => {
    lastSeekRef.current = 0;
  }, [url]);

  return null;
}
