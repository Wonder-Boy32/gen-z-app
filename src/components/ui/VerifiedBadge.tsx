import React from 'react';
import { StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { colors } from '../../theme';

type Props = {
  size?: number;
  /** vivid orange halo — on-video feeds look better with it */
  glow?: boolean;
  style?: ViewStyle;
};

/**
 * Verified badge — a five-point star in the Gen Z electric orange, wrapped in
 * a soft orange glow. Reads clearly on both dark video and light surfaces.
 */
export default function VerifiedBadge({ size = 14, glow = true, style }: Props) {
  const textStyle: TextStyle = {
    fontSize: size,
    lineHeight: size + 1,
    color: '#22D3EE',
    textAlign: 'center',
    ...(glow
      ? {
          textShadowColor: 'rgba(193,59,255,0.85)',
          textShadowRadius: Math.max(2.5, size * 0.5),
        }
      : null),
  };
  return (
    <View
      style={[
        styles.wrap,
        {
          width: Math.ceil(size * 1.1),
          height: Math.ceil(size * 1.1),
        },
        style,
      ]}
    >
      <Text style={textStyle}>★</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
