import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { colors } from '../theme';
import Icon from './ui/Icon';
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
  });

  // load the source when this item is active OR is the next (preload)
  // target. If it's only being preloaded, play it MUTED so the data
  // actually downloads and buffers — when it becomes active the video
  // starts instantly instead of waiting on a cold network load.
  // Never re-replace() a source we already loaded (that would restart it).
  useEffect(() => {
    if (!url) return;
    if (loadedUrlRef.current !== url && (isActive || preload)) {
      loadedUrlRef.current = url;
      player.replace({ uri: url });
    }
    if (!isActive && !preload) {
      player.pause();
    } else if (!isActive && preload) {
      // buffer offscreen: muted play; real mute state restored on activation
      player.muted = true;
      player.play();
    }
  }, [isActive, preload, url, player]);

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
        <VideoView player={player} style={styles.fill} contentFit={contentFit} nativeControls={false} />
        {effectTint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: effectTint }]} />}
        {filterTint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: filterTint }]} />}
        {filterGlow && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: filterGlow }]} />}
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
});
