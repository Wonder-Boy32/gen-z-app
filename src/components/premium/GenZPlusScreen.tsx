import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, radius, shadows } from '../../theme';
import { TOP_INSET } from '../../utils/useInsets';
import Icon from '../ui/Icon';
import Button from '../Button';
import {
  GENZPLUS_PRICE_LABEL,
  beginGenZPlusPurchase,
  fetchGenZPlusEntitlement,
  type GenZPlusEntitlement,
} from '../../services/genzplus';

// The spec pinned the price but not the period, so this defaults to one-time /
// lifetime to match the database default (plan = 'lifetime'). If it should read
// "Yearly" or "Monthly", change this string AND pass the matching plan to
// genzplus_activate() on the server — nothing else needs to move.
const PLAN_LABEL = 'One-time payment';

const BENEFITS = [
  {
    emoji: '✨',
    title: 'Stand Out',
    body: 'Exclusive profile customization and premium profile features.',
  },
  {
    emoji: '🚀',
    title: 'Get Discovered',
    body: 'Enhanced discovery and profile visibility features.',
  },
  {
    emoji: '📊',
    title: 'See Your Impact',
    body: 'More detailed profile and content insights.',
  },
  {
    emoji: '👻',
    title: 'More Control',
    body: 'Additional privacy and interaction controls.',
  },
  {
    emoji: '🎨',
    title: 'Exclusive Features',
    body: 'Access to premium effects, themes and future GenZ+ features.',
  },
];

type Notice = { tone: 'info' | 'error'; text: string } | null;

