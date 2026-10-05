import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { supabase } from '../../supabase/client';
import { markDeliberateSignOut } from '../../utils/sessionGuard';
import { colors, radius, shadows } from '../../theme';
import Icon, { IconName } from '../ui/Icon';
import { TOP_INSET } from '../../utils/useInsets';
import { friendlyError } from '../../utils/friendlyError';

// ============================================================
// GEN Z — account security suite (Settings → Security/Account)
// All changes go through Supabase Auth + server-side RPCs.
// ============================================================

const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as any;
};

function ScreenShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.shell}>
        <View style={styles.shellHeader}>
          <Pressable onPress={onClose} style={styles.shellBack} hitSlop={8}>
            <Text style={styles.shellBackText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.shellTitle}>{title}</Text>
          <View style={styles.shellBack} />
        </View>
        <ScrollView contentContainerStyle={styles.shellContent} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

function BigBtn({ label, onPress, tone = 'accent', busy }: { label: string; onPress: () => void; tone?: 'accent' | 'danger' | 'ghost'; busy?: boolean }) {
  return (
    <Pressable
      style={[styles.bigBtn, tone === 'danger' && styles.bigBtnDanger, tone === 'ghost' && styles.bigBtnGhost, busy && { opacity: 0.6 }]}
      onPress={onPress}
      disabled={busy}
    >
      {busy ? <ActivityIndicator color={tone === 'ghost' ? colors.accent : colors.bg} /> : <Text style={[styles.bigBtnText, tone === 'ghost' && { color: colors.accent }]}>{label}</Text>}
    </Pressable>
  );
}

function InfoCard({ icon, title, sub }: { icon: IconName; title: string; sub: string }) {
  return (
    <View style={styles.infoCard}>
      <Icon name={icon} size={20} color={colors.accent} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.infoTitle}>{title}</Text>
        <Text style={styles.infoSub}>{sub}</Text>
      </View>
    </View>
  );
}

