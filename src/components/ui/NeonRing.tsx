// ============================================================
// NeonRing — the gradient story ring
// ============================================================
//
// A borderView can only be one colour, so the reference's cyan→magenta ring
// cannot be done with `borderColor`. One SVG circle with a gradient stroke does
// it exactly, and react-native-svg is already compiled into the dev client (the
// QR codes use it), so this adds no native module.
//
// `active` is used for the people you already follow: same ring, brand ramp,
// plus a glow. Unfollowed people get a quiet neutral ring so the rail still
// reads at a glance.

import React, { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { NEON_RAMP } from './NeonButton';

export default function NeonRing({
  size,
  stroke = 2.4,
  active,
  children,
}: {
  size: number;
  stroke?: number;
  active?: boolean;
  children?: ReactNode;
}) {
  const r = size / 2 - stroke / 2;
  return (
    <View
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        active && styles.glow,
      ]}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="ringRamp" x1="0" y1="0" x2="1" y2="1">
            {NEON_RAMP.map((c, i) => (
              <Stop key={c} offset={i / (NEON_RAMP.length - 1)} stopColor={c} />
            ))}
          </LinearGradient>
        </Defs>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={active ? 'url(#ringRamp)' : 'rgba(255,255,255,0.22)'}
          strokeWidth={stroke}
        />
      </Svg>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  glow: {
    shadowColor: '#8B5CF6',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
});
