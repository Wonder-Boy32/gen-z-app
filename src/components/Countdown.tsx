import React, { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../theme';

type Props = {
  expiresAt: string;
  style?: object;
};

export default function Countdown({ expiresAt, style }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000); // tick every 30s
    return () => clearInterval(t);
  }, []);

  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) {
    return <Text style={[styles.gone, style]}>💨 Gone</Text>;
  }
  const mins = Math.floor(ms / 60000);
  if (mins < 60) {
    return <Text style={[styles.urgent, style]}>🔥 LAST {mins} MIN</Text>;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return <Text style={[styles.normal, style]}>⏳ {h}h {m}m left</Text>;
}

const styles = StyleSheet.create({
  normal: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  urgent: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  gone: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '600',
  },
});
