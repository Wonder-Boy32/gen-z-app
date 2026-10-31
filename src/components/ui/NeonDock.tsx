// ============================================================
// NeonDock — capsule with a raised centre disc
// ============================================================
//
// The silhouette is the union of two shapes: a 56pt capsule spanning the full
// width, and a 40pt disc sitting on the centre. The disc's bottom is TANGENT to
// the capsule's bottom edge, so it only ever breaks the TOP edge — which is why
// this can be written as one closed path with a single arc over the middle,
// instead of a boolean union of two paths that would leave a seam in the glow.
//
// Icons sit in faint circular wells, the active one filled — that ring is the
// shape's rhythm in the reference, not an afterthought.
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';
import Icon, { IconName } from './Icon';

export type DockTab = 'feed' | 'discover' | 'post' | 'chat' | 'profile';

type Item = { key: DockTab; label: string; icon: IconName; iconActive: IconName };

const ITEMS: Item[] = [
  { key: 'feed', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'discover', label: 'Search', icon: 'search-outline', iconActive: 'search' },
  { key: 'post', label: 'Create', icon: 'add', iconActive: 'add' },
  { key: 'chat', label: 'Chat', icon: 'chatbubble-outline', iconActive: 'chatbubbles' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

const PAD_X = 8;
const CANVAS_TOP = 26; // headroom for the disc above the capsule
const BAR_H = 56;
const DOME_R = 40;
const CAP = BAR_H / 2;
const WELL_R = 21;
const CENTER_R = 33;
const HEIGHT = CANVAS_TOP + BAR_H + 6;

// Where the disc crosses the capsule's top edge. The disc's centre sits
// BAR_H - DOME_R below that edge, so the chord is that distance, not the cap
// radius — using the cap radius put the arc endpoints off the edge and bowed the
// top line.
const GAP = BAR_H - DOME_R;
const CHORD = Math.sqrt(DOME_R * DOME_R - GAP * GAP);

const SLOTS = [0.13, 0.31, 0.69, 0.87];

function dockPath(inner: number) {
  const top = CANVAS_TOP;
  const bottom = top + BAR_H;
  const cx = inner / 2;
  const cap = CAP;
  const rightEnd = inner - cap;
  return [
    `M ${cap} ${top}`,
    `H ${(cx - CHORD).toFixed(2)}`,
    `A ${DOME_R} ${DOME_R} 0 0 1 ${(cx + CHORD).toFixed(2)} ${top}`,
    `H ${rightEnd}`,
    `A ${cap} ${cap} 0 0 1 ${inner} ${top + cap}`,
    `A ${cap} ${cap} 0 0 1 ${rightEnd} ${bottom}`,
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
};

export default function NeonDock({ tab, onChange, badges }: Props) {
  const [w, setW] = useState(0);
  const inner = Math.max(0, w - PAD_X * 2);
  const path = useMemo(() => (inner > 200 ? dockPath(inner) : ''), [inner]);
  const cy = CANVAS_TOP + BAR_H - DOME_R;
  const midY = CANVAS_TOP + BAR_H / 2;

  return (
    <View style={styles.wrap} onLayout={(e) => setW(e.nativeEvent.layout.width)} pointerEvents="box-none">
      {inner > 200 && (
        <Svg width={w} height={HEIGHT}>
          <Defs>
            <LinearGradient id="rail" x1="0" y1="0" x2="1" y2="0.35">
              <Stop offset="0" stopColor="#FFB24B" />
              <Stop offset="0.35" stopColor="#FF8A2E" />
              <Stop offset="0.7" stopColor="#B15CFF" />
              <Stop offset="1" stopColor="#7C3AED" />
            </LinearGradient>
            <LinearGradient id="core" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#12102E" />
              <Stop offset="1" stopColor="#07051A" />
            </LinearGradient>
          </Defs>
          <G transform={`translate(${PAD_X} 0)`}>
            <Path d={path} stroke="url(#rail)" strokeWidth={16} strokeOpacity={0.14} fill="none" />
            <Path d={path} stroke="url(#rail)" strokeWidth={7} strokeOpacity={0.3} fill="none" />
            <Path d={path} fill="rgba(7,6,20,0.92)" />
            <Path d={path} stroke="url(#rail)" strokeWidth={1.8} fill="none" />
            {SLOTS.map((f, i) => (
              <Circle
                key={i}
                cx={f * inner}
                cy={midY}
                r={WELL_R}
                fill={tab === ITEMS[i].key ? 'rgba(255,178,75,0.16)' : 'transparent'}
                stroke={tab === ITEMS[i].key ? 'url(#rail)' : 'rgba(255,255,255,0.16)'}
                strokeWidth={tab === ITEMS[i].key ? 1.6 : 1.2}
              />
            ))}
            <Circle cx={inner / 2} cy={cy} r={CENTER_R} fill="url(#core)" />
            <Circle cx={inner / 2} cy={cy} r={CENTER_R} stroke="url(#rail)" strokeWidth={4} fill="none" />
            <Circle cx={inner / 2} cy={cy} r={CENTER_R - 6} stroke="url(#rail)" strokeWidth={1} strokeOpacity={0.5} fill="none" />
          </G>
        </Svg>
      )}

      {ITEMS.filter((i) => i.key !== 'post').map((it) => {
        const i = ITEMS.indexOf(it);
        const left = PAD_X + SLOTS[i] * inner - WELL_R;
        const n = badges?.[it.key] ?? 0;
        return (
          <Pressable
            key={it.key}
            style={[styles.hit, { left, top: midY - WELL_R }]}
            onPress={() => onChange(it.key)}
            hitSlop={6}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === it.key }}
            accessibilityLabel={it.label}
          >
            <Icon
              name={tab === it.key ? it.iconActive : it.icon}
              size={22}
              color={tab === it.key ? '#FFFFFF' : 'rgba(226,232,255,0.72)'}
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
        style={[styles.center, { left: PAD_X + inner / 2 - CENTER_R, top: cy - CENTER_R }]}
        onPress={() => onChange('post')}
        accessibilityRole="tab"
        accessibilityState={{ selected: tab === 'post' }}
        accessibilityLabel="Create a Drop"
      >
        <Svg width={44} height={26} viewBox="0 0 44 26">
          <Defs>
            <LinearGradient id="inf" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FFE9A8" />
              <Stop offset="0.45" stopColor="#FFB24B" />
              <Stop offset="1" stopColor="#B15CFF" />
            </LinearGradient>
          </Defs>
          <Path
            d="M 15 4 C 8 4 8 22 15 22 C 21 22 23 4 29 4 C 36 4 36 22 29 22 C 23 22 21 4 15 4 Z"
            fill="none"
            stroke="url(#inf)"
            strokeWidth={3.4}
            strokeLinecap="round"
          />
        </Svg>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: HEIGHT, marginTop: -18, marginHorizontal: 6, justifyContent: 'flex-end' },
  hit: { position: 'absolute', width: WELL_R * 2, height: WELL_R * 2, alignItems: 'center', justifyContent: 'center' },
  center: { position: 'absolute', width: CENTER_R * 2, height: CENTER_R * 2, alignItems: 'center', justifyContent: 'center' },
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
