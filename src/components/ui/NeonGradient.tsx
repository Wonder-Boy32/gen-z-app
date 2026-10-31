// ============================================================
// NeonGradient — the brand ramp, as one reusable fill
// ============================================================
//
// The dock outline, the story ring, the primary button and the profile CTA all
// use the same four stops. Keeping the ramp in one module is what stops those
// four surfaces from drifting apart as the palette is tuned.
//
// expo-linear-gradient is not a dependency of this app and adding a native
// module would force another native rebuild, so the fill is an SVG rect with a
// gradient — react-native-svg is already in the dev client because the QR codes
// use it.

import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

export const NEON_RAMP = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899'];

export default function NeonGradientFill({
  radius = 999,
  sheen = true,
}: {
  radius?: number;
  sheen?: boolean;
}) {
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="ngRamp" x1="0" y1="0" x2="1" y2="0">
          {NEON_RAMP.map((c, i) => (
            <Stop key={c} offset={i / (NEON_RAMP.length - 1)} stopColor={c} />
          ))}
        </LinearGradient>
        {/* a vertical pass at low opacity lifts the top edge, so the fill reads
            as lit from above rather than as a flat block of colour */}
        <LinearGradient id="ngSheen" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.22} />
          <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={radius} fill="url(#ngRamp)" />
      {sheen && <Rect x="0" y="0" width="100%" height="100%" rx={radius} fill="url(#ngSheen)" />}
    </Svg>
  );
}
