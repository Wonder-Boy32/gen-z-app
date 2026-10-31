import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from 'react-native';
import { colors, radius } from '../theme';
import NeonGradientFill from './ui/NeonGradient';

type Props = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: object;
};

// Full-width animated button with spring press feedback.
export default function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = () =>
    Animated.spring(scale, { toValue: 0.965, friction: 8, useNativeDriver: true }).start();
  const pressOut = () =>
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 220, useNativeDriver: true }).start();

  const blocked = disabled || loading;

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPressIn={pressIn}
        onPressOut={pressOut}
        onPress={onPress}
        disabled={blocked}
        style={({ pressed }) => [
          styles.base,
          styles[variant],
          blocked && styles.disabled,
          pressed && !blocked && styles.pressed,
        ]}
      >
        {/* The primary action is the brand ramp, not a solid accent: every
            primary button in the app now matches the dock and the Edit Profile
            CTA, which is what makes the identity read as one system. */}
        {variant === 'primary' && <NeonGradientFill radius={radius.pill} />}
        {loading ? (
          <ActivityIndicator color={variant === 'primary' ? '#FFFFFF' : colors.accent} />
        ) : (
          <Text
            style={[styles.text, styles[`text_${variant}`]]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
          >
            {title}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    width: '100%',
    borderRadius: radius.pill,
    paddingVertical: 15,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
    flexShrink: 1,
  },
  primary: {
    // the fill is the SVG gradient drawn inside the Pressable; a background
    // colour here would cap the corners of it
    backgroundColor: 'transparent',
    overflow: 'hidden',
    ...({
      shadowColor: '#8B5CF6',
      shadowOpacity: 0.45,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 3 },
      elevation: 8,
    } as object),
  },
  secondary: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  danger: {
    backgroundColor: colors.danger,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.85,
  },
  text_primary: {
    color: colors.onAccent,
  },
  text_secondary: {
    color: colors.text,
  },
  text_ghost: {
    color: colors.textMuted,
  },
  text_danger: {
    color: colors.bg,
  },
});