// ---------------- 2FA ----------------
export function TwoFactorScreen({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<{ mfa_enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = async () => {
    try {
      setStatus(await rpc('account_security_status'));
    } catch {}
  };
  useEffect(() => {
    load();
  }, []);

  const enroll = async () => {
    setBusy(true); setError(null);
    try {
      const { data, error: e } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (e) throw e;
      setFactorId(data.id);
      const secret = data.totp.secret;
      const uri = data.totp.uri ?? `otpauth://totp/GEN%20Z:${secret}?secret=${secret}&issuer=GEN%20Z`;
      setQrUri(uri);
      setEnrolling(true);
    } catch (e: any) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyEnroll = async () => {
    if (!factorId || code.trim().length !== 6) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true); setError(null);
    try {
      const ch = await supabase.auth.mfa.challenge({ factorId });
      if (ch.error) throw ch.error;
      const v = await supabase.auth.mfa.verify({ factorId, challengeId: ch.data.id, code: code.trim() });
      if (v.error) throw v.error;
      const gen = await rpc('recovery_codes_generate');
      setCodes(gen.codes ?? []);
      await rpc('security_log', { p_event: 'two_factor_enabled', p_meta: { method: 'authenticator' } }).catch(() => {});
      setEnrolling(false);
      setStatus({ mfa_enabled: true });
      setQrUri(null); setFactorId(null); setCode('');
    } catch (e: any) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    Alert.alert('Turn off 2FA?', 'Your account will only be protected by your password.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const { data } = await supabase.auth.mfa.listFactors();
            for (const f of data?.all ?? []) await supabase.auth.mfa.unenroll({ factorId: f.id });
            await rpc('security_log', { p_event: 'two_factor_disabled' }).catch(() => {});
            setStatus({ mfa_enabled: false });
          } catch (e: any) {
            setError(friendlyError(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <ScreenShell title="Two-factor authentication" onClose={onClose}>
      <InfoCard
        icon={status?.mfa_enabled ? 'shield-checkmark-outline' : 'shield-outline'}
        title={status?.mfa_enabled ? 'Two-factor authentication is ON' : 'Two-factor authentication is OFF'}
        sub="Add a second step to log in — your password plus a code from your authenticator app."
      />
      {!!error && <Text style={styles.error}>{error}</Text>}

      {!status?.mfa_enabled && !enrolling && (
        <BigBtn label="Turn on" onPress={enroll} busy={busy} />
      )}

      {enrolling && qrUri && (
        <View style={styles.qrWrap}>
          <Text style={styles.cardTitle}>Scan with your authenticator app</Text>
          <View style={styles.qrBox}>
            <QRCode value={qrUri} size={190} backgroundColor="#ffffff" color="#0d1426" />
          </View>
          <Text style={styles.infoSub}>Then enter the 6-digit code below.</Text>
          <TextInput
            style={styles.input}
            placeholder="6-digit code"
            placeholderTextColor={colors.textFaint}
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
          <BigBtn label="Verify & enable" onPress={verifyEnroll} busy={busy} />
        </View>
      )}

      {status?.mfa_enabled && (
        <>
          {codes && (
            <View style={styles.codesBox}>
              <Text style={styles.cardTitle}>SAVE YOUR RECOVERY CODES</Text>
              <Text style={styles.infoSub}>Each code works once. Store them somewhere safe — they can get you back in if you lose your authenticator device.</Text>
              {codes.map((c) => (
                <Text key={c} style={styles.codeRow}>{c}</Text>
              ))}
              <BigBtn
                label="Copy all"
                tone="ghost"
                onPress={() => {
                  Clipboard.setStringAsync(codes.join('\n'));
                  Alert.alert('Copied', 'Recovery codes copied to clipboard.');
                }}
              />
            </View>
          )}
          <BigBtn label="Turn off 2FA" tone="danger" onPress={disable} busy={busy} />
        </>
      )}
    </ScreenShell>
  );
}

// ---------------- Where you're logged in ----------------
export function SessionsScreen({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setSessions(await rpc('user_sessions_list')); } catch {}
  };
  useEffect(() => { load(); }, []);

  const logoutAll = () => {
    Alert.alert(
      'Log out of all devices?',
      'This signs you out everywhere, including this device. You\'ll need to log back in here.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out all',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await rpc('auth_invalidate_sessions');
              markDeliberateSignOut(); // the user asked for this: never auto-restore
              await supabase.auth.signOut();
            } catch {} finally { setBusy(false); }
          },
        },
      ]
    );
  };

  return (
    <ScreenShell title="Where you're logged in" onClose={onClose}>
      {sessions === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : sessions.length === 0 ? (
        <Text style={styles.infoSub}>No recorded sessions yet.</Text>
      ) : (
        sessions.map((s) => (
          <View key={s.id} style={styles.sessionRow}>
            <View style={styles.sessionIcon}>
              <Icon name="phone-portrait-outline" size={18} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sessionDevice}>{s.device ?? 'Device'}</Text>
              <Text style={styles.sessionMeta}>
                {s.app ?? 'Gen Z app'} · last active{' '}
                {s.last_active
                  ? new Date(s.last_active).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : 'recently'}
              </Text>
            </View>
          </View>
        ))
      )}
      {sessions !== null && sessions.length > 0 && (
        <BigBtn label="Log out of all devices" tone="danger" onPress={logoutAll} busy={busy} />
      )}
    </ScreenShell>
  );
}

// ---------------- Security alerts ----------------
const EVENT_ICONS: Record<string, IconName> = {
  password_changed: 'key-outline',
  password_reset: 'key-outline',
  email_changed: 'mail-outline',
  new_login: 'phone-portrait-outline',
  two_factor_enabled: 'shield-checkmark-outline',
  two_factor_disabled: 'shield-outline',
  recovery_codes_generated: 'grid-outline',
  account_deactivated: 'pause-circle-outline',
  account_reactivated: 'play-circle-outline',
  account_deletion_requested: 'trash-outline',
};
export function SecurityAlertsScreen({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<any[] | null>(null);
  const load = async () => {
    try { setEvents(await rpc('security_events_list', { p_limit: 60 })); } catch {}
  };
  useEffect(() => { load(); }, []);

  const label = (e: string) =>
    e.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <ScreenShell title="Security alerts" onClose={onClose}>
      {events === null ? (
        <ActivityIndicator color={colors.accent} />
      ) : events.length === 0 ? (
        <Text style={styles.infoSub}>No security events yet. Changes to your password, email, 2FA and new logins will show up here.</Text>
      ) : (
        events.map((ev) => (
          <View key={ev.id} style={styles.eventRow}>
            <View style={styles.eventIcon}>
              <Icon name={EVENT_ICONS[ev.event] ?? 'shield-outline'} size={17} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sessionDevice}>{label(ev.event)}</Text>
              <Text style={styles.sessionMeta}>
                {ev.at ? new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                {ev.device ? ` · ${ev.device}` : ''}
              </Text>
            </View>
          </View>
        ))
      )}
    </ScreenShell>
  );
}

