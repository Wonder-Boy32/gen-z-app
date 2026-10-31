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
import Icon, { IconName } from './Icon';
import NeonGradientFill, { NEON_RAMP } from './NeonGradient';

export { NEON_RAMP };

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
      <NeonGradientFill radius={radius} />
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
    shadowColor: '#B15CFF',
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
