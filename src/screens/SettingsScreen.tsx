import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import { copyToClipboard } from '../utils/clipboard';
import { unregisterPush } from '../utils/push';
import { buildAccountSnapshot, fetchAccountStats, type AccountStats } from '../utils/accountStats';
import Button from '../components/Button';
import Avatar from '../components/Avatar';
import AvatarPickerModal from '../components/AvatarPickerModal';
import AnonymousSettingsModal from '../components/AnonymousSettingsModal';
import Icon from '../components/ui/Icon';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import ReportProblemModal, { SUPPORT_EMAIL } from '../components/settings/ReportProblemModal';
import AccountInfoModal from '../components/settings/AccountInfoModal';
import { BlockedScreen, MutedScreen, HiddenWordsScreen } from '../components/settings/ListScreens';
import {
  TwoFactorScreen,
  SessionsScreen,
  SecurityAlertsScreen,
  RecoveryCodesScreen,
  SecurityPasswordModal,
  EmailModal,
  PhoneModal,
  DeactivateModal,
  DeleteModal,
} from '../components/security/AccountSecurity';

const APP_VERSION = '0.1.0';

type Profile = {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  is_private: boolean;
  message_who: string;
  comment_who: string;
  mention_who: string;
  activity_status: boolean;
  theme: string;
  created_at: string;
};

const WHO_OPTIONS = ['everyone', 'followers', 'nobody'];

