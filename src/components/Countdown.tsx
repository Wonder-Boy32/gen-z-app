import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import Icon from './ui/Icon';

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
    return <Text style={[styles.gone, style]}>Gone</Text>;
  }
  const mins = Math.floor(ms / 60000);
  if (mins < 60) {
    return (
      <View style={[styles.row, style]}>
        <Icon name="flame" size={12} color={colors.accent} />
        <Text style={styles.urgent}>LAST {mins} MIN</Text>
      </View>
    );
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return (
    <View style={[styles.row, style]}>
      <Icon name="hourglass-outline" size={12} color={colors.textMuted} />
      <Text style={styles.normal}>{h}h {m}m left</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
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