// ---------------- Recovery codes ----------------
export function RecoveryCodesScreen({ onClose }: { onClose: () => void }) {
  const [unused, setUnused] = useState<number | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try { setUnused((await rpc('recovery_codes_status')).unused ?? 0); } catch {}
  };
  useEffect(() => { load(); }, []);

  const generate = () => {
    Alert.alert(
      'Generate new recovery codes?',
      unused && unused > 0 ? 'This invalidates your existing unused codes.' : 'These codes can get you back into your account if you lose your authenticator app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Generate',
          onPress: async () => {
            setBusy(true);
            try {
              const gen = await rpc('recovery_codes_generate');
              setCodes(gen.codes ?? []);
              setUnused((gen.codes ?? []).length);
            } catch {} finally { setBusy(false); }
          },
        },
      ]
    );
  };

  return (
    <ScreenShell title="Recovery codes" onClose={onClose}>
      <InfoCard
        icon="grid-outline"
        title={unused !== null ? `${unused} unused code${unused === 1 ? '' : 's'}` : 'Recovery codes'}
        sub="Single-use codes to recover your account if you lose your device. Regenerating invalidates old codes."
      />
      {codes && (
        <View style={styles.codesBox}>
          <Text style={styles.cardTitle}>SAVE YOUR RECOVERY CODES</Text>
          <Text style={styles.infoSub}>Each code works once. This is the only time they're shown.</Text>
          {codes.map((c) => <Text key={c} style={styles.codeRow}>{c}</Text>)}
          <BigBtn
            label="Copy all"
            tone="ghost"
            onPress={() => { Clipboard.setStringAsync(codes.join('\n')); Alert.alert('Copied', 'Recovery codes copied to clipboard.'); }}
          />
        </View>
      )}
      <BigBtn label={codes ? 'Generate new codes' : 'Get recovery codes'} onPress={generate} busy={busy} />
    </ScreenShell>
  );
}

// ---------------- Change password (while logged in) ----------------
export function SecurityPasswordModal({ visible, email, onClose }: { visible: boolean; email: string; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) { setError('Your new password needs at least 8 characters.'); return; }
    if (next !== confirm) { setError('Passwords don\'t match.'); return; }
    setBusy(true);
    try {
      // verify the CURRENT password first (real check against Auth)
      const { error: curErr } = await supabase.auth.signInWithPassword({ email, password: current });
      if (curErr) { setError('Current password is incorrect.'); return; }
      const { error: upErr } = await supabase.auth.updateUser({ password: next });
      if (upErr) throw upErr;
      // revoke every other session; silently re-login on this device
      await rpc('auth_invalidate_sessions').catch(() => {});
      await rpc('security_log', { p_event: 'password_changed', p_meta: { via: 'settings' } }).catch(() => {});
      markDeliberateSignOut(); // deliberate: the sign-in two lines down re-mirrors
      await supabase.auth.signOut();
      await supabase.auth.signInWithPassword({ email, password: next });
      Alert.alert('Password changed', 'Your password was updated. Other devices were signed out.');
      setCurrent(''); setNext(''); setConfirm('');
      onClose();
    } catch (e: any) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalOverlay} behavior="padding">
        <View style={styles.modalCard}>
          <Text style={styles.cardTitle}>Change password</Text>
          <Text style={styles.infoSub}>Last changed: view Security alerts for history.</Text>
          <TextInput style={styles.input} placeholder="Current password" placeholderTextColor={colors.textFaint} secureTextEntry value={current} onChangeText={setCurrent} />
          <TextInput style={styles.input} placeholder="New password" placeholderTextColor={colors.textFaint} secureTextEntry value={next} onChangeText={setNext} />
          <TextInput style={styles.input} placeholder="Confirm new password" placeholderTextColor={colors.textFaint} secureTextEntry value={confirm} onChangeText={setConfirm} />
          {!!error && <Text style={styles.error}>{error}</Text>}
          <BigBtn label="Update password" onPress={submit} busy={busy} />
          <Pressable style={styles.ghostLink} onPress={onClose}><Text style={styles.ghostLinkText}>Cancel</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------- Change email (native Supabase flow) ----------------
