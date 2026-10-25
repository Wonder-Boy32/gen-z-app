import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

type Props = {
  compact?: boolean;
  transparent?: boolean;
  subtitle?: string;
  /** 'start' pins the lockup to the left edge instead of centring it. The feed
   *  header needs this: the reference puts the wordmark top-left with the
   *  search and message controls opposite it. */
  align?: 'center' | 'start';
};

export default function LogoHeader({ compact, transparent, subtitle, align = 'center' }: Props) {
  return (
    <View style={[styles.wrapper, align === 'start' && styles.wrapperStart]}>
      <View
        style={[
          styles.wrap,
          transparent && styles.wrapTransparent,
          compact && styles.wrapCompact,
          align === 'start' && styles.wrapStart,
        ]}
      >
        <View style={[styles.badge, compact && styles.badgeCompact]}>
          <Image
            source={require('../../assets/icon-navy.png')}
            style={[styles.img, compact && styles.imgCompact]}
          />
        </View>
        {/* The REAL brand wordmark, lifted from the logo artwork — not typed
            text. Typing it meant the device font stood in for the brand's
            actual display face, so the letterforms were only an approximation.
            This is the genuine artwork, so it is exact at every size. */}
        <Image
          source={require('../../assets/brand-wordmark.png')}
          style={[styles.wordmarkImg, compact && styles.wordmarkImgCompact]}
          resizeMode="contain"
        />
      </View>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  wrapperStart: {
    alignItems: 'flex-start',
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
  wrapStart: {
    alignSelf: 'flex-start',
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
  // The source asset is 554x150, so keeping width = height x 3.693 preserves
  // the aspect exactly. Heights are set just above the cap height of the 17pt /
  // 14pt text these replaced, so the header's visual weight is unchanged.
  wordmarkImg: {
    height: 16,
    width: 59,
    marginLeft: 10,
  },
  wordmarkImgCompact: {
    height: 12,
    width: 44,
    marginLeft: 8,
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
