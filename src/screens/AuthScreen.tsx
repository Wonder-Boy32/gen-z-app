import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
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
import Icon from '../components/ui/Icon';
import Button from '../components/Button';
import RecoveryFlow from '../components/RecoveryFlow';
import { TOP_INSET } from '../utils/useInsets';
import { friendlyError } from '../utils/friendlyError';

type Mode = 'login' | 'signup';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const GENDERS = ['Female', 'Male', 'Custom'] as const;

function days(): { label: string; value: string }[] {
  return Array.from({ length: 31 }, (_, i) => ({ label: String(i + 1), value: String(i + 1) }));
}
function months(): { label: string; value: string }[] {
  return MONTHS.map((m, i) => ({ label: m, value: String(i + 1) }));
}
function years(): { label: string; value: string }[] {
  const now = new Date().getFullYear();
  const out: { label: string; value: string }[] = [];
  for (let y = now - 13; y >= now - 80; y--) out.push({ label: String(y), value: String(y) });
  return out;
}

export default function AuthScreen({ initialMode = 'login' }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);
  const [gender, setGender] = useState<string | null>(null);
  const [customGender, setCustomGender] = useState('');
  const [picker, setPicker] = useState<'day' | 'month' | 'year' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  // Facebook-style email confirmation: the account exists but is unconfirmed, so
  // the user is held here to type the 6-digit code instead of being dropped on a
  // panel that tells them to go and read their inbox.
  const [awaitingCode, setAwaitingCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  // login attempt protection UX (real enforcement is Supabase's rate limiter)
  const [failures, setFailures] = useState(0);
  const MAX_ATTEMPTS = 5;
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 550, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 550, useNativeDriver: true }),
    ]).start();
  }, [fade, slide]);

  // Auto-resume an in-progress account recovery after the app was killed
  // (e.g. the user left to read the code email and Android restarted the app).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('genz_recovery_session');
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s?.identifier && s?.sentAt && Date.now() - s.sentAt < 10 * 60 * 1000) {
          setRecoveryOpen(true);
        }
      } catch {}
    })();
  }, []);

  // Same idea, for signup. Android kills the activity the moment the app
  // leaves the foreground, and the confirmation step is the worst place to lose
  // your place: the account already EXISTS (provisional, unconfirmed), so going
  // back to the form and resubmitting hits "email already registered". Restore
  // the pending email so the user lands back on "Check your email", not login.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('genz_signup_confirm');
        if (!raw) return;
        const s = JSON.parse(raw);
        // 24h window — generous on purpose. The OTP itself may have expired
        // within that time, but that's fine: the restored screen's "Resend
        // code" button is exactly the recovery for an expired token.
        if (s?.email && s?.sentAt && Date.now() - s.sentAt < 24 * 60 * 60 * 1000) {
          setAwaitingCode(s.email);
          setEmail(s.email);
        } else {
          AsyncStorage.removeItem('genz_signup_confirm').catch(() => {});
        }
      } catch {}
    })();
  }, []);

  const dobValue = useMemo(() => {
    if (!day || !month || !year) return null;
    const d = Number(day), m = Number(month), y = Number(year);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }, [day, month, year]);

  const isAtLeast13 = useMemo(() => {
    if (!dobValue) return false;
    const dob = new Date(`${dobValue}T00:00:00`);
    if (isNaN(dob.getTime())) return false;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 13);
    return dob <= cutoff;
  }, [dobValue]);

  const finalGender = gender === 'Custom' ? (customGender.trim() || 'Custom') : gender;

  const validateSignup = (): string | null => {
    if (!firstName.trim() || !lastName.trim()) return 'Enter your first name and surname.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter a valid email address.';
    if (password.length < 6) return 'Your password needs at least 6 characters.';
    if (!dobValue) return 'Enter your date of birth.';
    if (!isAtLeast13) return "You must be at least 13 to join Gen Z.";
    if (!gender) return 'Choose a gender — or pick Custom.';
    if (gender === 'Custom' && !customGender.trim()) return 'Tell us your gender.';
    return null;
  };

  const submit = async () => {
    setError(null);
    if (mode === 'signup') {
      const v = validateSignup();
      if (v) {
        setError(v);
        return;
      }
    } else {
      if (!email.trim() || !password) {
        setError('Enter your email and password.');
        return;
      }
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email: email.trim(), password });
        if (err) {
          // friendlyError(), never err.message: a signup failure is either a
          // network problem or a Supabase verdict, and both have a human form.
          setError(friendlyError(err, 'Could not create your account. Please try again.'));
        } else if (data.user) {
          // Facebook-style: capture profile details the moment the account exists
          const name = `${firstName.trim()} ${lastName.trim()}`.trim();
          const { error: upErr } = await supabase
            .from('profiles')
            .update({ display_name: name, dob: dobValue, gender: finalGender })
            .eq('id', data.user.id);
          if (upErr) {
            // DB without the dob/gender columns yet — save at least the name
            await supabase.from('profiles').update({ display_name: name }).eq('id', data.user.id);
          }
          // `data.session` is the deciding signal, and it is the ONLY reliable
          // one: Supabase returns a user in both cases. A session means
          // confirmation is switched off and the user is already signed in; a
          // null session means the account is provisional until the emailed
          // code is entered. Trusting a hardcoded assumption about the project's
          // email settings is what produced the dead-end panel.
          if (data.session) {
            setCreated(true);
          } else {
            const pendingEmail = data.user.email ?? email.trim();
            setAwaitingCode(pendingEmail);
            setCode('');
            setError(null);
            // Persist across an Android kill. This is the moment the account
            // becomes provisional — losing this screen strands the user.
            AsyncStorage.setItem(
              'genz_signup_confirm',
              JSON.stringify({ email: pendingEmail, sentAt: Date.now() })
            ).catch(() => {});
          }
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) {
          setFailures((f) => f + 1);
          if (failures + 1 >= MAX_ATTEMPTS) {
            setError('For your security, we\'ve temporarily limited login attempts. Try again in a few minutes, or reset your password.');
          } else {
            // The attempt counter is ours and worth keeping, but it used to be
            // bolted onto the RAW error — which is how "java.net.UnknownHostException:
            // Unable to resolve host ... You have 4 attempts remaining." reached a
            // user who was simply offline. Only the message half is translated.
            setError(
              `${friendlyError(err, 'Could not log you in. Please try again.')} You have ${MAX_ATTEMPTS - failures - 1} attempt${MAX_ATTEMPTS - failures - 1 === 1 ? '' : 's'} remaining.`
            );
          }
        } else {
          setFailures(0);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  // Resend pacing. Local only — Supabase's own email rate limiter is the real
  // ceiling; this just stops the button being mashed and the user burning
  // through their allowance without noticing.
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const verifyCode = async () => {
    if (!awaitingCode) return;
    setError(null);
    setVerifyBusy(true);
    try {
      // type 'signup' is the email-confirmation token. Same primitive the
      // AccountSecurity email-change flow already uses, so this is a proven
      // path in this app rather than a new mechanism.
      const { error: err } = await supabase.auth.verifyOtp({
        email: awaitingCode,
        token: code.trim(),
        type: 'signup',
      });
      if (err) throw err;
      // Done: the account is confirmed, so there is nothing left to resume.
      AsyncStorage.removeItem('genz_signup_confirm').catch(() => {});
      // Success mints the session, so the root navigator moves the user on by
      // itself — there is nothing to navigate manually here.
    } catch (e: any) {
      setError(friendlyError(e, 'That code did not work. Check it and try again.'));
    } finally {
      setVerifyBusy(false);
    }
  };

  const resendCode = async () => {
    if (!awaitingCode || resendIn > 0) return;
    setError(null);
    try {
      const { error: err } = await supabase.auth.resend({
        type: 'signup',
        email: awaitingCode,
      });
      if (err) throw err;
      setResendIn(45);
    } catch (e: any) {
      setError(friendlyError(e, 'Could not resend the code. Try again shortly.'));
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Animated.View style={[styles.inner, { opacity: fade, transform: [{ translateY: slide }] }]}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandRow}>
            <View style={styles.logoMark}>
              <Image source={require('../../assets/icon-navy.png')} style={styles.logoImage} />
            </View>
            <Text style={styles.wordmark}>GEN Z</Text>
          </View>

          {awaitingCode ? (
            <>
              <Text style={styles.heading}>Check your email</Text>
              <Text style={styles.headingSub}>
                We sent a 6-digit code to {awaitingCode}. Enter it to finish creating your account.
              </Text>

              <View style={styles.formCard}>
                <TextInput
                  style={[
                    styles.input,
                    { fontSize: 26, letterSpacing: 10, textAlign: 'center', fontWeight: '700' },
                  ]}
                  placeholder="······"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  value={code}
                  // Digits only. A paste or a non-latin keyboard must never put
                  // characters in the field that the server then rejects as a
                  // malformed token, which reads to the user as "wrong code".
                  onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ''))}
                  autoFocus
                />

                {!!error && <Text style={styles.error}>{error}</Text>}

                <Button
                  title="Confirm"
                  onPress={() => void verifyCode()}
                  loading={verifyBusy}
                  disabled={code.length < 6}
                />

                <Pressable
                  onPress={() => void resendCode()}
                  disabled={resendIn > 0}
                  style={{ alignItems: 'center', paddingVertical: 14 }}
                >
                  <Text
                    style={{
                      color: resendIn > 0 ? colors.textMuted : colors.accent,
                      fontSize: 14,
                      fontWeight: '600',
                    }}
                  >
                    {resendIn > 0 ? `Resend code in ${resendIn}s` : "Didn't get it? Resend code"}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    setAwaitingCode(null);
                    setCode('');
                    setError(null);
                    AsyncStorage.removeItem('genz_signup_confirm').catch(() => {});
                  }}
                  style={{ alignItems: 'center' }}
                >
                  <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                    Wrong address? Change email
                  </Text>
                </Pressable>
              </View>
            </>
          ) : created ? (
            <View style={styles.createdBox}>
              {/* Only reached when email confirmation is OFF — in that case the
                  session is already live and the root navigator is about to
                  move the user on, so this states the transition instead of
                  asking them to go and check an inbox. */}
              <Text style={styles.createdTitle}>Account created</Text>
              <Text style={styles.createdText}>Taking you to set up your profile…</Text>
            </View>
          ) : mode === 'signup' ? (
            <>
              <Text style={styles.heading}>Create a new account</Text>
              <Text style={styles.headingSub}>It's quick and easy.</Text>

              <View style={styles.formCard}>
                <View style={styles.nameRow}>
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="First name"
                    placeholderTextColor={colors.textFaint}
                    autoCorrect={false}
                    value={firstName}
                    onChangeText={setFirstName}
                  />
                  <TextInput
                    style={[styles.input, styles.halfInput]}
                    placeholder="Surname"
                    placeholderTextColor={colors.textFaint}
                    autoCorrect={false}
                    value={lastName}
                    onChangeText={setLastName}
                  />
                </View>

                <TextInput
                  style={styles.input}
                  placeholder="Email address"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoCorrect={false}
                  value={email}
                  onChangeText={setEmail}
                />

                <View style={styles.passwordRow}>
                  <TextInput
                    style={styles.passwordInput}
                    placeholder="New password"
                    placeholderTextColor={colors.textFaint}
                    secureTextEntry={!showPassword}
                    value={password}
                    onChangeText={setPassword}
                  />
                  <Pressable
                    style={styles.eyeBtn}
                    onPress={() => setShowPassword((s) => !s)}
                    hitSlop={10}
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon
                      name={showPassword ? 'eye-outline' : 'eye-off-outline'}
                      size={20}
                      color={showPassword ? colors.accent : colors.textMuted}
                    />
                  </Pressable>
                </View>

                <Text style={styles.fieldLabel}>Date of birth</Text>
                <View style={styles.dobRow}>
                  {(
                    [
                      { key: 'day' as const, value: day, ph: 'Day', opts: days() },
                      { key: 'month' as const, value: month, ph: 'Month', opts: months() },
                      { key: 'year' as const, value: year, ph: 'Year', opts: years() },
                    ]
                  ).map((f) => (
                    <Pressable
                      key={f.key}
                      style={[styles.selectBox, !!f.value && styles.selectBoxFilled]}
                      onPress={() => setPicker(f.key)}
                    >
                      <Text style={[styles.selectText, !f.value && styles.selectTextEmpty]}>
                        {f.value
                          ? f.key === 'month'
                            ? MONTHS[Number(f.value) - 1]
                            : f.value
                          : f.ph}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>Gender</Text>
                <View style={styles.genderRow}>
                  {GENDERS.map((g) => (
                    <Pressable
                      key={g}
                      style={[styles.genderChip, gender === g && styles.genderChipActive]}
                      onPress={() => setGender(g)}
                    >
                      <Text style={[styles.genderText, gender === g && styles.genderTextActive]}>
                        {g}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {gender === 'Custom' && (
                  <TextInput
                    style={[styles.input, { marginTop: 10 }]}
                    placeholder="Your gender (optional)"
                    placeholderTextColor={colors.textFaint}
                    maxLength={20}
                    value={customGender}
                    onChangeText={setCustomGender}
                  />
                )}

                <Text style={styles.terms}>
                  By clicking Create account, you agree to our Terms, and confirm you're at least 13.
                </Text>

                {!!error && <Text style={styles.error}>{error}</Text>}

                <Button
                  title="Create account"
                  onPress={submit}
                  disabled={!firstName.trim() || !lastName.trim() || !email.trim() || !password || !dobValue || !gender}
                  loading={loading}
                  style={{ marginTop: 4 }}
                />
              </View>

              <Pressable style={styles.switchRow} onPress={() => switchMode('login')} hitSlop={8}>
                <Text style={styles.switchText}>Already have an account? Log in</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.heading}>Welcome back</Text>
              <Text style={styles.headingSub}>Log in to see what's happening right now.</Text>

              <View style={styles.formCard}>
                <TextInput
                  style={styles.input}
                  placeholder="Email address"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoCorrect={false}
                  value={email}
                  onChangeText={setEmail}
                />
                <View style={styles.passwordRow}>
                  <TextInput
                    style={styles.passwordInput}
                    placeholder="Password"
                    placeholderTextColor={colors.textFaint}
                    secureTextEntry={!showPassword}
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={submit}
                  />
                  <Pressable
                    style={styles.eyeBtn}
                    onPress={() => setShowPassword((s) => !s)}
                    hitSlop={10}
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  >
                    <Icon
                      name={showPassword ? 'eye-outline' : 'eye-off-outline'}
                      size={20}
                      color={showPassword ? colors.accent : colors.textMuted}
                    />
                  </Pressable>
                </View>

                {!!error && <Text style={styles.error}>{error}</Text>}

                <Button
                  title="Log in"
                  onPress={submit}
                  disabled={!email.trim() || !password}
                  loading={loading}
                  style={{ marginTop: 4 }}
                />
              </View>

              <Pressable style={styles.forgotRow} onPress={() => setRecoveryOpen(true)} hitSlop={8}>
                <Text style={styles.forgotText}>Forgot password?</Text>
              </Pressable>

              <Pressable style={styles.switchRow} onPress={() => switchMode('signup')} hitSlop={8}>
                <Text style={styles.switchText}>New to Gen Z? Create account</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </Animated.View>

      <RecoveryFlow visible={recoveryOpen} onClose={() => setRecoveryOpen(false)} />

      <OptionSheet
        visible={picker === 'day'}
        title="Day"
        options={days()}
        value={day}
        onSelect={setDay}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        visible={picker === 'month'}
        title="Month"
        options={months()}
        value={month}
        onSelect={setMonth}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        visible={picker === 'year'}
        title="Year"
        options={years()}
        value={year}
        onSelect={setYear}
        onClose={() => setPicker(null)}
      />
    </KeyboardAvoidingView>
  );
}

function OptionSheet({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { label: string; value: string }[];
  value: string | null;
  onSelect: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetOverlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
            {options.map((o) => {
              const active = o.value === value;
              return (
                <Pressable
                  key={o.value}
                  style={[styles.sheetRow, active && styles.sheetRowActive]}
                  onPress={() => {
                    onSelect(o.value);
                    onClose();
                  }}
                >
                  <Text style={[styles.sheetRowText, active && styles.sheetRowTextActive]}>
                    {o.label}
                  </Text>
                  {active && <Icon name="checkmark" size={16} color={colors.accent} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  inner: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: TOP_INSET + 24,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 26,
  },
  logoMark: {
    width: 46,
    height: 46,
    borderRadius: 13,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: {
    width: 40,
    height: 40,
    borderRadius: 10,
  },
  wordmark: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 4,
  },
  heading: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
  },
  headingSub: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 22,
  },
  formCard: {
    backgroundColor: colors.glass,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 20,
  },
  nameRow: {
    flexDirection: 'row',
    gap: 10,
  },
  halfInput: {
    flex: 1,
  },
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
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
  },
  eyeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 2,
  },
  dobRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  selectBox: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  selectBoxFilled: {
    borderColor: colors.accent,
  },
  selectText: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '600',
  },
  selectTextEmpty: {
    color: colors.textFaint,
    fontWeight: '400',
  },
  genderRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  genderChip: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  genderChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(255,122,0,0.10)',
  },
  genderText: {
    color: colors.textMuted,
    fontSize: 13.5,
    fontWeight: '600',
  },
  genderTextActive: {
    color: colors.accent,
  },
  terms: {
    color: colors.textFaint,
    fontSize: 11.5,
    lineHeight: 16,
    marginBottom: 12,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginBottom: 10,
  },
  forgotRow: {
    alignItems: 'center',
    marginTop: 14,
    paddingVertical: 6,
  },
  forgotText: {
    color: colors.textMuted,
    fontSize: 13.5,
    fontWeight: '600',
  },
  switchRow: {
    alignItems: 'center',
    marginTop: 20,
    paddingVertical: 8,
  },
  switchText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  createdBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 20,
    marginTop: 30,
  },
  createdTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
  },
  createdText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5,8,16,0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 34,
    ...shadows.glow,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 8,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  sheetRowActive: {
    backgroundColor: 'rgba(255,122,0,0.08)',
  },
  sheetRowText: {
    color: colors.text,
    fontSize: 14.5,
  },
  sheetRowTextActive: {
    color: colors.accent,
    fontWeight: '700',
  },
});
