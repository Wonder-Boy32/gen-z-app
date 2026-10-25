// ============================================================
// NeonButton — the wide cyan→magenta action button
// ============================================================
//
// The same four-stop ramp as NeonDock, drawn with react-native-svg so the fill
// is one true gradient rather than a stack of banded views. Text sits in its own
// layer above the SVG, so the label is never tinted by the fill.
//
// Kept as a component rather than inlined in ProfileScreen because the profile's
// "Edit profile" and the reference's other primary actions are the same object;
// two hand-built copies would drift.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Icon, { IconName } from './Icon';

export const NEON_RAMP = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899'];

export default function NeonButton({
  title,
  onPress,
  icon,
  height = 48,
  radius = 999,
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: IconName;
  height?: number;
  radius?: number;
  style?: any;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        styles.wrap,
        { height, borderRadius: radius },
        pressed && styles.pressed,
        style,
      ]}
    >
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="neonBtn" x1="0" y1="0" x2="1" y2="0">
            {NEON_RAMP.map((c, i) => (
              <Stop key={c} offset={i / (NEON_RAMP.length - 1)} stopColor={c} />
            ))}
          </LinearGradient>
          {/* a second, vertical pass at low opacity lifts the top edge so the
              button reads as lit from above instead of flatly filled */}
          <LinearGradient id="neonBtnSheen" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.22} />
            <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" rx={radius} fill="url(#neonBtn)" />
        <Rect x="0" y="0" width="100%" height="100%" rx={radius} fill="url(#neonBtnSheen)" />
      </Svg>

      <View style={styles.inner} pointerEvents="none">
        {icon && <Icon name={icon} size={17} color="#FFFFFF" />}
        <Text style={styles.label} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    justifyContent: 'center',
    // the glow is what separates this from a flat accent pill
    shadowColor: '#8B5CF6',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pressed: { opacity: 0.88 },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
  },
  label: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
});
