import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius } from '../../theme';
import { TOP_INSET } from '../../utils/useInsets';
import Icon from '../ui/Icon';
import Button from '../Button';
import {
  VERIFICATION_MIN_REASON,
  fetchVerificationState,
  submitVerificationRequest,
  type VerificationState,
} from '../../services/verification';

const BENEFITS = [
  'Official verification badge',
  'Increased trust and credibility',
  'Helps people recognize your authentic account',
  'Makes your profile stand out',
  'Protection against impersonation',
  'Verification review by GenZ',
];

export default function GetVerifiedScreen({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<VerificationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [reason, setReason] = useState('');
  const [links, setLinks] = useState('');

  // Status is read from the database — verification cannot be self-granted,
  // so this is the only trustworthy source.
  const load = useCallback(async () => {
    const next = await fetchVerificationState();
    setState(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const out = await submitVerificationRequest({ displayName, reason, links });
    setBusy(false);
    if (!out.ok) {
      setNotice({ tone: 'error', text: out.message });
      return;
    }
    setApplying(false);
    setReason('');
    setLinks('');
    setNotice({ tone: 'info', text: out.message });
    load();
  };

  const status = state?.status ?? 'none';
  const isVerified = status === 'approved';
  const isPending = status === 'pending';
  const showApply = !isVerified && !isPending;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn} hitSlop={10}>
            <Icon name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Get Verified</Text>
          <View style={styles.backBtn} />
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <KeyboardAvoidingView style={styles.flex} behavior="padding">
            <ScrollView
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {/* ---------------- hero ---------------- */}
              <View style={styles.hero}>
                <View style={styles.heroBadge}>
                  <Icon name="checkmark" size={26} color={colors.bg} />
                </View>
                <Text style={styles.heroTitle}>Get Verified</Text>
                <Text style={styles.heroTagline}>Show people you're really you.</Text>
              </View>

              {/* ---------------- status ---------------- */}
              {isVerified && (
                <View style={[styles.card, styles.cardOk]}>
                  <Text style={styles.cardTitle}>You're verified</Text>
                  <Text style={styles.cardBody}>
                    Your account carries the official verification badge.
                  </Text>
                </View>
              )}

              {isPending && (
                <View style={[styles.card, styles.cardPending]}>
                  <Text style={styles.cardTitle}>Application under review</Text>
                  <Text style={styles.cardBody}>
                    {state?.submittedAt
                      ? `Submitted ${new Date(state.submittedAt).toLocaleDateString()}. `
                      : ''}
                    Our team reviews applications manually — we'll update your profile
                    once a decision is made.
                  </Text>
                </View>
              )}

              {status === 'rejected' && (
                <View style={[styles.card, styles.cardRejected]}>
                  <Text style={styles.cardTitle}>Application not approved</Text>
                  <Text style={styles.cardBody}>
                    {state?.reviewNote || 'You can apply again with more detail.'}
                  </Text>
                </View>
              )}

              {/* ---------------- benefits ---------------- */}
              <Text style={styles.sectionLabel}>WHY GET VERIFIED</Text>
              <View style={styles.benefitList}>
                {BENEFITS.map((b) => (
                  <View key={b} style={styles.benefitRow}>
                    <Icon name="checkmark-circle" size={16} color={colors.accent} />
                    <Text style={styles.benefitText}>{b}</Text>
                  </View>
                ))}
              </View>

              {/* ---------------- separation note ---------------- */}
              <View style={styles.separation}>
                <Text style={styles.separationText}>
                  Verification is not for sale and is not part of GenZ+. Buying GenZ+
                  never grants a verification badge — verification reflects
                  authenticity and is decided by a human review.
                </Text>
              </View>

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

              {/* ---------------- apply form ---------------- */}
              {showApply && applying && (
                <View style={[styles.card, styles.formCard]}>
                  <Text style={styles.cardTitle}>Tell us about your account</Text>

                  <Text style={styles.fieldLabel}>Name you're known by (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={displayName}
                    onChangeText={setDisplayName}
                    placeholder="e.g. Ada Creative"
                    placeholderTextColor={colors.textFaint}
                    maxLength={60}
                  />

                  <Text style={styles.fieldLabel}>
                    Why should you be verified? ({VERIFICATION_MIN_REASON}+ characters)
                  </Text>
                  <TextInput
                    style={[styles.input, styles.inputMultiline]}
                    value={reason}
                    onChangeText={setReason}
                    placeholder="What you do, and how people find you on GenZ."
                    placeholderTextColor={colors.textFaint}
                    multiline
                    maxLength={600}
                    textAlignVertical="top"
                  />
                  <Text style={styles.counter}>{reason.trim().length} characters</Text>

                  <Text style={styles.fieldLabel}>Links that back this up (optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={links}
                    onChangeText={setLinks}
                    placeholder="Website or social profiles, one per line"
                    placeholderTextColor={colors.textFaint}
                    multiline
                    maxLength={400}
                  />

                  <Button
                    title={busy ? 'Submitting…' : 'Submit application'}
                    onPress={submit}
                    loading={busy}
                    disabled={busy || reason.trim().length < VERIFICATION_MIN_REASON}
                  />
                  <Pressable
                    onPress={() => {
                      setApplying(false);
                      setNotice(null);
                    }}
                    style={styles.cancelBtn}
                    hitSlop={8}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                </View>
              )}

              {showApply && !applying && (
                <Button
                  title="Apply for Verification"
                  onPress={() => {
                    setNotice(null);
                    setApplying(true);
                  }}
                />
              )}

              <View style={{ height: 34 }} />
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
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
  heroBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: 10,
  },
  heroTagline: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 6,
  },

  sectionLabel: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 8,
    marginTop: 4,
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 10,
  },
  cardOk: { borderColor: colors.success },
  cardPending: { borderColor: colors.borderStrong, backgroundColor: colors.surfaceAlt },
  cardRejected: { borderColor: colors.danger },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  cardBody: { color: colors.textMuted, fontSize: 15, lineHeight: 21, marginTop: 4 },

  benefitList: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 14,
    gap: 12,
    marginBottom: 12,
  },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  benefitText: { color: colors.text, fontSize: 15, lineHeight: 21, flex: 1 },

  separation: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: colors.violet,
  },
  separationText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },

  notice: { borderRadius: radius.md, padding: 12, marginBottom: 12 },
  noticeInfo: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong },
  noticeError: { backgroundColor: 'rgba(255,92,124,0.12)', borderWidth: 1, borderColor: colors.danger },
  noticeText: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '500' },

  formCard: { borderColor: colors.accent, backgroundColor: colors.surfaceAlt },
  fieldLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '500', marginTop: 12, marginBottom: 6 },
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
  inputMultiline: { minHeight: 96 },
  counter: { color: colors.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginTop: 6 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
});
