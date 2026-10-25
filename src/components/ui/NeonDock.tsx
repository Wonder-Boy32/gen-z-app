// ============================================================
// NeonDock — the floating, wave-shaped navigation dock
// ============================================================
//
// WHY SVG AND NOT VIEWS
//
// A conventional tab bar is a row of equal boxes with a background. What makes
// this dock distinctive is the *silhouette*: one continuous outline whose top
// edge rises into a plateau in the middle and whose ends are fully rounded.
// Rounded Views can approximate that with a pill plus an overlapping circle, but
// the two shapes never share a single outline, so the stroke double-draws where
// they meet and the join is visible against a translucent fill.
//
// react-native-svg is already a dependency of react-native-qrcode-svg, so it is
// present in node_modules and — because the QR codes render on a real device —
// already compiled into the installed dev client. Using it here therefore adds
// no native module and needs no rebuild. A single <Path> gives one outline,
// one gradient stroke, and a genuinely smooth join.
//
// PROPORTIONS
//
// The first version of this dock was too heavy: a 54pt tall band with a 156pt
// wide plateau read as a blocky tray rather than a floating dock. The numbers
// below are tuned against the reference — a slimmer band, a narrower plateau,
// and shoulders that spread over 30pt so the rise reads as a curve instead of a
// trapezoid. They are expressed in terms of the measured width where it matters,
// so the silhouette scales with the screen instead of being a fixed drawing.

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors, getThemeMode } from '../../theme';
import { useInsets } from '../../utils/useInsets';
import Icon, { IconName } from './Icon';
import type { Tab } from '../TabBar';

// The reference ramp, left to right. Fixed rather than themed: this is a brand
// surface, and the point of it is that it is unmistakably the same object in
// every screen. Light mode only changes the interior, never the ramp.
const NEON = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899'];

const BAR_TOP = 42; // y of the flat top edge
const BAR_BOTTOM = 96; // y of the bottom edge
const PLATEAU_TOP = 20; // y of the raised middle section
const BUMP_HALF = 58; // half-width of the plateau's flat section
const SHOULDER = 30; // how far each shoulder spreads beyond the plateau
const CENTER_R = 28; // radius of the raised centre button
const CENTER_CY = 30; // sits high enough that the ring is never clipped
const HEIGHT = BAR_BOTTOM + 4;

