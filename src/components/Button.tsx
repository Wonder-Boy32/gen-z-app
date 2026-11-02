import React, { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from 'react-native';
import { colors, radius } from '../theme';

// Ink for the solid primary fill. Near-black rather than white: #FFFFFF on
// #FF9A2E is 2.1:1 and unreadable at 16px, #0B0A14 on it is 8.9:1. Set once
// here so the label and the spinner can never drift apart.
const ON_PRIMARY = '#0B0A14';

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
        {/* The brand ramp stays on decorative surfaces (the dock outline, the
            story ring, the Edit Profile hero) where nothing has to be read on
            top of it. A BUTTON is not decorative: the ramp's light end is
            #22D3EE, and white text over it measured 2.1:1 — which is why
            "Create account" and "Log in" read as a blurred smudge in White
            theme. Solid accent with near-black ink is 8.9:1 in both themes and
            cannot fail if the SVG fill ever fails to draw. */}
        {loading ? (
          <ActivityIndicator color={variant === 'primary' ? ON_PRIMARY : colors.accent} />
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
    // A real fill, not a transparent window onto an SVG. The gradient used to
    // draw here, and when it did not the button still claimed 48px of height
    // and reported itself as a control — an invisible tap target with a purple
    // glow underneath it.
    backgroundColor: colors.accent,
    overflow: 'hidden',
    ...({
      shadowColor: colors.accent,
      shadowOpacity: 0.28,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4,
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
    color: ON_PRIMARY,
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
