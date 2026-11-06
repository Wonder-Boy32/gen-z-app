// ============================================================
// NeonDock — capsule with a raised centre disc
// ============================================================
//
// THE SHAPE, AND WHY IT IS TWO PIECES
//
// My first attempt tried to make the disc part of the capsule's outline by
// replacing a slice of the top edge with an arc. On device that rendered as a
// plateau with two vertical steps, because the arc and the straight edge meet at
// a near-vertical tangent — it read as a notch, not a bump.
//
// In the reference the disc is NOT fused to the capsule: the capsule's top edge
// runs behind it and is simply interrupted. So this draws what the reference
// actually shows — one capsule path, with the disc stacked on top of it. No
// boolean union, no tangency to get wrong, and the ring stays crisp at any width.
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import Icon, { IconName } from './Icon';

export type DockTab = 'feed' | 'discover' | 'post' | 'chat' | 'profile';

type Side = { key: Exclude<DockTab, 'post'>; label: string; icon: IconName; iconActive: IconName; at: number };

// Explicit positions for the four side controls. The previous version looked
// these up by ITEMS.indexOf(), which is wrong the moment the centre item sits in
// the middle of the array: `profile` resolved to slot 4 of a 4-slot list and
// landed at NaN, so it drew at the left edge and one well went empty.
const LEFT: Side[] = [
  { key: 'feed', label: 'Home', icon: 'home-outline', iconActive: 'home', at: 0.13 },
  { key: 'discover', label: 'Search', icon: 'search-outline', iconActive: 'search', at: 0.31 },
];
const RIGHT: Side[] = [
  { key: 'chat', label: 'Chat', icon: 'chatbubble-outline', iconActive: 'chatbubbles', at: 0.69 },
  { key: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person', at: 0.87 },
];
const SIDES = [...LEFT, ...RIGHT];

const PAD_X = 8;
const CAP_TOP = 26; // headroom so the disc can rise above the capsule
const BAR_H = 56;
const WELL_R = 21;
const CENTER_R = 34;
const HEIGHT = CAP_TOP + BAR_H + 8;

function capsulePath(inner: number) {
  const cap = BAR_H / 2;
  const top = CAP_TOP;
  const bottom = top + BAR_H;
  return [
    `M ${cap} ${top}`,
    `H ${inner - cap}`,
    `A ${cap} ${cap} 0 0 1 ${inner} ${top + cap}`,
    `A ${cap} ${cap} 0 0 1 ${inner - cap} ${bottom}`,
    `H ${cap}`,
    `A ${cap} ${cap} 0 0 1 0 ${top + cap}`,
    `A ${cap} ${cap} 0 0 1 ${cap} ${top}`,
    'Z',
  ].join(' ');
}

type Props = {
  tab: DockTab;
  onChange: (t: DockTab) => void;
  badges?: Partial<Record<DockTab, number>>;
  /** there is saved work waiting on the create tab */
  hasDraft?: boolean;
};

export default function NeonDock({ tab, onChange, badges, hasDraft }: Props) {
  const [w, setW] = useState(0);
  const inner = Math.max(0, w - PAD_X * 2);
  const path = useMemo(() => (inner > 200 ? capsulePath(inner) : ''), [inner]);
  const midY = CAP_TOP + BAR_H / 2;

  return (
    <View style={styles.wrap} onLayout={(e) => setW(e.nativeEvent.layout.width)} pointerEvents="box-none">
      {inner > 200 && (
        <Svg width={w} height={HEIGHT}>
          <Defs>
            <LinearGradient id="rail" x1="0" y1="0" x2="1" y2="0.4">
              <Stop offset="0" stopColor="#FFB24B" />
              <Stop offset="0.38" stopColor="#FF8A2E" />
              <Stop offset="0.72" stopColor="#B15CFF" />
              <Stop offset="1" stopColor="#7C3AED" />
            </LinearGradient>
            <LinearGradient id="core" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#151233" />
              <Stop offset="1" stopColor="#07051A" />
            </LinearGradient>
          </Defs>
          <G transform={`translate(${PAD_X} 0)`}>
            {/* bloom first, interior second, so the halo reads as light escaping
                from behind the shell rather than a border drawn on top of it */}
            <Path d={path} stroke="url(#rail)" strokeWidth={14} strokeOpacity={0.16} fill="none" />
            <Path d={path} stroke="url(#rail)" strokeWidth={6} strokeOpacity={0.3} fill="none" />
            <Path d={path} fill="rgba(7,6,20,0.94)" />
            <Path d={path} stroke="url(#rail)" strokeWidth={1.6} fill="none" />

            {SIDES.map((s) => (
              <Circle
                key={s.key}
                cx={s.at * inner}
                cy={midY}
                r={WELL_R}
                fill={tab === s.key ? 'rgba(255,178,75,0.14)' : 'transparent'}
                stroke={tab === s.key ? 'url(#rail)' : 'rgba(255,255,255,0.18)'}
                strokeWidth={tab === s.key ? 1.6 : 1.2}
              />
            ))}

            {/* the disc, centred on the bar and overlapping it above and below */}
            <Circle cx={inner / 2} cy={midY} r={CENTER_R} fill="url(#core)" />
            <Circle cx={inner / 2} cy={midY} r={CENTER_R} stroke="url(#rail)" strokeWidth={4.5} fill="none" />
            <Circle cx={inner / 2} cy={midY} r={CENTER_R - 7} stroke="url(#rail)" strokeWidth={1} strokeOpacity={0.45} fill="none" />
          </G>
        </Svg>
      )}

      {SIDES.map((s) => {
        const n = badges?.[s.key] ?? 0;
        return (
          <Pressable
            key={s.key}
            style={[styles.hit, { left: PAD_X + s.at * inner - WELL_R, top: midY - WELL_R }]}
            onPress={() => onChange(s.key)}
            hitSlop={6}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === s.key }}
            accessibilityLabel={s.label}
          >
            <Icon
              name={tab === s.key ? s.iconActive : s.icon}
              size={22}
              color={tab === s.key ? '#FFFFFF' : 'rgba(226,232,255,0.7)'}
            />
            {n > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{n > 9 ? '9+' : n}</Text>
              </View>
            )}
          </Pressable>
        );
      })}

      <Pressable
        style={[styles.center, { left: PAD_X + inner / 2 - CENTER_R, top: midY - CENTER_R }]}
        onPress={() => onChange('post')}
        accessibilityRole="tab"
        accessibilityState={{ selected: tab === 'post' }}
        accessibilityLabel="Create a Drop"
      >
        {/* Saved work waiting behind this button. A dot rather than a count:
            there is one draft, and "2" would suggest a queue. Hidden while you
            are already on the create tab — you can see the draft itself there. */}
        {hasDraft && tab !== 'post' && <View style={styles.draftDot} />}
        <Svg width={40} height={24} viewBox="0 0 40 24">
          <Defs>
            <LinearGradient id="inf" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FFE0A3" />
              <Stop offset="0.5" stopColor="#FFB24B" />
              <Stop offset="1" stopColor="#B15CFF" />
            </LinearGradient>
          </Defs>
          <Path
            d="M 13 4 C 7 4 7 20 13 20 C 19 20 21 4 27 4 C 33 4 33 20 27 20 C 21 20 19 4 13 4 Z"
            fill="none"
            stroke="url(#inf)"
            strokeWidth={3.2}
            strokeLinecap="round"
          />
        </Svg>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: HEIGHT, marginTop: -14, marginHorizontal: 6, justifyContent: 'flex-end' },
  hit: { position: 'absolute', width: WELL_R * 2, height: WELL_R * 2, alignItems: 'center', justifyContent: 'center' },
  center: { position: 'absolute', width: CENTER_R * 2, height: CENTER_R * 2, alignItems: 'center', justifyContent: 'center' },
  draftDot: {
    position: 'absolute',
    top: 4,
    right: 8,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#FFB24B',
    borderWidth: 1.5,
    borderColor: '#07061A',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: '#FF4D6D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
});
