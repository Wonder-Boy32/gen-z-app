import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { colors } from '../theme';
import Icon from './ui/Icon';
import VideoLoader from './ui/VideoLoader';
import { getFilterGlow, getFilterTint } from './create/FilterCarousel';

// ============================================================
// DropVideoView — plays a drop's video and applies its stored
// creator metadata at playback time:
//   trim    → plays only [start, end], loops back
//   speed   → playbackRate
//   rotation→ container transform
//   filter / effect → tint overlays (UI-level)
//   text layers + stickers → positioned overlays
// Works everywhere: feed, discover, search, drops, profile.
// ============================================================

export type DropEffects = {
  effect?: string | null;
  speed?: number | null;
  ratio?: string | null;
  rotation?: number | null;
  trim?: { start: number; end: number } | null;
  collage?: string | null;
};

export type DropTextLayer = {
  text: string;
  color?: string;
  size?: number;
  bold?: boolean;
  x?: number;
  y?: number;
};

export type DropSticker = { emoji: string; x?: number; y?: number; size?: number };

export function parseDropEffects(raw: unknown): DropEffects | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as DropEffects;
}

const EFFECT_TINTS: Record<string, string> = {
  none: 'rgba(0,0,0,0)',
  bloom: 'rgba(255,255,255,0.12)',
  neon: 'rgba(255,45,220,0.16)',
  vhs: 'rgba(90,220,160,0.14)',
  bw: 'rgba(96,102,118,0.45)',
  glow: 'rgba(139,123,255,0.24)',
};

type Props = {
  url: string;
  effects?: DropEffects | null;
  filters?: { id?: string; label?: string }[] | null;
  textLayers?: DropTextLayer[] | null;
  stickers?: DropSticker[] | null;
  isActive?: boolean;
  /** true when this is the NEXT item in a pager: the source is loaded and
   *  played MUTED ahead of time so that when it becomes active the video is
   *  already buffered and starts instantly */
  preload?: boolean;
  /** true for the item two pages ahead: fetch its bytes but never take a
   *  decoder to render them. See the note on `warm` in the component. */
  warm?: boolean;
  /** the post's cover image — held on screen until the first frame paints */
  poster?: string | null;
  paused?: boolean;
  showProgress?: boolean;
  showMute?: boolean;
  contentFit?: 'cover' | 'contain';
  style?: any;
  /** start the video muted (used when an added sound track plays instead) */
  forceMute?: boolean;
  /** tap layer above the video (double-tap to like etc.) — the native
   *  player surface swallows touches, so callers pass handlers here */
  onTap?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
};

