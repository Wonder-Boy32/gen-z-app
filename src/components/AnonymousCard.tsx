import React, { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import Icon from './ui/Icon';

// The shareable anonymous-message card — rendered as a view so it can be
// captured to an image (react-native-view-shot) and posted as a photo Drop.
const AnonymousCard = forwardRef<
  View,
  { username: string; link: string; message?: string | null; kind: 'link' | 'message' }
>(function AnonymousCard({ username, link, message, kind }, ref) {
  return (
    <View ref={ref} style={styles.card} collapsable={false}>
      <View style={styles.bgGlow}>
        <View style={styles.globeTop}>
          <View style={styles.maskIcon}>
            <Icon name="eye-off" size={26} color={colors.accent} />
          </View>
          <Text style={styles.brand}>GEN Z</Text>
        </View>

        <View style={styles.center}>
          <Text style={styles.kicker}>
            {kind === 'link' ? '🕵️ SEND ANONYMOUSLY' : '🕵️ ANONYMOUS MESSAGE'}
          </Text>
          {kind === 'link' ? (
            <>
              <Text style={styles.title}>Send @{username} a message.</Text>
              <Text style={styles.subtitle}>They won't see your identity — just the message.</Text>
            </>
          ) : (
            <>
              <Text style={styles.message}>{message}</Text>
              <Text style={styles.fromLine}>— sent anonymously to @{username}</Text>
            </>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.linkText}>{link}</Text>
          <Text style={styles.footerHint}>
            {kind === 'link'
              ? 'Open Gen Z to send — or share this anywhere.'
              : 'Gone soon — like every Drop, 48 hours max.'}
          </Text>
        </View>
      </View>
    </View>
  );
});

export default AnonymousCard;

const styles = StyleSheet.create({
  card: {
    width: 340,
    height: 460,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: '#0d1426',
  },
  bgGlow: {
    flex: 1,
    padding: 22,
    justifyContent: 'space-between',
    backgroundColor: '#0d1426',
  },
  globeTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  maskIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,122,0,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,122,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brand: { color: colors.text, fontSize: 18, fontWeight: '900', letterSpacing: 3 },
  center: { flex: 1, justifyContent: 'center', paddingVertical: 10 },
  kicker: { color: colors.accent, fontSize: 12, fontWeight: '900', letterSpacing: 1.4, marginBottom: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '900', lineHeight: 31 },
  subtitle: { color: colors.textMuted, fontSize: 13.5, marginTop: 8, lineHeight: 19 },
  message: { color: colors.text, fontSize: 19, fontWeight: '800', lineHeight: 27 },
  fromLine: { color: colors.textMuted, fontSize: 12, marginTop: 12 },
  footer: { alignItems: 'center' },
  linkText: { color: colors.accent, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.4 },
  footerHint: { color: colors.textMuted, fontSize: 10.5, marginTop: 6, textAlign: 'center' },
});
