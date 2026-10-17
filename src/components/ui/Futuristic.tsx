// ============================================================
// Shared futuristic primitives.
//
// WHY THIS FILE EXISTS: these were first written inline in CreateDropScreen.
// Discover needs the same language, and copying them a second time would mean
// two drifting copies. Gradients and glow are COMPOSED FROM VIEWS on purpose:
// expo-linear-gradient is not a dependency of this app, and adding a native
// module would force another native rebuild.
//
// Nothing here is a native module and nothing here touches the network.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';
import Icon, { IconName } from './Icon';

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const raw = hex.replace('#', '').trim();
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export const rgbaOf = (c: Rgb, alpha: number) => `rgba(${c.r},${c.g},${c.b},${alpha})`;

/** absolute fill, spelled out — this RN version's typings lack absoluteFillObject */
export const FILL = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

/**
 * A real linear gradient built from `steps` stacked views. Keep `steps` low when
 * the two colours are close — banding is invisible at low contrast.
 */
export function GradientFill({
  from,
  to,
  steps = 14,
  horizontal,
  alphaFrom = 1,
  alphaTo = 1,
  style,
}: {
  from: string;
  to: string;
  steps?: number;
  horizontal?: boolean;
  alphaFrom?: number;
  alphaTo?: number;
  style?: any;
}) {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const bands: React.ReactNode[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 0 : i / (steps - 1);
    bands.push(
      <View
        key={i}
        style={{ flex: 1, backgroundColor: rgbaOf(mixRgb(start, end, t), alphaFrom + (alphaTo - alphaFrom) * t) }}
      />
    );
  }
  return (
    <View pointerEvents="none" style={[{ flexDirection: horizontal ? 'row' : 'column' }, style]}>
      {bands}
    </View>
  );
}

/** Soft radial falloff, approximated with concentric translucent circles. */
export function Glow({
  color,
  size,
  strength = 0.18,
  style,
}: {
  color: string;
  size: number;
  strength?: number;
  style?: any;
}) {
  const base = hexToRgb(color);
  const rings = [
    { scale: 1, alpha: 0.3 },
    { scale: 0.66, alpha: 0.6 },
    { scale: 0.36, alpha: 1 },
  ];
  return (
    <View
      pointerEvents="none"
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      {rings.map((r) => {
        const d = Math.round(size * r.scale);
        return (
          <View
            key={r.scale}
            style={{
              position: 'absolute',
              width: d,
              height: d,
              borderRadius: d / 2,
              backgroundColor: rgbaOf(base, strength * r.alpha),
            }}
          />
        );
      })}
    </View>
  );
}

/**
 * Press feedback — a small scale + opacity dip.
 * `containerStyle` belongs on the Pressable (use it for flex/margins so the item
 * lays out correctly inside a row); `style` goes on the animated surface.
 */
export function Press({
  onPress,
  onLongPress,
  style,
  containerStyle,
  children,
  shrink = 0.97,
  disabled,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  style?: any;
  containerStyle?: any;
  children: React.ReactNode;
  shrink?: number;
  disabled?: boolean;
}) {
  const v = useRef(new Animated.Value(0)).current;
  const to = (n: number) =>
    Animated.spring(v, { toValue: n, useNativeDriver: true, speed: 42, bounciness: 0 }).start();

  return (
    <Pressable
      style={containerStyle}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
    >
      <Animated.View
        style={[
          style,
          {
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, shrink] }) }],
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] }),
          },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

/** HUD corner brackets — the "scanner frame" around a feature card. */
export function CornerBrackets({
  color,
  size = 20,
  inset = 10,
}: {
  color: string;
  size?: number;
  inset?: number;
}) {
  const base = { position: 'absolute' as const, width: size, height: size, borderColor: color };
  return (
    <>
      <View
        pointerEvents="none"
        style={[base, { top: inset, left: inset, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { top: inset, right: inset, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { bottom: inset, left: inset, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { bottom: inset, right: inset, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 12 }]}
      />
    </>
  );
}

/**
 * Horizontally scrolling animated pills with a gradient sliding indicator.
 * Used by Discover's category row.
 */
export type PillOption<T extends string> = { id: T; label: string };

export function PillBar<T extends string>({
  options,
  value,
  onChange,
}: {
  options: PillOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  // each pill animates its own selection crossfade — simpler and steadier than
  // measuring a single sliding indicator across a scrolling row
  return (
    <View style={styles.pillRow}>
      {options.map((o) => (
        <Pill key={o.id} label={o.label} active={value === o.id} onPress={() => onChange(o.id)} />
      ))}
    </View>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(v, { toValue: active ? 1 : 0, duration: 180, useNativeDriver: false }).start();
  }, [active, v]);

  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Animated.View
        style={[
          styles.pill,
          active && styles.pillGlow,
          {
            // These two output ranges used to be the dark palette written out
            // as literals ('rgba(20,28,51,1)' / 'rgba(30,42,71,1)'). An animated
            // outputRange is not a style-sheet value, so the theme remap in
            // theme.ts could never reach it: in White mode every unselected
            // pill stayed navy while the rest of Discover turned white.
            // Reading colors.* here is safe because this object is rebuilt on
            // each render, so it picks up the palette the moment it changes.
            backgroundColor: v.interpolate({
              inputRange: [0, 1],
              outputRange: [colors.surfaceAlt, colors.accentSoft],
            }),
            borderColor: v.interpolate({
              inputRange: [0, 1],
              outputRange: [colors.border, colors.accent],
            }),
          },
        ]}
      >
        <Animated.Text
          style={[
            styles.pillText,
            {
              color: v.interpolate({
                inputRange: [0, 1],
                outputRange: [colors.textMuted, colors.accent],
              }),
            },
          ]}
        >
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

/** Section heading: tinted icon chip, title, optional subtitle. */
export function SectionHead({
  icon,
  title,
  sub,
  tint,
  right,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  tint?: string;
  right?: React.ReactNode;
}) {
  const c = tint ?? colors.accent;
  const base = hexToRgb(c);
  return (
    <View style={styles.head}>
      <View
        style={[
          styles.headIcon,
          { backgroundColor: rgbaOf(base, 0.14), borderColor: rgbaOf(base, 0.3) },
        ]}
      >
        <Icon name={icon} size={15} color={c} />
      </View>
      <View style={styles.headText}>
        <Text style={styles.headTitle}>{title}</Text>
        {!!sub && <Text style={styles.headSub}>{sub}</Text>}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  pillRow: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillGlow: {
    shadowColor: colors.accent,
    shadowOpacity: 0.3,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  pillText: { fontSize: 12.5, fontWeight: '700' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1 },
  headTitle: { color: colors.text, fontSize: 16.5, fontWeight: '800', letterSpacing: -0.2 },
  headSub: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginTop: 2 },
});
