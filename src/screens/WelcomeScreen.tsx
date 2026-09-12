import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radius, shadows } from '../theme';
import Icon from '../components/ui/Icon';
import Button from '../components/Button';
import { TOP_INSET } from '../utils/useInsets';

// ============================================================
// GEN Z — WELCOME (first-run / logged-out entry)
// Instagram-style welcome: brand, what's inside, and one big
// call to action — "Explore Gen Z" — that leads to signup.
// ============================================================

const FEATURES: { icon: any; color: string; title: string; sub: string }[] = [
  { icon: 'flame', color: colors.accent, title: 'Drop what’s happening', sub: 'Right now, from people around you' },
  { icon: 'time', color: colors.cyan, title: 'Gone in 48 hours', sub: 'Every story disappears — no archive' },
  { icon: 'eye-off', color: colors.violet, title: 'Anonymous messages', sub: 'See who’s curious 👀' },
];

export default function WelcomeScreen({
  onExplore,
  onLogin,
}: {
  onExplore: () => void;
  onLogin: () => void;
}) {
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(26)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.spring(slide, { toValue: 0, friction: 7, tension: 60, useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[styles.inner, { opacity: fade, transform: [{ translateY: slide }] }]}
      >
        <View style={styles.brandBlock}>
          <View style={styles.logoMark}>
            <Image source={require('../../assets/icon-navy.png')} style={styles.logoImage} />
          </View>
          <Text style={styles.wordmark}>GEN Z</Text>
          <Text style={styles.tagline}>Every story. Gone in 48 hours.</Text>
        </View>

        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f.title} style={styles.featureRow}>
              <View style={styles.featureIcon}>
                <Icon name={f.icon} size={20} color={f.color} />
              </View>
              <View style={styles.featureBody}>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureSub}>{f.sub}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.ctaBlock}>
          <Button title="Explore Gen Z — see what’s happening" onPress={onExplore} />
          <Text style={styles.ctaHint}>See what’s happening right now. No waiting.</Text>

          <Pressable style={styles.loginBtn} onPress={onLogin} hitSlop={8}>
            <Text style={styles.loginText}>Already have an account? Log in</Text>
          </Pressable>
        </View>
      </Animated.View>

      <Text style={styles.legal}>
        By continuing, you agree to our Terms and Privacy Policy.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'space-between',
  },
  inner: {
    flex: 1,
    paddingTop: TOP_INSET + 40,
    paddingHorizontal: 28,
  },
  brandBlock: {
    alignItems: 'center',
  },
  logoMark: {
    width: 104,
    height: 104,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  logoImage: {
    width: 90,
    height: 90,
    borderRadius: 22,
  },
  wordmark: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 6,
    marginTop: 18,
  },
  tagline: {
    color: colors.textMuted,
    fontSize: 14,
    letterSpacing: 0.4,
    marginTop: 6,
  },
  features: {
    marginTop: 40,
    gap: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  featureIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureBody: {
    flex: 1,
  },
  featureTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  featureSub: {
    color: colors.textMuted,
    fontSize: 12.5,
    marginTop: 1,
  },
  ctaBlock: {
    marginTop: 'auto',
    marginBottom: 18,
  },
  ctaHint: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  loginBtn: {
    marginTop: 18,
    alignItems: 'center',
    paddingVertical: 8,
  },
  loginText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  legal: {
    color: colors.textFaint,
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 40,
    paddingBottom: 18,
    lineHeight: 16,
  },
});