export function EmailModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'enter' | 'verify'>('enter');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(newEmail.trim())) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try {
      // real email change: Supabase sends a code to the NEW address and
      // automatically notifies the OLD address that it was changed
      const { error: e } = await supabase.auth.updateUser({ email: newEmail.trim() });
      if (e) throw e;
      setStage('verify');
    } catch (e: any) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.verifyOtp({ email: newEmail.trim(), token: code.trim(), type: 'email_change' });
      if (e) throw e;
      await rpc('security_log', { p_event: 'email_changed' }).catch(() => {});
      Alert.alert('Email changed', 'Your primary email was updated. The previous address was notified.');
      setNewEmail(''); setCode(''); setStage('enter');
      onClose();
    } catch (e: any) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalOverlay} behavior="padding">
        <View style={styles.modalCard}>
          <Text style={styles.cardTitle}>{stage === 'enter' ? 'Change email' : 'Verify your new email'}</Text>
          {stage === 'enter' ? (
            <>
              <Text style={styles.infoSub}>We'll send a confirmation code to the new address, and notify your current address of the change.</Text>
              <TextInput style={styles.input} placeholder="New email" placeholderTextColor={colors.textFaint} autoCapitalize="none" keyboardType="email-address" value={newEmail} onChangeText={setNewEmail} />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <BigBtn label="Continue" onPress={start} busy={busy} />
            </>
          ) : (
            <>
              <Text style={styles.infoSub}>Enter the 6-digit code sent to {newEmail.trim()}.</Text>
              <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor={colors.textFaint} keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <BigBtn label="Verify email" onPress={verify} busy={busy} />
            </>
          )}
          <Pressable style={styles.ghostLink} onPress={() => { setStage('enter'); setError(null); onClose(); }}><Text style={styles.ghostLinkText}>Cancel</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------- Phone ----------------
export function PhoneModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'enter' | 'verify'>('enter');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setError(null);
    if (phone.trim().length < 7) { setError('Enter a phone number with country code (e.g. +2348012345678).'); return; }
    setBusy(true);
    try {
      // real SMS OTP via Supabase (requires phone auth enabled in the project)
      const { error: e } = await supabase.auth.signInWithOtp({ phone: phone.trim() });
      if (e) throw e;
      setStage('verify');
    } catch (e: any) {
      setError('SMS verification isn\'t enabled for this app yet — enable phone auth in Supabase (Authentication → Phone) to use it.');
    } finally { setBusy(false); }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.verifyOtp({ phone: phone.trim(), token: code.trim(), type: 'sms' });
      if (e) throw e;
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('profiles').update({ phone: phone.trim(), phone_verified: true }).eq('id', user.id);
        await rpc('security_log', { p_event: 'phone_verified' }).catch(() => {});
      }
      Alert.alert('Phone verified', 'Your phone number is now a recovery option.');
      setPhone(''); setCode(''); setStage('enter');
      onClose();
    } catch (e: any) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalOverlay} behavior="padding">
        <View style={styles.modalCard}>
          <Text style={styles.cardTitle}>{stage === 'enter' ? 'Add phone number' : 'Verify phone number'}</Text>
          {stage === 'enter' ? (
            <>
              <Text style={styles.infoSub}>Used as a recovery method and for security alerts. Include your country code.</Text>
              <TextInput style={styles.input} placeholder="+2348012345678" placeholderTextColor={colors.textFaint} keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <BigBtn label="Continue" onPress={start} busy={busy} />
            </>
          ) : (
            <>
              <Text style={styles.infoSub}>Enter the SMS code sent to {phone.trim()}.</Text>
              <TextInput style={styles.input} placeholder="SMS code" placeholderTextColor={colors.textFaint} keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <BigBtn label="Verify phone" onPress={verify} busy={busy} />
            </>
          )}
          <Pressable style={styles.ghostLink} onPress={() => { setStage('enter'); setError(null); onClose(); }}><Text style={styles.ghostLinkText}>Cancel</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------- Deactivate / Delete ----------------