const ITEMS: { key: Tab; label: string; icon: IconName; iconActive: IconName }[] = [
  { key: 'feed', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'discover', label: 'Search', icon: 'search-outline', iconActive: 'search' },
  { key: 'post', label: 'Create', icon: 'add', iconActive: 'add' },
  { key: 'chat', label: 'Alerts', icon: 'notifications-outline', iconActive: 'notifications' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

/**
 * The dock outline as a function of width.
 *
 * Read it as one continuous stroke: flat top edge from the left cap, a cubic
 * rise into the plateau, across the plateau, a cubic fall back to the top edge,
 * then down the right cap, along the bottom, and up the left cap.
 *
 * The shoulders use a smoothstep — both control points sit at the horizontal
 * midpoint of the rise, one at each end's height. That is what turns the join
 * into a wave: the tangent is vertical in the middle of the rise, so there is no
 * corner where the slope changes abruptly, which is exactly what the two-segment
 * approximation used to show.
 */
function dockPath(w: number): string {
  const cx = w / 2;
  const cap = (BAR_BOTTOM - BAR_TOP) / 2; // fully rounded ends
  const l = cx - BUMP_HALF;
  const r = cx + BUMP_HALF;
  const s = SHOULDER;
  const midL = (l - s + (l + 10)) / 2; // horizontal midpoint of the left rise
  const midR = (r - 10 + (r + s)) / 2; // and of the right rise
  return [
    `M ${cap} ${BAR_TOP}`,
    `H ${l - s}`,
    `C ${midL} ${BAR_TOP} ${midL} ${PLATEAU_TOP} ${l + 10} ${PLATEAU_TOP}`,
    `H ${r - 10}`,
    `C ${midR} ${PLATEAU_TOP} ${midR} ${BAR_TOP} ${r + s} ${BAR_TOP}`,
    `H ${w - cap}`,
    `A ${cap} ${cap} 0 0 1 ${w} ${BAR_TOP + cap}`,
    `A ${cap} ${cap} 0 0 1 ${w - cap} ${BAR_BOTTOM}`,
    `H ${cap}`,
    `A ${cap} ${cap} 0 0 1 0 ${BAR_TOP + cap}`,
    `A ${cap} ${cap} 0 0 1 ${cap} ${BAR_TOP}`,
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
  const path = useMemo(() => (w > 0 ? dockPath(w) : ''), [w]);

  // Two on each side of the raised button, at fixed fractions of the width so
  // the spacing stays even on a tablet as well as a phone.
  const slots = [0.115, 0.285, 0.715, 0.885];
  const sideItems = ITEMS.filter((i) => i.key !== 'post');
  const centerItem = ITEMS.find((i) => i.key === 'post')!;
  const iconCenterY = (BAR_TOP + BAR_BOTTOM) / 2;

  return (
    <View
      style={[styles.wrap, { paddingBottom: insets.bottom > 0 ? insets.bottom + 4 : 14 }]}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
    >
      {w > 0 && (
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
                  <Stop key={c} offset={i / (NEON.length - 1)} stopColor={c} stopOpacity={0.16} />
                ))}
              </LinearGradient>
              <LinearGradient id="neonGlow" x1="0" y1="0" x2="0" y2="1">
                {NEON.map((c, i) => (
                  <Stop key={c} offset={i / (NEON.length - 1)} stopColor={c} stopOpacity={0.9} />
                ))}
              </LinearGradient>
            </Defs>

            {/* Bloom first: two wide, faint strokes of the same outline. The
                interior is painted over them next, so only the outer half of
                each stroke survives and the dock appears to cast its own light
                instead of carrying a border. */}
            <Path d={path} fill="none" stroke="url(#neonGlow)" strokeWidth={18} strokeOpacity={0.1} />
            <Path d={path} fill="none" stroke="url(#neonGlow)" strokeWidth={9} strokeOpacity={0.16} />

            {/* interior, then the crisp outline on top so it is never clipped */}
            <Path d={path} fill={light ? 'rgba(255,255,255,0.94)' : 'rgba(8,13,28,0.90)'} />
            <Path d={path} fill="url(#neonFill)" />
            <Path
              d={path}
              fill="none"
              stroke="url(#neonStroke)"
              strokeWidth={2}
              strokeLinejoin="round"
            />

            {/* the raised button: dark core, gradient ring, glowing mark */}
            <Circle cx={w / 2} cy={CENTER_CY} r={CENTER_R + 6} fill="url(#neonGlow)" fillOpacity={0.14} />
            <Circle
              cx={w / 2}
              cy={CENTER_CY}
              r={CENTER_R}
              fill={light ? '#FFFFFF' : '#0A1024'}
            />
            <Circle cx={w / 2} cy={CENTER_CY} r={CENTER_R - 7} fill="url(#neonFill)" />
            <Circle
              cx={w / 2}
              cy={CENTER_CY}
              r={CENTER_R}
              fill="none"
              stroke="url(#neonStroke)"
              strokeWidth={2.4}
            />
            <Path
              d={INFINITY}
              transform={`translate(${w / 2} ${CENTER_CY})`}
              fill="none"
              stroke="url(#neonStroke)"
              strokeWidth={2.6}
              strokeLinecap="round"
            />
          </Svg>

          {sideItems.map((item, i) => {
            const active = item.key === tab;
            const x = slots[i] * w;
            const badge = badges?.[item.key] ?? 0;
            const showBadge = badge > 0 && item.key !== tab;
            return (
              <Pressable
                key={item.key}
                onPress={() => onChange(item.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={item.label}
                hitSlop={10}
                style={[styles.hit, { left: x - 28, top: iconCenterY - 28 }]}
              >
                <Icon
                  name={active ? item.iconActive : item.icon}
                  size={22}
                  color={active ? (light ? '#0B1220' : '#FFFFFF') : light ? '#64708C' : 'rgba(226,240,255,0.55)'}
                />
                {active && (
                  <View
                    style={[
                      styles.activeDot,
                      { backgroundColor: NEON[i === 0 || i === 1 ? 0 : 3] },
                    ]}
                  />
                )}
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
            hitSlop={12}
            style={[styles.hit, { left: w / 2 - 28, top: CENTER_CY - 28 }]}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: HEIGHT + 4,
    marginHorizontal: 12,
    marginTop: -18, // let the raised button sit closer to the content above it
  },
  hit: {
    position: 'absolute',
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    bottom: 5,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
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
});
