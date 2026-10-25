// ============================================================
// NeonDock — the floating wave dock
// ============================================================
//
// THE SHAPE, DESCRIBED IN WORDS
//
// Look at the reference dock and it is not a bar with a bump on top. The top
// edge is one continuous wave: a crest, a dip around Home, a thin crest, a dip
// around Search, then it swells into a wide dome that the centre button sits on,
// dips again around Alerts, crests, dips around Profile, and closes.
//
// The two inner dips are not separate from the dome — they carve into its
// shoulders. That is what makes the silhouette look like a single organic
// object. So the top edge is defined as a SUM of windowed bumps:
//
//     y(x) = CREST - DOME_RISE·dome(x) + DEPTH·Σ pocket_i(x)
//
// with each bump being cos²(π u / 2) over |u| < 1, a window that reaches 1 at
// its centre and 0 with ZERO SLOPE at both edges. Zero slope is the reason the
// joins have no visible corners no matter where the bumps are placed, and the
// reason overlapping a pocket on the dome shoulder just carves a notch instead
// of producing a kink.
//
// The edge is then sampled every 1.5pt and emitted as a real path, so the
// silhouette scales with the measured width instead of being a fixed drawing.
// The ends are true semicircles: the first pocket's window starts just inside
// the left cap, where its contribution is zero, so the cap joins at crest height
// with a horizontal tangent.
//
// react-native-svg is already compiled into the dev client (react-native-qrcode-svg
// depends on it), so none of this adds a native module.

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { colors, getThemeMode } from '../../theme';
import { useInsets } from '../../utils/useInsets';
import Icon, { IconName } from './Icon';
import type { Tab } from '../TabBar';

// The reference ramp, left to right. Fixed rather than themed: this is a brand
// surface, and the point of it is that it is unmistakably the same object in
// every screen. Light mode only changes the interior, never the ramp.
const NEON = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899'];

const CREST = 54; // the high points of the top edge, between pockets
const BOTTOM = 108; // the flat bottom edge
const DOME_RISE = 46; // how far the centre rises above the crest
const DOME_HALF = 0.15; // dome half-width, as a fraction of the dock width
const POCKET_DEPTH = 15; // how far each icon's pocket dips below the crest
const POCKET_HALF = 0.066; // pocket half-width, as a fraction of the dock width
// Icon centres. The outer pair sits at 0.16 rather than hugging the ends: its
// pocket window has to finish BEFORE the end cap starts, otherwise the cap joins
// the top edge part-way down a dip and shows a step. At 0.16 the window ends at
// 0.094 of the width, which clears the cap even on a 320pt phone.
const ICONS = [0.16, 0.325, 0.675, 0.84];
const CENTER_R = 31;
const CENTER_CY = 34; // ring top sits just above the dome
const HEIGHT = BOTTOM + 4;
const PAD = 9; // room inside the canvas for the bloom, so it is not clipped
const ICON_Y = (CREST + BOTTOM) / 2;