export function DeactivateModal({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = () => {
    Alert.alert('Deactivate your account?', 'Your profile and content will be hidden until you log back in and reactivate.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Deactivate',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await rpc('account_deactivate');
            markDeliberateSignOut(); // account ended by choice
            await supabase.auth.signOut();
            onDone();
          } catch (e: any) { Alert.alert('Something went wrong', friendlyError(e)); } finally { setBusy(false); }
        },
      },
    ]);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.cardTitle}>Deactivate account</Text>
          <Text style={styles.infoSub}>Your profile and content are hidden while deactivated. Logging back in reactivates everything.</Text>
          <BigBtn label="Deactivate" tone="danger" onPress={go} busy={busy} />
          <Pressable style={styles.ghostLink} onPress={onClose}><Text style={styles.ghostLinkText}>Cancel</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function DeleteModal({ visible, onClose, onDone }: { visible: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = () => {
    Alert.alert('Delete your account?', 'This starts the account deletion process. Your profile, drops and messages are deleted. Security and audit records are retained for compliance.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete account',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await rpc('account_delete');
            markDeliberateSignOut(); // account deleted — the only other valid exit
            await supabase.auth.signOut();
            onDone();
          } catch (e: any) { Alert.alert('Something went wrong', friendlyError(e)); } finally { setBusy(false); }
        },
      },
    ]);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={[styles.cardTitle, { color: colors.danger }]}>Delete account</Text>
          <Text style={styles.infoSub}>This action starts the account deletion process and can't be undone. Drops, profile and messages will be removed; audit records are retained.</Text>
          <BigBtn label="Continue to delete" tone="danger" onPress={go} busy={busy} />
          <Pressable style={styles.ghostLink} onPress={onClose}><Text style={styles.ghostLinkText}>Cancel</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg },
    // paddingTop was a hardcoded 20 — short of a real status bar, so the
    // "‹ Back" control and the screen title sat under the clock. This is a
    // full-screen opaque modal, so it owns its own top inset.
    shellHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: TOP_INSET + 6, paddingHorizontal: 16, paddingBottom: 10 },
  shellBack: { width: 70 },
  shellBackText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  shellTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  shellContent: { padding: 18, paddingBottom: 60, gap: 14 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 16 },
  infoTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  infoSub: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  error: { color: colors.danger, fontSize: 13, marginBottom: 6, lineHeight: 18 },
  bigBtn: { backgroundColor: colors.accent, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 6 },
  bigBtnDanger: { backgroundColor: colors.danger },
  bigBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accent },
  bigBtnText: { color: colors.bg, fontSize: 15, fontWeight: '800' },
  input: { backgroundColor: colors.surfaceInput, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, color: colors.text, fontSize: 15, marginBottom: 12, marginTop: 10 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  qrWrap: { alignItems: 'center' },
  qrBox: { backgroundColor: '#fff', borderRadius: 16, padding: 14, marginVertical: 14, ...shadows.glow },
  codesBox: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 16 },
  codeRow: { color: colors.accent, fontSize: 15, fontWeight: '800', letterSpacing: 1, marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  sessionRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 14, gap: 12 },
  sessionIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  sessionDevice: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sessionMeta: { color: colors.textMuted, fontSize: 12.5, marginTop: 2 },
  eventRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 14, gap: 12 },
  eventIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(5,8,16,0.75)', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: radius.xl, padding: 20, ...shadows.glow },
  ghostLink: { alignItems: 'center', marginTop: 14, paddingVertical: 6 },
  ghostLinkText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
});