export default function DropVideoView({
  url,
  effects,
  filters,
  textLayers,
  stickers,
  isActive = true,
  preload = false,
  warm = false,
  poster = null,
  paused = false,
  showProgress = false,
  showMute = true,
  contentFit = 'cover',
  style,
  forceMute = false,
  onTap,
  onHoldStart,
  onHoldEnd,
}: Props) {
  const [muted, setMuted] = useState(false);
  const [progress, setProgress] = useState(0);
  const loadedUrlRef = useRef<string | null>(null);
  const userMutedRef = useRef(false);

  const trim = effects?.trim && effects.trim.end > effects.trim.start ? effects.trim : null;
  const speed = effects?.speed && effects.speed > 0 ? effects.speed : 1;
  const rotation = effects?.rotation ?? 0;
  const filterId = filters?.[0]?.id ?? null;
  const filterTint = filterId ? getFilterTint(filterId) : null;
  const filterGlow = filterId ? getFilterGlow(filterId) : null;
  const effectTint = effects?.effect ? EFFECT_TINTS[effects.effect] ?? null : null;

  // create the player WITHOUT a source — the video only loads when this
  // item becomes active (or is the preload target). Keeps at most ONE
  // native video player alive in paging feeds/viewers, which removes
  // scroll lag.
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.playbackRate = speed;
    // Start-first buffer tuning.
    //
    // Android's default is to wait for ~2.5s of buffer before the first frame
    // and to keep 20s ahead. For a feed of 15-30s vertical clips that is the
    // wrong trade: it makes every swipe pay a startup delay to guarantee
    // smoothness nobody needs. Asking for 0.75s to start (still above the
    // stutter floor on a phone screen) and 10s ahead cuts time-to-first-frame
    // without going back to the demuxer for a refill mid-clip.
    //
    // Verified against expo-video 57's own typings (BufferOptions): all four
    // keys exist; `minBufferForPlayback` is Android-only and is ignored when
    // `preferredForwardBufferDuration` is lower, so the two are set together
    // and deliberately ordered (duration 10 > min 0.75).
    try {
      p.bufferOptions = {
        preferredForwardBufferDuration: 10,
        minBufferForPlayback: 0.75,
        prioritizeTimeOverSizeThreshold: true,
      };
    } catch {
      // Older native builds reject the object — the defaults still work.
    }
  });

  // ---- load state -------------------------------------------------------
  //
  // 'idle' | 'loading' | 'readyToPlay' | 'error', straight from the player.
  // `ready` is what hides the loader; `error` stops it, because a spinner that
  // never ends is the worst thing this component can do.
  const [status, setStatus] = useState<string>('idle');
  const [bufferP, setBufferP] = useState(0);
  const [hidden, setHidden] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status: next }: any) => {
      setStatus(next);
    });
    return () => sub.remove();
  }, [player]);

  // The real buffered fraction, polled — NOT taken from timeUpdate.
  //
  // timeUpdate is driven by playback position, so while a clip is still
  // fetching there is nothing to report and the events are sparse. A loader
  // fed from them would sit at 0% and then jump to gone. bufferedPosition is
  // a plain getter that ExoPlayer keeps current whether or not it is playing,
  // so a 200ms tick while loading is both accurate and cheap (it stops the
  // moment the video is ready).
  useEffect(() => {
    if (status === 'readyToPlay' || status === 'error' || !url) return;
    const tick = () => {
      const dur = player.duration;
      const buf = player.bufferedPosition;
      if (dur && dur > 0 && buf >= 0) setBufferP(Math.min(1, buf / dur));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [status, url, player]);

  // Fade the loader out a beat AFTER readyToPlay.
  //
  // ExoPlayer reports readyToPlay when it can decode, which is one frame
  // before the first frame is actually on the surface — hiding on the event
  // itself still shows a black flash. 140ms covers that hand-off, and the
  // fade means the cover never disappears in one hard cut.
  useEffect(() => {
    if (!url) return;
    if (status === 'error') {
      fade.setValue(0);
      setHidden(true);
      return;
    }
    if (status !== 'readyToPlay') return;
    const t = setTimeout(() => {
      Animated.timing(fade, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setHidden(true);
      });
    }, 140);
    return () => clearTimeout(t);
  }, [status, url, fade]);

  const retry = () => {
    if (!url) return;
    setHidden(false);
    setStatus('loading');
    setBufferP(0);
    fade.setValue(1);
    loadedUrlRef.current = url;
    player.replace({ uri: url });
    player.play();
  };

  // load the source when this item is active OR is the next (preload)
  // target. If it's only being preloaded, play it MUTED so the data
  // actually downloads and buffers — when it becomes active the video
  // starts instantly instead of waiting on a cold network load.
  // Never re-replace() a source we already loaded (that would restart it).
  useEffect(() => {
    if (!url) return;
    // `warm` (two pages ahead) is admitted to the same branch: replacing the
    // source makes ExoPlayer prepare and buffer the opening segment even while
    // paused. It fetches bytes without holding a decoder to paint them, which
    // is what keeps a third simultaneous decoder from being allocated on the
    // phones that only have two.
    if (loadedUrlRef.current !== url && (isActive || preload || warm)) {
      loadedUrlRef.current = url;
      player.replace({ uri: url });
      // a fresh source means the old load state is meaningless
      setHidden(false);
      setStatus('loading');
      setBufferP(0);
      fade.setValue(1);
    }
    if (!isActive && !preload) {
      player.pause();
    } else if (!isActive && preload) {
      // buffer offscreen: muted play; real mute state restored on activation
      player.muted = true;
      player.play();
    }
  }, [isActive, preload, warm, url, player, fade]);

  // trim loop + progress
  //
  // Progress is React state, so every write re-renders this whole subtree —
  // the video surface AND every overlay on top of it. `timeUpdate` fires far
  // more often than a progress bar can be seen to move, so the old code spent
  // much of each second re-rendering over a decoding video. That render work
  // competes with video decode and shows up as the picture breaking up.
  //
  // Only publish a change the bar can actually show (~1%).
  const progressRef = useRef(0);
  const pushProgress = (v: number) => {
    const next = Math.max(0, Math.min(v, 1));
    if (Math.abs(next - progressRef.current) < 0.01) return;
    progressRef.current = next;
    setProgress(next);
  };

  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('timeUpdate', (e: any) => {
      const t = e.currentTime;
      if (trim && t != null) {
        if (t >= trim.end) player.currentTime = trim.start;
        const span = trim.end - trim.start;
        if (span > 0) pushProgress((t - trim.start) / span);
      } else {
        const dur = player.duration;
        if (dur && dur > 0 && t != null) pushProgress(t / dur);
      }
    });
    return () => sub.remove();
  }, [player, trim?.start, trim?.end, trim != null]);

  // play/pause control. A preloading (offscreen) item keeps playing muted —
  // only pause it when explicitly paused or when it's neither active nor the
  // preload target. When a muted preload becomes ACTIVE, restore the user's
  // mute preference before playing.
  useEffect(() => {
    if (isActive && !paused) {
      if (!forceMute && !userMutedRef.current && player.muted) {
        player.muted = false;
        setMuted(false);
      }
      player.play();
    } else if (paused || !preload) {
      player.pause();
    }
  }, [isActive, paused, preload, forceMute, player]);

  // Playback always restarts when this item becomes the active one.
  //
  // The source is deliberately replace()d only ONCE per url (see loadedUrlRef
  // above) so scrolling back doesn't trigger a fresh network load. The side
  // effect is that the native player keeps its position: scroll away mid-clip,
  // come back, and it resumes where it stopped. Reported as "it continues from
  // where it stops — I want any video played to always start again".
  //
  // Seeking back to the clip's own start (trim.start, not 0 — a trimmed drop
  // begins at its trim point) resets playback without re-fetching the source.
  // A ref, not state, tracks the transition: re-running on every render would
  // yank the video back to the start mid-play.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const justActivated = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!justActivated || paused) return;
    try {
      player.currentTime = trim ? trim.start : 0;
    } catch {
      // Source not loaded yet — the replace() effect above starts it at 0 anyway.
    }
  }, [isActive, paused, player, trim?.start, trim?.end, trim != null, url]);

  // speed changes after mount
  useEffect(() => {
    if (player && Math.abs(player.playbackRate - speed) > 0.001) {
      player.playbackRate = speed;
    }
  }, [player, speed]);

  // sync muted state when the player loads
  useEffect(() => {
    setMuted(player.muted);
  }, [player]);

  // force-mute when an added sound track is playing instead
  useEffect(() => {
    if (forceMute && !player.muted) {
      player.muted = true;
      setMuted(true);
    }
  }, [forceMute, player]);

  const toggleMute = () => {
    const next = !player.muted;
    player.muted = next;
    userMutedRef.current = next;
    setMuted(next);
  };

  return (
    <View style={[styles.fill, style]}>
      <View style={[styles.fill, rotation !== 0 ? { transform: [{ rotate: `${rotation}deg` }] } : null]}>
        {/*
          TextureView, NOT the default SurfaceView.

          A SurfaceView is composited by the window manager in a layer of its
          own: it is not clipped to its parent's bounds and it is NOT covered by
          an opaque React view drawn above it. That is precisely how a video in
          the home feed stayed painted across the middle of the camera screen —
          the camera could render, and the feed's surface still showed on top of
          it (and kept showing even when the video was paused, because a paused
          surface keeps its last frame).

          A TextureView is an ordinary view: it is clipped, it respects stacking
          order, and anything drawn after it covers it. expo-video documents
          exactly this case — "use textureView where the SurfaceView causes
          issues, for example overlapping video views".

          The price is a little more power per decoded frame. Correctness on
          every screen that can be overlapped is worth it.
        */}
        <VideoView
          player={player}
          style={styles.fill}
          contentFit={contentFit}
          nativeControls={false}
          surfaceType="textureView"
        />
        {effectTint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: effectTint }]} />}
        {filterTint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: filterTint }]} />}
        {filterGlow && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: filterGlow }]} />}

        {/* Loader sits ABOVE the video surface on purpose. On Android the
            surface is opaque, so a cover image behind it would be invisible
            the moment the surface exists — which is exactly when it is black.
            Above it, the cover is what you see until the first frame paints. */}
        {!hidden && (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: fade }]}>
            <VideoLoader progress={bufferP} poster={poster} />
          </Animated.View>
        )}

        {/* A spinner must never be the last word. If the source genuinely
            failed, say so and make the retry a tap. */}
        {status === 'error' && (
          <Pressable style={styles.errorWrap} onPress={retry} hitSlop={12}>
            <Icon name="refresh" size={22} color={colors.logoWhite} />
            <Text style={styles.errorText}>Tap to retry</Text>
          </Pressable>
        )}
      </View>

      {onTap && (
        <Pressable
          style={styles.tapCatcher}
          onPress={onTap}
          delayLongPress={350}
          onLongPress={onHoldStart}
          onPressOut={onHoldEnd}
        />
      )}

      {showProgress && <View style={[styles.progressBar, { width: `${progress * 100}%` }]} />}

      {showMute && (
        <Pressable style={styles.muteBtn} onPress={toggleMute} hitSlop={10}>
          <Icon name={muted ? 'volume-mute' : 'volume-high'} size={20} color={colors.logoWhite} />
        </Pressable>
      )}

      {(textLayers?.length ?? 0) > 0 &&
        textLayers!.map((l, i) => (
          <View key={`tl-${i}`} pointerEvents="none" style={[styles.overlayItem, { left: l.x ?? 20, top: l.y ?? 100 }]}>
            <Text
              style={{
                color: l.color ?? '#FFFFFF',
                fontSize: l.size ?? 26,
                fontWeight: l.bold ? '800' : '400',
                textShadowColor: 'rgba(0,0,0,0.55)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 4,
              }}
            >
              {l.text}
            </Text>
          </View>
        ))}

      {(stickers?.length ?? 0) > 0 &&
        stickers!.map((s, i) => (
          <View key={`st-${i}`} pointerEvents="none" style={[styles.overlayItem, { left: s.x ?? 40, top: s.y ?? 160 }]}>
            <Text style={{ fontSize: s.size ?? 52 }}>{s.emoji}</Text>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  overlayItem: {
    position: 'absolute',
    maxWidth: '80%',
  },
  tapCatcher: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    backgroundColor: 'transparent',
  },
  progressBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: colors.accent,
    zIndex: 5,
  },
  muteBtn: {
    position: 'absolute',
    top: 54,
    right: 14,
    zIndex: 6,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    padding: 8,
  },
  muteText: {
    fontSize: 16,
  },
  errorWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(6,7,15,0.55)',
  },
  errorText: {
    color: colors.logoWhite,
    fontSize: 13,
    fontWeight: '600',
  },
});