const ITEMS: { key: Tab; label: string; icon: IconName; iconActive: IconName }[] = [
  { key: 'feed', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'discover', label: 'Search', icon: 'search-outline', iconActive: 'search' },
  { key: 'post', label: 'Create', icon: 'add', iconActive: 'add' },
  { key: 'chat', label: 'Alerts', icon: 'notifications-outline', iconActive: 'notifications' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

/** cos² window: 1 at the centre, exactly 0 with zero slope at |u| = 1. */
function window(u: number): number {
  if (u <= -1 || u >= 1) return 0;
  const c = Math.cos((u * Math.PI) / 2);
  return c * c;
}

/** Height of the top edge at x, in the dock's own coordinate space. */
function topY(x: number, w: number): number {
  const cx = w / 2;
  let y = CREST - DOME_RISE * window((x - cx) / (DOME_HALF * w));
  for (const f of ICONS) {
    y += POCKET_DEPTH * window((x - f * w) / (POCKET_HALF * w));
  }
  return y;
}

/**
 * The dock outline as a function of width.
 *
 * Everything is computed in a space `PAD` inside the canvas on each side, so the
 * outer bloom has somewhere to land. The path is one closed contour.
 */
function dockPath(w: number): string {
  const inner = w - PAD * 2;
  const cap = (BOTTOM - CREST) / 2; // fully rounded ends
  const x0 = cap;
  const x1 = inner - cap;

  // sample the wave; 1.5pt is well below what the eye can resolve on a phone
  const step = 1.5;
  const pts: string[] = [];
  for (let x = x0; x <= x1 + 0.001; x += step) {
    pts.push(`L ${x.toFixed(2)} ${topY(x, inner).toFixed(2)}`);
  }
  // make sure the edge lands exactly on the right cap
  pts.push(`L ${x1.toFixed(2)} ${topY(x1, inner).toFixed(2)}`);

  return [
    `M ${x0} ${CREST}`,
    ...pts.slice(1), // the first sample is the start point already emitted
    `A ${cap} ${cap} 0 0 1 ${inner} ${CREST + cap}`,
    `A ${cap} ${cap} 0 0 1 ${x1} ${BOTTOM}`,
    `H ${cap}`,
    `A ${cap} ${cap} 0 0 1 0 ${CREST + cap}`,
    `A ${cap} ${cap} 0 0 1 ${cap} ${CREST}`,
    'Z',
  ].join(' ');
}

/** An infinity mark, drawn about the origin so it can be translated freely. */
const INFINITY = 'M -13 0 C -13 -8 -4 -8 0 0 C 4 8 13 8 13 0 C 13 -8 4 -8 0 0 C -4 8 -13 8 -13 0 Z';

export default function NeonDock({
  tab,
  onChange,
  badges,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  badges?: Partial<Record<Tab, number>>;
}) {
  const insets = useInsets();
  const [w, setW] = useState(0);
  const light = getThemeMode() === 'light';
  const path = useMemo(() => (w > PAD * 2 + 120 ? dockPath(w) : ''), [w]);
  const inner = w - PAD * 2;
  const cx = PAD + inner / 2;

  const sideItems = ITEMS.filter((i) => i.key !== 'post');
  const centerItem = ITEMS.find((i) => i.key === 'post')!;

  return (
    <View
      style={[styles.wrap, { paddingBottom: insets.bottom > 0 ? insets.bottom + 4 : 14 }]}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
    >
      {!!path && (
        <>
          <Svg width={w} height={HEIGHT} style={StyleSheet.absoluteFill} pointerEvents="none">
            <Defs>
              <LinearGradient id="neonStroke" x1="0" y1="0" x2="1" y2="0">
                {NEON.map((c, i) => (
                  <Stop key={c} offset={i / (NEON.length - 1)} stopColor={c} />
                ))}
              </LinearGradient>
              <LinearGradient id="neonFill" x1="0" y1="0" x2="1" y2="0">
                {NEON.map((c, i) => (
                  <Stop key={c} offset={i / (NEON.length - 1)} stopColor={c} stopOpacity={0.18} />
                ))}
              </LinearGradient>
              <RadialGradient id="pocketCyan" cx="0.5" cy="0.5" r="0.5">
                <Stop offset="0" stopColor={NEON[0]} stopOpacity={0.55} />
                <Stop offset="0.65" stopColor={NEON[1]} stopOpacity={0.18} />
                <Stop offset="1" stopColor={NEON[1]} stopOpacity={0} />
              </RadialGradient>
              <RadialGradient id="pocketMagenta" cx="0.5" cy="0.5" r="0.5">
                <Stop offset="0" stopColor={NEON[3]} stopOpacity={0.55} />
                <Stop offset="0.65" stopColor={NEON[2]} stopOpacity={0.18} />
                <Stop offset="1" stopColor={NEON[2]} stopOpacity={0} />
              </RadialGradient>
              <ClipPath id="dockClip">
                <Path d={path} />
              </ClipPath>
            </Defs>

            <G transform={`translate(${PAD} 0)`}>
              {/* bloom: two wide, faint strokes of the same outline, painted
                  first so the interior covers their inner half and only an
                  outer halo survives */}
              <Path d={path} fill="none" stroke="url(#neonStroke)" strokeWidth={20} strokeOpacity={0.1} />
              <Path d={path} fill="none" stroke="url(#neonStroke)" strokeWidth={9} strokeOpacity={0.16} />

              <Path d={path} fill={light ? 'rgba(255,255,255,0.95)' : 'rgba(7,6,22,0.92)'} />

              {/* the lit pocket behind the active icon */}
              <G clipPath="url(#dockClip)">
                {sideItems.map((item, i) => {
                  const active = item.key === tab;
                  return (
                    <Circle
                      key={item.key}
                      cx={ICONS[i] * inner}
                      cy={ICON_Y}
                      r={30}
                      fill={`url(#${i < 2 ? 'pocketCyan' : 'pocketMagenta'})`}
                      opacity={active ? 1 : 0.22}
                    />
                  );
                })}
                <Path d={path} fill="url(#neonFill)" />
              </G>

              <Path d={path} fill="none" stroke="url(#neonStroke)" strokeWidth={2} strokeLinejoin="round" />

              {/* the raised button: dark core, gradient ring, glowing mark */}
              <Circle cx={inner / 2} cy={CENTER_CY} r={CENTER_R + 7} fill="url(#neonFill)" />
              <Circle cx={inner / 2} cy={CENTER_CY} r={CENTER_R} fill={light ? '#FFFFFF' : '#080718'} />
              <Circle cx={inner / 2} cy={CENTER_CY} r={CENTER_R - 8} fill="url(#neonFill)" />
              <Circle
                cx={inner / 2}
                cy={CENTER_CY}
                r={CENTER_R}
                fill="none"
                stroke="url(#neonStroke)"
                strokeWidth={2.6}
              />
              <Path
                d={INFINITY}
                transform={`translate(${inner / 2} ${CENTER_CY})`}
                fill="none"
                stroke="url(#neonStroke)"
                strokeWidth={2.8}
                strokeLinecap="round"
              />
            </G>
          </Svg>

          {sideItems.map((item, i) => {
            const active = item.key === tab;
            const x = PAD + ICONS[i] * inner;
            const badge = badges?.[item.key] ?? 0;
            const showBadge = badge > 0 && item.key !== tab;
            return (
              <Pressable
                key={item.key}
                onPress={() => onChange(item.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={item.label}
                hitSlop={8}
                style={[styles.hit, { left: x - 30, top: ICON_Y - 30 }]}
              >
                <Icon
                  name={active ? item.iconActive : item.icon}
                  size={23}
                  color={active ? '#FFFFFF' : light ? '#5C6484' : 'rgba(226,240,255,0.72)'}
                />
                {showBadge && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}

          <Pressable
            onPress={() => onChange(centerItem.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === centerItem.key }}
            accessibilityLabel={centerItem.label}
            hitSlop={10}
            style={[styles.hit, { left: cx - CENTER_R, top: CENTER_CY - CENTER_R }]}
          />
        </>
      )}

      {/* nothing renders until the width is known — the silhouette depends on it */}
      {!path && <RectPlaceholder />}
    </View>
  );
}

/** A quiet placeholder for the single frame between mount and measurement. */
function RectPlaceholder() {
  return <View style={styles.placeholder} />;
}

const styles = StyleSheet.create({
  wrap: {
    height: HEIGHT + 4,
    marginHorizontal: 12,
    marginTop: -16, // let the centre button sit closer to the content above it
  },
  hit: {
    position: 'absolute',
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 4,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: NEON[3],
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  placeholder: { flex: 1 },
});
