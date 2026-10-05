import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { useSharedNow } from '../utils/sharedClock';
import Icon from './ui/Icon';

type Props = {
  /** the moment we count down to: starts_at while scheduled, otherwise ends_at / voting_ends_at */
  endsAt: string;
  mode: 'scheduled' | 'live' | 'voting' | 'closed';
  big?: boolean;
  /**
   * false = this countdown is offscreen, so stop ticking.
   *
   * Defaults to true so existing call sites keep working. Worth passing false
   * from inside a scrolling list — DiscoverScreen renders one DropCountdown per
   * drop card, so `active={viewable}` there avoids ticking cards scrolled out
   * of view.
   */
  active?: boolean;
};

export default function DropCountdown({ endsAt, mode, big, active = true }: Props) {
  // Shared 1s tick instead of a private interval per instance.
  //
  // Scale note, so this is not mistaken for a big fix: DropCountdown is not
  // rendered per feed post — only in the feed banner, per drop card in Discover,
  // and once on the drop screen. Previously each of those held its own interval;
  // now the whole app shares one.
  const now = useSharedNow(active);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (mode !== 'live') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.07, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [mode]);

  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) {
    return <Text style={[styles.closed, big && styles.closedBig]}>DROP CLOSED</Text>;
  }

  const totalMins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  // a drop that has not started yet is anticipation, not urgency - so no red
  const scheduled = mode === 'scheduled';
  const urgent = !scheduled && totalMins < 10;

  const text = scheduled
    ? totalMins < 60
      ? `STARTS IN ${Math.max(1, totalMins)} MIN`
      : `STARTS IN ${h}H ${m}M`
    : totalMins < 60
      ? `LAST ${totalMins} MIN`
      : `${h}H ${m}M LEFT`;

  return (
    <Animated.View style={{ transform: [{ scale: pulse }], alignItems: 'center' }}>
      <View style={styles.row}>
        <Icon
          name={scheduled ? 'time-outline' : urgent ? 'flash' : totalMins < 60 ? 'flame' : 'hourglass-outline'}
          size={big ? 22 : 14}
          color={urgent ? colors.danger : colors.accent}
        />
        <Text style={[styles.text, big && styles.textBig, urgent && styles.textUrgent]}>{text}</Text>
      </View>
      {urgent && (
        <Text style={[styles.seconds, big && styles.secondsBig]}>
          {String(totalMins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  textBig: {
    fontSize: 26,
  },
  textUrgent: {
    color: colors.danger,
  },
  seconds: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  secondsBig: {
    fontSize: 18,
  },
  closed: {
    color: colors.textFaint,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
  closedBig: {
    fontSize: 24,
  },
});