type IconName = React.ComponentProps<typeof Icon>['name'];

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<any>({});
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [counts, setCounts] = useState({ blocked: 0, muted: 0, words: 0 });
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [security, setSecurity] = useState<{ mfa_enabled: boolean; phone: string | null; phone_verified: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [usernameOpen, setUsernameOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [anonOpen, setAnonOpen] = useState(false);
  const [accountInfoOpen, setAccountInfoOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [mutedOpen, setMutedOpen] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);
  const [twoFAOpen, setTwoFAOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [deactOpen, setDeactOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    setEmail(user.email ?? '');

    const head = { count: 'exact' as const, head: true };
    const [profRes, prefsRes, blockRes, muteRes, wordRes, accountStats] = await Promise.all([
      supabase
        .from('profiles')
        .select('username, display_name, bio, avatar_url, is_private, message_who, comment_who, mention_who, activity_status, theme, created_at')
        .eq('id', user.id)
        .maybeSingle(),
      supabase.from('settings').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('blocks').select('blocked_id', head).eq('blocker_id', user.id),
      supabase.from('muted_accounts').select('muted_id', head).eq('user_id', user.id),
      supabase.from('hidden_words').select('word', head).eq('user_id', user.id),
      fetchAccountStats(user.id),
    ]);

    setProfile((profRes.data as Profile | null) ?? null);
    setSettings((prefsRes.data ?? {}) as any);
    setCounts({
      blocked: blockRes.count ?? 0,
      muted: muteRes.count ?? 0,
      words: wordRes.count ?? 0,
    });
    setStats(accountStats);

    try {
      const { data: sec } = await supabase.rpc('account_security_status');
      setSecurity(sec as any);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateProfile = async (patch: any) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);
    if (!error) setProfile((p) => (p ? { ...p, ...patch } : p));
    return error;
  };

  const saveSettings = async (patch: any) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setSettings((s: any) => ({ ...s, ...patch }));
    await supabase.from('settings').upsert({ user_id: user.id, ...patch }, { onConflict: 'user_id' });
  };

  const logout = async () => {
    // stop this phone receiving pushes for the account that is leaving
    await unregisterPush();
    await supabase.auth.signOut();
  };

  const mailSupport = async () => {
    try {
      await Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Gen Z - support')}`);
    } catch {
      const ok = await copyToClipboard(SUPPORT_EMAIL);
      Alert.alert('Support email', ok ? `${SUPPORT_EMAIL} copied to your clipboard.` : SUPPORT_EMAIL);
    }
  };

  const exportData = async () => {
    if (!userId || exporting) return;
    setExporting(true);
    const snapshot = await buildAccountSnapshot(userId);
    const ok = await copyToClipboard(JSON.stringify(snapshot, null, 2));
    setExporting(false);
    setExported(ok);
    if (!ok) {
      Alert.alert('Clipboard unavailable', `Your export could not be copied on this build.`);
      return;
    }
    setTimeout(() => setExported(false), 2500);
  };

  const statValue = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : String(value);

  const activitySummary = (() => {
    if (!stats) return 'Your posts, comments and likes';
    const parts: string[] = [];
    if (stats.posts !== null) parts.push(`${stats.posts} posts`);
    if (stats.comments !== null) parts.push(`${stats.comments} comments`);
    if (stats.likesGiven !== null) parts.push(`${stats.likesGiven} likes given`);
    return parts.length ? parts.join(' · ') : 'Your posts, comments and likes';
  })();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Icon name="chevron-back" size={22} color={colors.accent} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ---------------- identity ---------------- */}
        <Pressable style={styles.hero} onPress={() => setEditOpen(true)}>
          <Avatar
            url={profile?.avatar_url}
            name={profile?.display_name || profile?.username || 'G'}
            size={68}
            ring
            verified={!!(profile as any)?.verified}
          />
          <View style={styles.heroInfo}>
            <View style={styles.heroNameRow}>
              <Text style={styles.heroName} numberOfLines={1}>
                {profile?.display_name || profile?.username || 'Gen Z user'}
              </Text>
              {!!(profile as any)?.verified && <VerifiedBadge size={15} glow={false} />}
            </View>
            <Text style={styles.heroHandle}>@{profile?.username ?? 'unknown'}</Text>
            <Text style={styles.heroJoined}>
              Joined {new Date(profile?.created_at ?? Date.now()).toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </Text>
          </View>
          <Icon name="create-outline" size={18} color={colors.textMuted} />
        </Pressable>

        <View style={styles.statStrip}>
          <Metric label="followers" value={statValue(stats?.followers)} />
          <Metric label="following" value={statValue(stats?.following)} />
          <Metric label="posts" value={statValue(stats?.posts)} />
          <Metric label="likes banked" value={statValue(stats?.lifetimeLikes)} />
        </View>

        {/* ---------------- account ---------------- */}
        <Section title="Account">
          <Row icon="person-outline" label="Edit profile" detail="Name, bio, avatar" onPress={() => setEditOpen(true)} />
          <Row icon="at-outline" label="Change username" detail={`@${profile?.username ?? 'unknown'}`} onPress={() => setUsernameOpen(true)} />
          <Row icon="mail-outline" label="Email" detail={email || 'Not set'} onPress={() => setEmailOpen(true)} />
          <Row
            icon="call-outline"
            label="Phone"
            detail={security?.phone ?? 'Add a number for recovery'}
            onPress={() => setPhoneOpen(true)}
          />
          <Row
            icon="information-circle-outline"
            label="Account information"
            detail="Sign-in, device and account ID"
            onPress={() => setAccountInfoOpen(true)}
          />
        </Section>

        {/* ---------------- privacy ---------------- */}
        <Section title="Privacy & safety">
          <ToggleRow
            label="Private account"
            hint="Followers must request to see your posts"
            value={profile?.is_private ?? false}
            onChange={(v) => updateProfile({ is_private: v })}
          />
          <WhoRow label="Who can message me" value={profile?.message_who ?? 'everyone'} onChange={(v) => updateProfile({ message_who: v })} />
          <WhoRow label="Who can comment" value={profile?.comment_who ?? 'everyone'} onChange={(v) => updateProfile({ comment_who: v })} />
          <WhoRow label="Who can mention me" value={profile?.mention_who ?? 'everyone'} onChange={(v) => updateProfile({ mention_who: v })} />
          <ToggleRow
            label="Activity status"
            hint="Show when you're online"
            value={profile?.activity_status ?? true}
            onChange={(v) => updateProfile({ activity_status: v })}
          />
        </Section>

        <Section title="People & words">
          <Row
            icon="ban-outline"
            label="Blocked accounts"
            detail={counts.blocked ? `${counts.blocked} blocked` : 'Nobody blocked'}
            onPress={() => setBlockedOpen(true)}
          />
          <Row
            icon="volume-mute-outline"
            label="Muted accounts"
            detail={counts.muted ? `${counts.muted} muted` : 'Nobody muted'}
            onPress={() => setMutedOpen(true)}
          />
          <Row
            icon="eye-off-outline"
            label="Hidden words"
            detail={counts.words ? `${counts.words} hidden` : 'Hide words you never want to see'}
            onPress={() => setWordsOpen(true)}
          />
          <Row
            icon="chatbubble-ellipses-outline"
            label="Anonymous messages"
            detail="Control what you receive anonymously"
            onPress={() => setAnonOpen(true)}
          />
        </Section>

        {/* ---------------- notifications ---------------- */}
        <Section title="Notifications">
          <ToggleRow label="Likes" hint="Includes reactions and reposts" value={settings.notif_likes ?? true} onChange={(v) => saveSettings({ notif_likes: v })} />
          <ToggleRow label="Comments" hint="Comments, replies and comment likes" value={settings.notif_comments ?? true} onChange={(v) => saveSettings({ notif_comments: v })} />
          <ToggleRow label="Followers" hint="New followers" value={settings.notif_followers ?? true} onChange={(v) => saveSettings({ notif_followers: v })} />
          <ToggleRow label="Messages" hint="Direct messages and calls" value={settings.notif_messages ?? true} onChange={(v) => saveSettings({ notif_messages: v })} />
          <ToggleRow label="Mentions" hint="When someone tags you" value={settings.notif_mentions ?? true} onChange={(v) => saveSettings({ notif_mentions: v })} />
        </Section>
        <Caption>Switching one off stops those notifications being created at all, not just muting them.</Caption>

        {/* ---------------- security ---------------- */}
        <Section title="Security">
          <Row icon="lock-closed-outline" label="Change password" onPress={() => setPasswordOpen(true)} />
          <Row
            icon="shield-checkmark-outline"
            label="Two-factor authentication"
            detail={security?.mfa_enabled ? 'ON — authenticator app' : 'OFF'}
            onPress={() => setTwoFAOpen(true)}
          />
          <Row icon="phone-portrait-outline" label="Where you're logged in" onPress={() => setSessionsOpen(true)} />
          <Row icon="key-outline" label="Recovery codes" onPress={() => setCodesOpen(true)} />
          <Row icon="notifications-outline" label="Security alerts" onPress={() => setAlertsOpen(true)} />
        </Section>

        {/* ---------------- your data ---------------- */}
        <Section title="Your data">
          <StaticRow icon="bar-chart-outline" label="Your activity" detail={activitySummary} />
          <Row
            icon={exported ? 'checkmark-circle-outline' : 'download-outline'}
            label={exported ? 'Copied to clipboard' : 'Export my data'}
            detail="Profile, stats and preferences as JSON"
            onPress={exportData}
            action={exporting ? 'Working...' : undefined}
          />
        </Section>

        {/* ---------------- support ---------------- */}
        <Section title="Support">
          <Row
            icon="flag-outline"
            label="Report a problem"
            detail="Bugs, abuse, harmful content"
            onPress={() => setReportOpen(true)}
          />
          <Row icon="mail-outline" label="Email us" detail={SUPPORT_EMAIL} onPress={mailSupport} />
        </Section>

        {/* ---------------- about ---------------- */}
        <Section title="About">
          <StaticRow icon="color-palette-outline" label="Appearance" detail="Midnight dark — light theme is still in the works" />
          <StaticRow icon="pricetag-outline" label="App version" detail={APP_VERSION} />
        </Section>

        {/* ---------------- danger zone ---------------- */}
        <Section title="Account status">
          <Row icon="pause-circle-outline" label="Deactivate account" detail="Hide everything, keep the data" onPress={() => setDeactOpen(true)} />
          <Row icon="trash-outline" label="Delete account" detail="Permanent, cannot be undone" onPress={() => setDelOpen(true)} />
          <Pressable style={styles.logoutBtn} onPress={logout}>
            <Icon name="log-out-outline" size={18} color={colors.danger} />
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </Section>
      </ScrollView>

      {/* ---------------- modals ---------------- */}
      <EditProfileModal
        visible={editOpen}
        profile={profile}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          load();
        }}
      />
      <ChangeUsernameModal
        visible={usernameOpen}
        onClose={() => setUsernameOpen(false)}
        onSaved={() => {
          setUsernameOpen(false);
          load();
        }}
      />
      <SecurityPasswordModal visible={passwordOpen} email={email} onClose={() => setPasswordOpen(false)} />
      <AnonymousSettingsModal visible={anonOpen} onClose={() => setAnonOpen(false)} />
      <AccountInfoModal
        visible={accountInfoOpen}
        onClose={() => setAccountInfoOpen(false)}
        profile={profile}
        stats={stats}
        security={security}
      />
      <ReportProblemModal
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        accountEmail={email}
        username={profile?.username}
        userId={userId ?? undefined}
      />
      <BlockedScreen visible={blockedOpen} onClose={() => setBlockedOpen(false)} onChanged={load} />
      <MutedScreen visible={mutedOpen} onClose={() => setMutedOpen(false)} onChanged={load} />
      <HiddenWordsScreen visible={wordsOpen} onClose={() => setWordsOpen(false)} onChanged={load} />
      {twoFAOpen && <TwoFactorScreen onClose={() => { setTwoFAOpen(false); load(); }} />}
      {sessionsOpen && <SessionsScreen onClose={() => setSessionsOpen(false)} />}
      {alertsOpen && <SecurityAlertsScreen onClose={() => setAlertsOpen(false)} />}
      {codesOpen && <RecoveryCodesScreen onClose={() => setCodesOpen(false)} />}
      <EmailModal visible={emailOpen} onClose={() => setEmailOpen(false)} />
      <PhoneModal visible={phoneOpen} onClose={() => setPhoneOpen(false)} />
      <DeactivateModal visible={deactOpen} onClose={() => setDeactOpen(false)} onDone={() => setDeactOpen(false)} />
      <DeleteModal visible={delOpen} onClose={() => setDelOpen(false)} onDone={() => setDelOpen(false)} />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* building blocks                                                     */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function Row({
  icon,
  label,
  detail,
  action,
  onPress,
}: {
  icon?: IconName;
  label: string;
  detail?: string;
  action?: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      {!!icon && (
        <View style={styles.rowIcon}>
          <Icon name={icon} size={16} color={colors.accent} />
        </View>
      )}
      <View style={styles.rowInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!detail && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
      {!!action && <Text style={styles.rowAction}>{action}</Text>}
      <Icon name="chevron-forward" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

function StaticRow({ icon, label, detail }: { icon?: IconName; label: string; detail?: string }) {
  return (
    <View style={styles.row}>
      {!!icon && (
        <View style={styles.rowIcon}>
          <Icon name={icon} size={16} color={colors.accent} />
        </View>
      )}
      <View style={styles.rowInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!detail && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
    </View>
  );
}

function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!hint && <Text style={styles.rowDetail}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.logoWhite}
      />
    </View>
  );
}

function WhoRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.whoRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segment}>
        {WHO_OPTIONS.map((o) => (
          <Pressable key={o} style={[styles.segmentBtn, value === o && styles.segmentActive]} onPress={() => onChange(o)}>
            <Text style={[styles.segmentText, value === o && styles.segmentTextActive]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* modals                                                              */
/* ------------------------------------------------------------------ */

function EditProfileModal({ visible, profile, onClose, onSaved }: any) {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [localAvatar, setLocalAvatar] = useState<string | null | undefined>(undefined);
  const [avatarPicker, setAvatarPicker] = useState(false);

  useEffect(() => {
    if (visible && profile) {
      setDisplayName(profile.display_name ?? '');
      setBio(profile.bio ?? '');
      setLocation(profile.location ?? '');
      setPronouns(profile.pronouns ?? '');
      setLocalAvatar(undefined);
    }
  }, [visible, profile]);

  const save = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        location: location.trim() || null,
        pronouns: pronouns.trim() || null,
      })
      .eq('id', user.id);
    onSaved();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Edit profile</Text>
          <Pressable style={styles.modalAvatarRow} onPress={() => setAvatarPicker(true)}>
            <Avatar
              url={localAvatar !== undefined ? localAvatar : profile?.avatar_url}
              name={displayName || profile?.username || 'G'}
              size={84}
              ring
            />
            <Text style={styles.modalAvatarCta}>Change avatar</Text>
          </Pressable>
          <TextInput style={styles.modalInput} placeholder="Display name" placeholderTextColor={colors.textFaint} value={displayName} onChangeText={setDisplayName} />
          <TextInput style={[styles.modalInput, styles.modalBio]} placeholder="Bio" placeholderTextColor={colors.textFaint} multiline value={bio} onChangeText={setBio} />
          <TextInput style={styles.modalInput} placeholder="Location (optional)" placeholderTextColor={colors.textFaint} value={location} onChangeText={setLocation} />
          <TextInput style={styles.modalInput} placeholder="Pronouns (e.g. he/him)" placeholderTextColor={colors.textFaint} value={pronouns} onChangeText={setPronouns} />
          <AvatarPickerModal
            visible={avatarPicker}
            current={profile?.avatar_url}
            name={displayName || profile?.username || 'G'}
            onClose={() => setAvatarPicker(false)}
            onSaved={(value) => setLocalAvatar(value)}
          />
          <Button title="Save" onPress={save} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ChangeUsernameModal({ visible, onClose, onSaved }: any) {
  const [username, setUsername] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    const name = username.trim().toLowerCase();
    if (name.length < 3) {
      setAvailable(false);
      return;
    }
    setChecking(true);
    const { data } = await supabase.from('profiles').select('id').ilike('username', name).maybeSingle();
    setChecking(false);
    setAvailable(!data);
  };

  const save = async () => {
    if (!available) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('profiles').update({ username: username.trim().toLowerCase() }).eq('id', user.id);
    onSaved();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Change username</Text>
          <TextInput
            style={styles.modalInput}
            placeholder="New username"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={(t) => {
              setUsername(t);
              setAvailable(null);
            }}
          />
          {available !== null && !checking && (
            <Text style={[styles.checkText, available ? styles.checkOk : styles.checkBad]}>
              {available ? 'Available' : 'Taken — try another'}
            </Text>
          )}
          <Button title="Check availability" variant="secondary" onPress={check} loading={checking} style={{ marginBottom: 10 }} />
          <Button title="Save username" onPress={save} disabled={!available} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: { width: 46 },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  content: { padding: 16, paddingBottom: 48 },

  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: 16,
    paddingVertical: 16,
    ...shadows.sm,
  },
  heroInfo: { flex: 1 },
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroName: { color: colors.text, fontSize: 18, fontWeight: '800', maxWidth: '80%' },
  heroHandle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  heroJoined: { color: colors.textFaint, fontSize: 11.5, marginTop: 4 },

  statStrip: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 12,
    marginTop: 10,
    marginBottom: 4,
  },
  metric: { flex: 1, alignItems: 'center' },
  metricValue: { color: colors.text, fontSize: 16, fontWeight: '800' },
  metricLabel: { color: colors.textMuted, fontSize: 10.5, marginTop: 2 },

  section: { marginTop: 18 },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
    marginLeft: 4,
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  caption: {
    color: colors.textFaint,
    fontSize: 11.5,
    lineHeight: 17,
    marginTop: 8,
    marginLeft: 4,
    marginRight: 4,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    gap: 11,
  },
  whoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    gap: 10,
  },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: { flex: 1 },
  rowLabel: { color: colors.text, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  rowDetail: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  rowAction: { color: colors.accent, fontSize: 12.5, fontWeight: '700' },

  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    padding: 3,
  },
  segmentBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  segmentTextActive: { color: colors.bg },

  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,92,124,0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: 13,
    marginTop: 12,
  },
  logoutText: { color: colors.danger, fontSize: 14, fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 22,
    paddingBottom: 36,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  modalAvatarRow: { alignItems: 'center', marginBottom: 16 },
  modalAvatarCta: { color: colors.accent, fontSize: 13, fontWeight: '600', marginTop: 8 },
  modalInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  modalBio: { minHeight: 80, textAlignVertical: 'top' },
  modalCancel: { alignItems: 'center', marginTop: 12 },
  modalCancelText: { color: colors.textMuted, fontSize: 14 },
  checkText: { fontSize: 13, marginBottom: 10 },
  checkOk: { color: colors.success },
  checkBad: { color: colors.danger, fontSize: 13, marginBottom: 10 },
});
