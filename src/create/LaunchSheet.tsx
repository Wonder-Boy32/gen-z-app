// ============================================================
// src/create/LaunchSheet.tsx
// ============================================================
// The sheet that appears over the camera the instant + is tapped.
//
// WHY IT SITS OVER THE CAMERA AND NOT IN FRONT OF IT
//
// The obvious build is: sheet first, camera after. That is also the one that
// feels slow — the camera takes a beat to wake up (permission check, sensor
// handover, first preview frame), and that beat is exactly the length of the
// sheet animation, so the wait lands on the transition the user is watching.
//
// Mounting the camera first and sliding the sheet over it hides the wake-up
// behind the sheet. By the time you have read three rows, the preview is live
// and you can shoot immediately. Same reason the reference app puts its sheet
// over a running viewfinder.
//
// It is rendered through CaptureScreen's `overlay` prop, so it lives inside the
// camera's own <Modal>. A sibling <Modal> on Android stacks by render order and
// loses that fight intermittently; inside the same Modal there is nothing to
// race.

import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../components/ui/Icon';
import { colors, radius } from '../theme';
import { useInsets } from '../utils/useInsets';
import { LAUNCHER, RESUME, type LauncherChoice } from './flow';

/** One row. Shared so the draft row cannot drift from the three permanent ones. */
function Row({
  icon,
  title,
  sub,
  onPress,
  highlight,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
  sub: string;
  onPress: () => void;
  highlight?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={[styles.rowIcon, highlight && styles.rowIconHot]}>
        <Icon name={icon} size={20} color={colors.accent} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowSub}>{sub}</Text>
      </View>
      <Icon name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

export default function LaunchSheet({
  onChoose,
  onDismiss,
  hasDraft = false,
}: {
  onChoose: (choice: LauncherChoice) => void;
  onDismiss: () => void;
  hasDraft?: boolean;
}) {
  const insets = useInsets();
  const slide = useRef(new Animated.Value(220)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      // 220 is the sheet's max height; starting below that means it rises from
      // off-screen without measuring, which a value-based transform cannot do.
      Animated.spring(slide, { toValue: 0, friction: 9, tension: 90, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [slide, fade]);

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Tapping the world behind the sheet is the same as "not now": the
          camera is already underneath, so dismissing reveals rather than
          navigates. */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <Pressable style={styles.scrim} onPress={onDismiss} accessibilityLabel="Dismiss" />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, 12) + 10, transform: [{ translateY: slide }] },
        ]}
      >
        <View style={styles.grabber} />

        <Text style={styles.kicker}>CREATE</Text>
        <Text style={styles.title}>What are you posting?</Text>

        {hasDraft && (
          <Row
            icon={RESUME.icon}
            title={RESUME.title}
            sub={RESUME.sub}
            highlight
            onPress={() => onChoose('resume')}
          />
        )}

        {LAUNCHER.map((item) => (
          <Row
            key={item.choice}
            icon={item.icon}
            title={item.title}
            sub={item.sub}
            onPress={() => onChoose(item.choice)}
          />
        ))}

        <Pressable onPress={onDismiss} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelText}>Not now — just the camera</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(3,1,9,0.62)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  kicker: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginLeft: 4,
  },
  title: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    marginTop: 3,
    marginBottom: 12,
    marginLeft: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: radius.md,
  },
  rowPressed: {
    backgroundColor: colors.accentSoft,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  rowIconHot: {
    borderWidth: 1,
    borderColor: colors.accent,
  },
  rowText: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  cancel: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  cancelText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
});
