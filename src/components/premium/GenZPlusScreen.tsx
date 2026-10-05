import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, shadows } from '../../theme';
import { TOP_INSET } from '../../utils/useInsets';
import { copyToClipboard } from '../../utils/clipboard';
import Icon from '../ui/Icon';
import Button from '../Button';
import { friendlyError } from '../../utils/friendlyError';
import {
  GENZPLUS_MIN_REFERENCE,
  GENZPLUS_PRICE_LABEL,
  daysUntil,
  fetchGenZPlusEntitlement,
  fetchPaymentClaim,
  fetchPaymentConfig,
  formatDate,
  submitPaymentClaim,
  type GenZPlusEntitlement,
  type PaymentClaim,
  type PaymentConfig,
} from '../../services/genzplus';

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

const NO_CLAIM: PaymentClaim = {
  status: 'none',
  reference: null,
  submittedAt: null,
  reviewNote: null,
};

type Step = 'paywall' | 'confirm' | 'transfer';
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
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [claim, setClaim] = useState<PaymentClaim>(NO_CLAIM);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>('paywall');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);

  // Held in a ref so `load` keeps a STABLE identity — SettingsScreen passes an
  // inline arrow, and depending on it directly would re-create the callback on
  // every parent render and re-fire the load effect below.
  const onActivatedRef = useRef(onActivated);
  useEffect(() => {
    onActivatedRef.current = onActivated;
  }, [onActivated]);

  const load = useCallback(async () => {
    const [next, cfg, cl] = await Promise.all([
      fetchGenZPlusEntitlement(),
      fetchPaymentConfig(),
      fetchPaymentClaim(),
    ]);
    setEnt(next);
    setConfig(cfg);
    setClaim(cl);
    setLoading(false);
    if (next.active) onActivatedRef.current?.();
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Once an admin confirms the payment, the user may still be sitting on this
  // screen. Re-read when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  const active = !!ent?.active;
  const pending = claim.status === 'pending';
  const rejected = claim.status === 'rejected';

  const priceLabel = config?.amountLabel ?? GENZPLUS_PRICE_LABEL;
  const periodLabel = `every ${config?.periodMonths ?? 2} months`;
  const daysLeft = daysUntil(ent?.expiresAt ?? null);

  const copyAccount = async () => {
    if (!config?.accountNumber) return;
    await copyToClipboard(config.accountNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const out = await submitPaymentClaim({
      reference,
      note,
      amountKobo: config?.amountKobo,
    });
    setBusy(false);

    if (!out.ok) {
      setNotice({ tone: 'error', text: friendlyError(out) });
      return;
    }

    setReference('');
    setNote('');
    setStep('paywall');
    setNotice({ tone: 'info', text: friendlyError(out) });
    // Re-read: the claim is now pending, which replaces the CTA with a status card.
    load();
  };

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
            {active && (
              <View style={[styles.card, styles.cardActive]}>
                <Text style={styles.cardTitle}>You are GenZ+</Text>
                <Text style={styles.cardBody}>
                  {ent?.expiresAt
                    ? `Active until ${formatDate(ent.expiresAt)}${
                        daysLeft !== null && daysLeft > 0 ? ` — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''
                      }.`
                    : 'Active permanently — thank you for supporting GenZ.'}
                </Text>
              </View>
            )}

            {pending && (
              <View style={[styles.card, styles.cardPending]}>
                <Text style={styles.cardTitle}>Payment under review</Text>
                <Text style={styles.cardBody}>
                  {claim.submittedAt ? `Submitted ${formatDate(claim.submittedAt)}. ` : ''}
                  We are confirming your transfer. GenZ+ activates as soon as it clears —
                  open this screen again to check.
                </Text>
                {!!claim.reference && (
                  <Text style={styles.refLine}>Reference: {claim.reference}</Text>
                )}
              </View>
            )}

            {rejected && (
              <View style={[styles.card, styles.cardRejected]}>
                <Text style={styles.cardTitle}>We could not confirm that payment</Text>
                <Text style={styles.cardBody}>
                  {claim.reviewNote ||
                    'We could not match that reference to a transfer. Check the reference and submit it again.'}
                </Text>
              </View>
            )}

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
            {!pending && (
              <View style={styles.priceBlock}>
                <Text style={styles.priceLine}>
                  GenZ+ — {priceLabel}
                </Text>
                <Text style={styles.priceSub}>
                  {periodLabel} · activates once your payment is confirmed
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

            {/* ---------------- step: confirm ---------------- */}
            {!pending && step === 'confirm' && (
              <View style={[styles.card, styles.confirmCard]}>
                <Text style={styles.confirmTitle}>Confirm your purchase</Text>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmKey}>Item</Text>
                  <Text style={styles.confirmVal}>GenZ+ ({periodLabel})</Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmKey}>Total</Text>
                  <Text style={styles.confirmTotal}>{priceLabel}</Text>
                </View>
                <Text style={styles.confirmNote}>
                  You will transfer this amount to our OPay account, then submit your
                  transfer reference. GenZ+ is activated by our team after the payment is
                  confirmed — never by tapping a button.
                </Text>
                <Button title="Continue to payment" onPress={() => setStep('transfer')} />
                <Pressable
                  onPress={() => {
                    setStep('paywall');
                    setNotice(null);
                  }}
                  style={styles.cancelBtn}
                  hitSlop={8}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </View>
            )}

            {/* ---------------- step: transfer ---------------- */}
            {!pending && step === 'transfer' && (
              <View style={[styles.card, styles.payCard]}>
                <Text style={styles.confirmTitle}>Pay {priceLabel} by OPay</Text>

                <View style={styles.payRow}>
                  <Text style={styles.payKey}>Amount</Text>
                  <Text style={styles.payAmount}>{priceLabel}</Text>
                </View>

                <View style={styles.payRow}>
                  <Text style={styles.payKey}>Bank</Text>
                  <Text style={styles.payVal}>OPay</Text>
                </View>

                {!!config?.accountName && (
                  <View style={styles.payRow}>
                    <Text style={styles.payKey}>Account name</Text>
                    <Text style={styles.payVal}>{config.accountName}</Text>
                  </View>
                )}

                <View style={styles.payRow}>
                  <Text style={styles.payKey}>Account number</Text>
                  <View style={styles.payNumberCell}>
                    <Text style={styles.payNumber}>{config?.accountNumber ?? '—'}</Text>
                    <Pressable onPress={copyAccount} hitSlop={8} style={styles.copyBtn}>
                      <Icon
                        name={copied ? 'checkmark' : 'copy-outline'}
                        size={15}
                        color={copied ? colors.success : colors.accent}
                      />
                      <Text style={[styles.copyText, copied && styles.copyTextDone]}>
                        {copied ? 'Copied' : 'Copy'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                {!config?.accountName && (
                  <Text style={styles.payWarn}>
                    Confirm the account name in your OPay app before sending.
                  </Text>
                )}

                {!!config?.instructions && (
                  <Text style={styles.payInstructions}>{config.instructions}</Text>
                )}

                <Text style={styles.fieldLabel}>Transfer reference</Text>
                <TextInput
                  style={styles.input}
                  value={reference}
                  onChangeText={setReference}
                  placeholder="From your OPay receipt"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="characters"
                  maxLength={64}
                />

                <Text style={styles.fieldLabel}>Note (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything we should know"
                  placeholderTextColor={colors.textFaint}
                  maxLength={200}
                />

                <View style={{ height: 14 }} />
                <Button
                  title={busy ? 'Submitting…' : "I've sent the payment"}
                  onPress={submit}
                  loading={busy}
                  disabled={busy || reference.trim().length < GENZPLUS_MIN_REFERENCE}
                />
                <Pressable
                  onPress={() => {
                    setStep('paywall');
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
            {!pending && step === 'paywall' && (
              <Button
                title={active ? '✨ Extend GenZ+' : '✨ Unlock GenZ+'}
                onPress={() => {
                  setNotice(null);
                  setStep('confirm');
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
  cardPending: { borderColor: colors.borderStrong, backgroundColor: colors.surfaceAlt },
  cardRejected: { borderColor: colors.danger },
  cardEmoji: { fontSize: 22 },
  cardInfo: { flex: 1 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  cardBody: { color: colors.textMuted, fontSize: 15, lineHeight: 21, marginTop: 3 },
  refLine: { color: colors.textFaint, fontSize: 12, marginTop: 8, letterSpacing: 0.3 },

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

  payCard: {
    flexDirection: 'column',
    borderColor: colors.accent,
    backgroundColor: colors.surfaceAlt,
    paddingBottom: 14,
  },
  payRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  payKey: { color: colors.textMuted, fontSize: 14 },
  payVal: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  payAmount: { color: colors.accent, fontSize: 18, fontWeight: '800' },
  payNumberCell: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  payNumber: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: 1.1 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  copyText: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  copyTextDone: { color: colors.success },
  payWarn: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: 10 },
  payInstructions: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 12 },

  fieldLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '500', marginTop: 14, marginBottom: 6 },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },

  fineprint: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 18,
    paddingHorizontal: 8,
  },
});
