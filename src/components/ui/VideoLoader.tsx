import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';
import { brand } from '../../theme';

// ============================================================
// VideoLoader — what you look at while a drop is fetching.
//
// Before this, a feed cell was a black rectangle until ExoPlayer had
// enough data to paint its first frame: no cover, no spinner, nothing to
// tell you the app was working. Two separate problems sat behind that —
// the feed never asked for `cover_url`, and nothing listened to the
// player's own load state.
//
// So this draws, in order:
//   1. the post's cover image, full bleed — a real frame, not black
//   2. a scrim, so the ring reads on a bright cover
//   3. a hairline ring that fills with the ACTUAL buffered fraction
//      (player.bufferedPosition / duration), not a fake spinner
//
// A determinate ring is a promise only a real number can keep; when the
// duration is not known yet the arc sweeps instead, and the sweep stops
// the instant a real fraction arrives.
//
// The word "Buffering" only appears after 900ms. A clip that loads in
// 300ms should never flash a label at you — that is what makes a load
// feel slow even when it is not.
// ============================================================

/** biggest the ring ever gets — a full-screen feed cell */
const MAX_SIZE = 66;
/** …and the smallest, for a grid tile in Discover or Search */
const MIN_SIZE = 26;
/** how much of the circle the indeterminate sweep occupies */
const SWEEP = 0.24;

type Props = {
  /** 0..1 buffered fraction. <= 0 or non-finite renders the indefinite sweep. */
  progress?: number;
  /** cover image to hold the frame while the video is fetching */
  poster?: string | null;
  /** fills the parent instead of drawing its own dark backdrop */
  transparent?: boolean;
  style?: any;
};

let gradientSeq = 0;

export default function VideoLoader({ progress, poster, transparent = false, style }: Props) {
  // unique gradient id per instance — react-native-svg resolves `url(#id)`
  // against a process-wide registry, so two loaders sharing an id would
  // both paint whichever gradient registered last.
  const gradientId = useRef(`vl-grad-${++gradientSeq}`).current;

  // The same component is a full-bleed feed cell AND a 96pt tile in the
  // Discover/Search grids. Rather than force every call site to know the
  // ring's diameter, it measures the box it was given: 34% of the short
  // side, clamped. A fixed 66px ring in a tile looked like a bug.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const short = box.w && box.h ? Math.min(box.w, box.h) : 0;
  const size = short ? Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(short * 0.34))) : MAX_SIZE;
  const stroke = Math.max(1.5, Math.round((size / 22) * 10) / 10);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  /** micro type only makes sense at feed size */
  const roomForType = size >= 52;

  const fraction =
    typeof progress === 'number' && Number.isFinite(progress) && progress > 0
      ? Math.max(0, Math.min(1, progress))
      : 0;
  const determinate = fraction > 0;

  const spin = useRef(new Animated.Value(0)).current;
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 900);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (determinate) {
      spin.stopAnimation(() => spin.setValue(0));
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1150,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [determinate, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View
      pointerEvents="none"
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={[styles.fill, transparent ? null : styles.backdrop, style]}
    >
      {!!poster && (
        <>
          <Image source={{ uri: poster }} style={styles.fill} resizeMode="cover" />
          <View style={[styles.fill, styles.dim]} />
        </>
      )}

      <View style={styles.center}>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Svg width={size} height={size}>
            <Defs>
              <SvgGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={brand.ringGradient[0]} />
                <Stop offset="0.5" stopColor={brand.ringGradient[1]} />
                <Stop offset="1" stopColor={brand.ringGradient[2]} />
              </SvgGradient>
            </Defs>
            {/* track */}
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth={stroke}
              fill="none"
            />
            {/* the part that is actually downloaded */}
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              stroke={`url(#${gradientId})`}
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={`${c} ${c}`}
              strokeDashoffset={determinate ? c * (1 - fraction) : c * (1 - SWEEP)}
              rotation={-90}
              originX={size / 2}
              originY={size / 2}
            />
          </Svg>
        </Animated.View>

        {/* the true fraction, only once there is one to state */}
        {determinate && slow && roomForType && (
          <Text style={styles.pct}>{Math.round(fraction * 100)}%</Text>
        )}
      </View>

      {slow && !determinate && roomForType && <Text style={styles.label}>LOADING</Text>}
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
  backdrop: {
    backgroundColor: brand.navy,
  },
  dim: {
    backgroundColor: 'rgba(6,7,15,0.42)',
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: {
    position: 'absolute',
    color: 'rgba(250,251,255,0.92)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    includeFontPadding: false,
  },
  label: {
    position: 'absolute',
    bottom: '38%',
    alignSelf: 'center',
    color: 'rgba(250,251,255,0.72)',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 2.2,
  },
});
