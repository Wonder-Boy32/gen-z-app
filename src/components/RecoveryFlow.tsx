import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors, radius, shadows } from '../theme';
import Icon from './ui/Icon';
import Avatar from './Avatar';

// ============================================================
// GEN Z — ACCOUNT RECOVERY (Forgot password)
// find → confirm → method → OTP/code → new password → done
// All verification is server-side; emails/phones stay masked.
// Design: midnight navy + electric orange, step progress,
// 6-box OTP entry, glass cards with glow.
// ============================================================

type Step = 'find' | 'confirm' | 'method' | 'otp' | 'newpw' | 'done';

type FindResult = {
  found: boolean;
  locked?: boolean;
  deactivated?: boolean;
  user_id?: string;
  username?: string;
  display_name?: string | null;
  avatar_url?: string | null;
  masked_email?: string | null;
  masked_phone?: string | null;
  methods?: string[];
};

const STEP_INDEX: Record<Step, number> = { find: 0, confirm: 1, method: 2, otp: 3, newpw: 4, done: 5 };
const OTP_LEN = 6;

const COMMON = ['password', '123456', 'password1', '12345678', 'qwerty', 'abc123', 'genz', 'genz123', 'admin', 'wonderboy', 'letmein', 'iloveyou', '111111', '000000'];
const RESEND_SECONDS = 60;
const SESSION_KEY = 'genz_recovery_session';
const SESSION_TTL_MS = 10 * 60 * 1000;

function strength(s: string): { score: 0 | 1 | 2 | 3; label: string; color: string } {
  if (!s) return { score: 0, label: '', color: colors.textFaint };
  let sc = 0;
  if (s.length >= 8) sc++;
  if (s.length >= 12) sc++;
  if (/[A-Z]/.test(s) && /[a-z]/.test(s)) sc++;
  if (/\d/.test(s)) sc++;
  if (/[^A-Za-z0-9]/.test(s)) sc++;
  sc = Math.min(3, Math.floor(sc / 2));
  const labels = ['Weak', 'Fair', 'Strong', 'Very strong'];
  const cols = [colors.danger, colors.yellow, colors.accent, '#34D399'];
  return { score: sc as 0 | 1 | 2 | 3, label: labels[sc], color: cols[sc] };
}

