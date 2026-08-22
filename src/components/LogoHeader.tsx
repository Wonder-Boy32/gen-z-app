import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

type Props = {
  compact?: boolean;
  transparent?: boolean;
  subtitle?: string;
};

export default function LogoHeader({ compact, transparent, subtitle }: Props) {
  return (
    <View style={styles.wrapper}>
      <View
        style={[
          styles.wrap,
          transparent && styles.wrapTransparent,
          compact && styles.wrapCompact,
        ]}
      >
        <View style={[styles.badge, compact && styles.badgeCompact]}>
          <Image
            source={require('../../assets/icon.png')}
            style={[styles.img, compact && styles.imgCompact]}
          />
        </View>
        <Text style={[styles.wordmark, compact && styles.wordmarkCompact]}>GEN Z</Text>
      </View>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
  },
  wrapTransparent: {
    backgroundColor: 'rgba(7,11,24,0.45)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  wrapCompact: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  badgeCompact: {
    width: 26,
    height: 26,
    borderRadius: 8,
  },
  img: {
    width: 40,
    height: 40,
  },
  imgCompact: {
    width: 26,
    height: 26,
  },
  wordmark: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 2,
    marginLeft: 10,
  },
  wordmarkCompact: {
    fontSize: 14,
    marginLeft: 8,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 6,
  },
});