export default function GenZPlusScreen({
  onClose,
  onActivated,
}: {
  onClose: () => void;
  /** fired once entitlement is confirmed active, so Settings can refresh */
  onActivated?: () => void;
}) {
  const [ent, setEnt] = useState<GenZPlusEntitlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Entitlement comes from the database every time — never from local state.
  // This is what makes the screen honest: a client cannot fake its way to
  // "active", so re-reading is the only way to know.
  // Held in a ref so `load` keeps a STABLE identity. SettingsScreen passes an
  // inline arrow, so depending on it directly would re-create this callback on
  // every parent render and re-fire the load effect below each time.
  const onActivatedRef = useRef(onActivated);
  useEffect(() => {
    onActivatedRef.current = onActivated;
  }, [onActivated]);

  const load = useCallback(async () => {
    const next = await fetchGenZPlusEntitlement();
    setEnt(next);
    setLoading(false);
    if (next.active) onActivatedRef.current?.();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A purchase finishes in the provider's browser. When the user comes back,
  // re-read entitlement so premium appears the moment the server has confirmed
  // the payment — rather than requiring a manual refresh.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  const startPurchase = async () => {
    setBusy(true);
    setNotice(null);

    const out = await beginGenZPlusPurchase();
    setBusy(false);

    if (out.status === 'already_active') {
      setConfirming(false);
      setNotice({ tone: 'info', text: 'You are already GenZ+.' });
      load();
      return;
    }
    if (out.status === 'unavailable') {
      // Server says payments are not configured yet. Show its reason plainly
      // instead of pretending to charge.
      setConfirming(false);
      setNotice({ tone: 'info', text: out.message });
      return;
    }
    if (out.status === 'failed') {
      setNotice({ tone: 'error', text: out.message });
      return;
    }

    setConfirming(false);
    try {
      await Linking.openURL(out.checkoutUrl);
      setNotice({
        tone: 'info',
        text: 'Finish the payment in the browser, then come back here. GenZ+ activates automatically once the payment is confirmed.',
      });
    } catch {
      setNotice({ tone: 'error', text: 'Could not open the payment page.' });
    }
  };

  const active = !!ent?.active;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn} hitSlop={10}>
            <Icon name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>GenZ+</Text>
          <View style={styles.backBtn} />
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* ---------------- hero ---------------- */}
            <View style={styles.hero}>
              <Text style={styles.heroGlyph}>✨</Text>
              <Text style={styles.heroTitle}>GenZ+</Text>
              <Text style={styles.heroTagline}>
                Your profile. Your rules. More ways to stand out.
              </Text>
              {active && (
                <View style={styles.activePill}>
                  <Icon name="checkmark-circle" size={14} color={colors.bg} />
                  <Text style={styles.activePillText}>GENZ+ ACTIVE</Text>
                </View>
              )}
            </View>

            {/* ---------------- status ---------------- */}
            {active ? (
              <View style={[styles.card, styles.cardActive]}>
                <Text style={styles.cardTitle}>You are GenZ+</Text>
                <Text style={styles.cardBody}>
                  {ent?.expiresAt
                    ? `Active until ${new Date(ent.expiresAt).toLocaleDateString()}.`
                    : 'Active permanently — thank you for supporting GenZ.'}
                </Text>
              </View>
            ) : null}

            {/* ---------------- benefits ---------------- */}
            <Text style={styles.sectionLabel}>WHAT YOU GET</Text>
            {BENEFITS.map((b) => (
              <View key={b.title} style={styles.card}>
                <Text style={styles.cardEmoji}>{b.emoji}</Text>
                <View style={styles.cardInfo}>
                  <Text style={styles.cardTitle}>{b.title}</Text>
                  <Text style={styles.cardBody}>{b.body}</Text>
                </View>
              </View>
            ))}

            {/* ---------------- price ---------------- */}
            {!active && (
              <View style={styles.priceBlock}>
                <Text style={styles.priceLine}>
                  GenZ+ — {GENZPLUS_PRICE_LABEL}
                </Text>
                <Text style={styles.priceSub}>
                  {PLAN_LABEL} · activates immediately after payment
                </Text>
              </View>
            )}

            {notice && (
              <View
                style={[
                  styles.notice,
                  notice.tone === 'error' ? styles.noticeError : styles.noticeInfo,
                ]}
              >
                <Text style={styles.noticeText}>{notice.text}</Text>
              </View>
            )}

            {/* ---------------- confirmation step ---------------- */}
            {!active && confirming && (
              <View style={[styles.card, styles.confirmCard]}>
                <Text style={styles.confirmTitle}>Confirm your purchase</Text>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmKey}>Item</Text>
                  <Text style={styles.confirmVal}>GenZ+ ({PLAN_LABEL})</Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmKey}>Total</Text>
                  <Text style={styles.confirmTotal}>{GENZPLUS_PRICE_LABEL}</Text>
                </View>
                <Text style={styles.confirmNote}>
                  You will be taken to a secure checkout. GenZ+ is activated by our
                  server only after the payment is confirmed.
                </Text>
                <Button
                  title={busy ? 'Starting…' : `Pay ${GENZPLUS_PRICE_LABEL}`}
                  onPress={startPurchase}
                  loading={busy}
                  disabled={busy}
                />
                <Pressable
                  onPress={() => {
                    setConfirming(false);
                    setNotice(null);
                  }}
                  style={styles.cancelBtn}
                  hitSlop={8}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </View>
            )}

            {/* ---------------- CTA ---------------- */}
            {!active && !confirming && (
              <Button
                title="✨ Unlock GenZ+"
                onPress={() => {
                  setNotice(null);
                  setConfirming(true);
                }}
              />
            )}

            <Text style={styles.fineprint}>
              Verification is separate from GenZ+ — GenZ+ is premium features, not a
              verification badge.
            </Text>
            <View style={{ height: 34 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP_INSET + 6,
    paddingBottom: 10,
    paddingHorizontal: 8,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 18, paddingBottom: 20 },

  hero: { alignItems: 'center', paddingTop: 6, paddingBottom: 20 },
  heroGlyph: { fontSize: 40 },
  heroTitle: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 4,
  },
  heroTagline: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: 12,
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accent,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    marginTop: 12,
  },
  activePillText: { color: colors.bg, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },

  sectionLabel: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
    marginTop: 4,
  },

  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 10,
  },
  cardActive: { borderColor: colors.accent, backgroundColor: colors.surfaceAlt },
  cardEmoji: { fontSize: 22 },
  cardInfo: { flex: 1 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  cardBody: { color: colors.textMuted, fontSize: 15, lineHeight: 21, marginTop: 3 },

  priceBlock: {
    alignItems: 'center',
    paddingVertical: 18,
    marginTop: 4,
    marginBottom: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  priceLine: {
    color: colors.accent,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0.6,
    ...(shadows.glow as object),
  },
  priceSub: { color: colors.textMuted, fontSize: 13, fontWeight: '500', marginTop: 6 },

  notice: { borderRadius: radius.md, padding: 12, marginBottom: 12 },
  noticeInfo: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong },
  noticeError: { backgroundColor: 'rgba(255,92,124,0.12)', borderWidth: 1, borderColor: colors.danger },
  noticeText: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '500' },

  confirmCard: {
    flexDirection: 'column',
    borderColor: colors.accent,
    backgroundColor: colors.surfaceAlt,
    paddingBottom: 14,
  },
  confirmTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 10 },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  confirmKey: { color: colors.textMuted, fontSize: 14 },
  confirmVal: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  confirmTotal: { color: colors.accent, fontSize: 18, fontWeight: '800' },
  confirmNote: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginVertical: 12 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },

  fineprint: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 18,
    paddingHorizontal: 8,
  },
});