export default function RecoveryFlow({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>('find');
  const [identifier, setIdentifier] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const [method, setMethod] = useState('email');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const otpRefs = useRef<Array<TextInput | null>>([]);
  const tokensRef = useRef<{ access_token?: string; refresh_token?: string; via: string } | null>(null);

  useEffect(() => {
    if (!visible) {
      setStep('find'); setIdentifier(''); setResult(null); setCode(''); setNewPassword('');
      setConfirmPassword(''); setError(null); setCooldown(0);
      if (timer.current) clearInterval(timer.current);
      clearSession();
    }
  }, [visible]);

  useEffect(() => {
    if (cooldown > 0) {
      timer.current = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
      return () => { if (timer.current) clearInterval(timer.current); };
    }
  }, [cooldown > 0]);

  // focus the first OTP box when the code screen opens (email/phone only)
  useEffect(() => {
    if (step === 'otp' && method !== 'codes') {
      const t = setTimeout(() => otpRefs.current[0]?.focus(), 380);
      return () => clearTimeout(t);
    }
  }, [step, method]);

  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    const { data, error: err } = await supabase.rpc(fn, args);
    if (err) throw new Error(err.message);
    return data as any;
  };

  const setSessionTokens = (r: any) => {
    tokensRef.current = {
      access_token: r.access_token, refresh_token: r.refresh_token, via: r.via ?? method,
    };
  };

  const saveSession = async (s: { identifier: string; method: string; masked: string | null; sentAt: number }) => {
    try { await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  };
  const clearSession = async () => {
    try { await AsyncStorage.removeItem(SESSION_KEY); } catch {}
  };

  // Resume a pending recovery if the app was killed mid-flow (e.g. the user left
  // to read the code email, Android killed the app, and it restarted).
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const s = JSON.parse(raw) as { identifier?: string; method?: string; masked?: string | null; sentAt?: number };
        if (!s.identifier || !s.sentAt || Date.now() - s.sentAt > SESSION_TTL_MS) {
          await clearSession();
          return;
        }
        const m = s.method === 'phone' || s.method === 'codes' ? s.method : 'email';
        setIdentifier(s.identifier);
        setMethod(m);
        setResult({
          found: true,
          methods: [m],
          masked_email: m === 'email' ? (s.masked ?? null) : null,
          masked_phone: m === 'phone' ? (s.masked ?? null) : null,
        } as FindResult);
        setStep('otp');
        setCode('');
      } catch {}
    })();
  }, [visible]);

  const findAccount = async () => {
    setError(null);
    if (identifier.trim().length < 3) { setError('Enter your email, phone or username.'); return; }
    setBusy(true);
    try {
      const r = await rpc('recover_find_account', { p_identifier: identifier.trim() });
      if (!r.found) {
        setError(r.locked ? 'Too many attempts. Try again in 15 minutes.' : 'If an account matches the information provided, we\'ll show you the available recovery options.');
        return;
      }
      if (r.deactivated) { setError('This account is deactivated. Log in to reactivate it.'); return; }
      setResult(r);
      setStep('confirm');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pickMethod = async (m: string) => {
    setMethod(m);
    setCode('');
    if (m === 'codes') {
      setStep('otp');
      saveSession({ identifier: identifier.trim(), method: m, masked: null, sentAt: Date.now() });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await rpc('recover_send_code', { p_identifier: identifier.trim(), p_method: m });
      if (!r.ok) {
        setError(r.error ?? 'Could not send the code.');
        if (r.cooldown) setCooldown(r.retry_after ?? RESEND_SECONDS);
        return;
      }
      setCooldown(RESEND_SECONDS);
      setStep('otp');
      saveSession({ identifier: identifier.trim(), method: m, masked: (r as any)?.masked ?? null, sentAt: Date.now() });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setError(null);
    if (code.trim().length < 4) { setError('Enter the code you received.'); return; }
    setBusy(true);
    try {
      const r = await rpc('recover_verify_and_reset', {
        p_identifier: identifier.trim(), p_method: method, p_code: code.trim(),
      });
      if (!r.ok) { setError(r.error ?? 'Invalid code.'); return; }
      clearSession();
      setStep('newpw');
      setSessionTokens(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setError(null);
    const st = strength(newPassword);
    if (newPassword.length < 8) { setError('Your new password needs at least 8 characters.'); return; }
    if (st.score < 1) { setError('That password is too weak — mix letters, numbers and symbols.'); return; }
    if (COMMON.includes(newPassword.toLowerCase())) { setError('That password is too common. Choose something unique.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords don\'t match.'); return; }
    setBusy(true);
    try {
      const t = tokensRef.current;
      if (t?.via === 'codes') {
        await rpc('security_log', { p_event: 'password_changed', p_meta: { via: 'recovery_code' } });
      } else if (t?.access_token && t.refresh_token) {
        await supabase.auth.setSession({ access_token: t.access_token, refresh_token: t.refresh_token });
        const { error: upErr } = await supabase.auth.updateUser({ password: newPassword });
        if (upErr) throw upErr;
        await rpc('auth_invalidate_sessions').catch(() => {});
        await rpc('security_log', { p_event: 'password_changed', p_meta: { via: 'recovery' } }).catch(() => {});
        await supabase.auth.signOut().catch(() => {});
      } else {
        setError('Verification session expired. Start over.');
        setStep('find');
        return;
      }
      setStep('done');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    tokensRef.current = null;
    onClose();
  };

  const handleOtpChange = (i: number, t: string) => {
    const digit = t.replace(/\D/g, '').slice(-1);
    const arr = code.split('');
    arr[i] = digit;
    setCode(arr.join('').slice(0, OTP_LEN));
    if (digit && i < OTP_LEN - 1) otpRefs.current[i + 1]?.focus();
  };

  const handleOtpKey = (i: number, key: string) => {
    if (key === 'Backspace' && !code[i] && i > 0) otpRefs.current[i - 1]?.focus();
  };

  const progress = STEP_INDEX[step];
  const isOtpBoxes = step === 'otp' && method !== 'codes';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* ambient glows */}
        <View pointerEvents="none" style={styles.orbOrange} />
        <View pointerEvents="none" style={styles.orbViolet} />

        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Icon name="close" size={22} color={colors.textMuted} />
          </Pressable>
          <View style={styles.brand}>
            <Text style={styles.brandMark}>GENZ</Text>
            <Text style={styles.brandSub}>Account recovery</Text>
          </View>
          <View style={styles.closeBtn} />
        </View>

        {/* step progress */}
        <View style={styles.progressRow}>
          {[0, 1, 2, 3, 4].map((i) => (
            <View
              key={i}
              style={[
                styles.progressDot,
                i < progress ? styles.progressDone : i === progress ? styles.progressActive : styles.progressTodo,
              ]}
            />
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {step === 'find' && (
            <StepCard title="Find your account" sub="Enter your email, phone number or username.">
              <TextInput
                style={styles.input}
                placeholder="Email, phone or @username"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                value={identifier}
                onChangeText={setIdentifier}
                onSubmitEditing={findAccount}
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button label="Continue" onPress={findAccount} busy={busy} />
            </StepCard>
          )}

          {step === 'confirm' && result?.found && (
            <StepCard title="We found your account" sub="Is this you?">
              <View style={styles.confirmRow}>
                <Avatar url={result.avatar_url ?? null} name={result.username ?? '?'} size={72} />
                <View style={styles.confirmInfo}>
                  <Text style={styles.confirmName}>{result.display_name || '@' + (result.username ?? '')}</Text>
                  <Text style={styles.confirmUser}>@{result.username}</Text>
                </View>
              </View>
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button label="Yes, continue" onPress={() => setStep('method')} />
              <Pressable style={styles.linkBtn} onPress={() => setStep('find')}>
                <Text style={styles.linkText}>This isn't me</Text>
              </Pressable>
            </StepCard>
          )}

          {step === 'method' && (
            <StepCard title="How do you want to receive your code?" sub="Choose a verified method.">
              {(result?.methods ?? []).map((m) => (
                <Pressable key={m} style={styles.methodRow} onPress={() => pickMethod(m)}>
                  <View style={styles.methodChip}>
                    <Icon name={m === 'email' ? 'mail-outline' : m === 'phone' ? 'phone-portrait-outline' : 'key-outline'} size={18} color={colors.accent} />
                  </View>
                  <View style={styles.methodInfo}>
                    <Text style={styles.methodTitle}>
                      {m === 'email' ? 'Email' : m === 'phone' ? 'Phone' : 'Recovery code'}
                    </Text>
                    <Text style={styles.methodSub}>
                      {m === 'email' ? (result?.masked_email ?? '') : m === 'phone' ? (result?.masked_phone ?? '') : 'Use one of your saved codes'}
                    </Text>
                  </View>
                  <Icon name="chevron-forward" size={16} color={colors.textFaint} />
                </Pressable>
              ))}
              {!!error && <Text style={styles.error}>{error}</Text>}
            </StepCard>
          )}

          {step === 'otp' && (
            <StepCard
              title={method === 'codes' ? 'Enter a recovery code' : 'Enter the 6-digit code'}
              sub={method === 'codes' ? 'Format: XXXXX-XXXXX' : `We sent a 6-digit code to ${method === 'phone' ? (result?.masked_phone ?? 'your phone') : (result?.masked_email ?? 'your email')}`}
            >
              {isOtpBoxes ? (
                <View style={styles.otpRow}>
                  {Array.from({ length: OTP_LEN }).map((_, i) => (
                    <TextInput
                      key={i}
                      ref={(el) => { otpRefs.current[i] = el; }}
                      style={[styles.otpBox, !!code[i] && styles.otpBoxFilled]}
                      value={code[i] ?? ''}
                      onChangeText={(t) => handleOtpChange(i, t)}
                      onKeyPress={(e) => handleOtpKey(i, e.nativeEvent.key)}
                      keyboardType="number-pad"
                      maxLength={1}
                      selectTextOnFocus
                      placeholder="•"
                      placeholderTextColor={colors.textFaint}
                    />
                  ))}
                </View>
              ) : (
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  placeholder="XXXXX-XXXXX"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  keyboardType="default"
                  maxLength={11}
                  value={code}
                  onChangeText={setCode}
                  onSubmitEditing={verifyCode}
                />
              )}
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button label="Verify code" onPress={verifyCode} busy={busy} />
              {method !== 'codes' && (
                <Pressable
                  style={styles.linkBtn}
                  disabled={cooldown > 0 || busy}
                  onPress={() => pickMethod(method)}
                >
                  <Text style={[styles.linkText, cooldown > 0 && { color: colors.textFaint }]}>
                    {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Didn\'t get the code? Resend'}
                  </Text>
                </Pressable>
              )}
              <Pressable style={styles.linkBtn} onPress={() => setStep('method')}>
                <Text style={styles.linkText}>Try another way</Text>
              </Pressable>
            </StepCard>
          )}

          {step === 'newpw' && (
            <StepCard title="Create a new password" sub="Make it strong — at least 8 characters.">
              <TextInput
                style={styles.input}
                placeholder="New password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                value={newPassword}
                onChangeText={setNewPassword}
              />
              <TextInput
                style={styles.input}
                placeholder="Confirm password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                value={confirmPassword}
                onChangeText={setConfirmPassword}
              />
              {newPassword.length > 0 && (
                <View style={styles.strengthRow}>
                  {[0, 1, 2, 3].map((i) => (
                    <View key={i} style={[styles.strengthBar, { backgroundColor: i <= strength(newPassword).score ? strength(newPassword).color : colors.border }]} />
                  ))}
                  <Text style={[styles.strengthLabel, { color: strength(newPassword).color }]}>{strength(newPassword).label}</Text>
                </View>
              )}
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button label="Change password" onPress={changePassword} busy={busy} />
            </StepCard>
          )}

          {step === 'done' && (
            <View style={styles.doneWrap}>
              <View style={styles.doneCircle}>
                <Icon name="checkmark" size={42} color={colors.success} />
              </View>
              <Text style={styles.doneTitle}>Password changed</Text>
              <Text style={styles.doneSub}>Your password has been updated. Stolen sessions were revoked.</Text>
              <Button label="Log in" onPress={finish} />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function StepCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {!!sub && <Text style={styles.cardSub}>{sub}</Text>}
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

function Button({ label, onPress, busy }: { label: string; onPress: () => void; busy?: boolean }) {
  return (
    <Pressable style={[styles.btn, busy && { opacity: 0.6 }]} onPress={onPress} disabled={busy}>
      {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.btnText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDeep, overflow: 'hidden' },

  // ambient glows
  orbOrange: {
    position: 'absolute', top: -110, right: -100, width: 280, height: 280,
    borderRadius: 999, backgroundColor: 'rgba(255,157,31,0.07)',
  },
  orbViolet: {
    position: 'absolute', bottom: -140, left: -120, width: 320, height: 320,
    borderRadius: 999, backgroundColor: 'rgba(139,123,255,0.06)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 18, paddingHorizontal: 16, paddingBottom: 6,
  },
  closeBtn: { width: 40, alignItems: 'center' },
  brand: { alignItems: 'center' },
  brandMark: { color: colors.accent, fontSize: 19, fontWeight: '900', letterSpacing: 4 },
  brandSub: {
    color: colors.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 2.2,
    marginTop: 2, textTransform: 'uppercase',
  },

  progressRow: { flexDirection: 'row', justifyContent: 'center', gap: 7, marginTop: 10, marginBottom: 6 },
  progressDot: { width: 6, height: 6, borderRadius: 3 },
  progressTodo: { backgroundColor: colors.borderStrong },
  progressActive: { backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  progressDone: { backgroundColor: colors.success },

  content: { padding: 20, paddingBottom: 60, paddingTop: 14 },

  card: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.lg,
    padding: 22,
    ...shadows.glow,
  },
  cardTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.2 },
  cardSub: { color: colors.textMuted, fontSize: 13.5, marginTop: 6, lineHeight: 20 },
  cardBody: { marginTop: 20 },

  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  codeInput: { textAlign: 'center', fontSize: 20, letterSpacing: 6, fontWeight: '700' },

  otpRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  otpBox: {
    width: 46, height: 54, borderRadius: 14,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1, borderColor: colors.borderStrong,
    color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center',
  },
  otpBoxFilled: {
    borderColor: colors.accent,
    shadowColor: colors.accent, shadowOpacity: 0.35, shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 }, elevation: 3,
  },

  error: { color: colors.danger, fontSize: 13, marginBottom: 12, lineHeight: 18 },

  btn: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
    ...shadows.glow,
  },
  btnText: { color: colors.bg, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },

  linkBtn: { alignItems: 'center', marginTop: 16, paddingVertical: 6 },
  linkText: { color: colors.accent, fontSize: 14, fontWeight: '600' },

  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  confirmInfo: { flex: 1 },
  confirmName: { color: colors.text, fontSize: 18, fontWeight: '800' },
  confirmUser: { color: colors.textMuted, fontSize: 13, marginTop: 2 },

  methodRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 16, padding: 14, marginBottom: 10, gap: 12,
  },
  methodChip: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center',
  },
  methodInfo: { flex: 1 },
  methodTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  methodSub: { color: colors.textMuted, fontSize: 12.5, marginTop: 1 },

  strengthRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 12 },
  strengthBar: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '700', marginLeft: 6, width: 80 },

  doneWrap: { alignItems: 'center', paddingTop: 44, paddingHorizontal: 8 },
  doneCircle: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: 'rgba(52,211,153,0.10)',
    borderWidth: 1, borderColor: 'rgba(52,211,153,0.35)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  doneTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.3 },
  doneSub: {
    color: colors.textMuted, fontSize: 13.5, lineHeight: 20,
    textAlign: 'center', marginTop: 8, marginBottom: 26,
  },
});
