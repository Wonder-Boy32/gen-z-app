import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
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
import { colors, radius } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import Button from '../components/Button';
import Avatar from '../components/Avatar';
import AvatarPickerModal from '../components/AvatarPickerModal';

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

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<any>({});
  const [blocked, setBlocked] = useState<{ id: string; username: string }[]>([]);
  const [muted, setMuted] = useState<{ id: string; username: string }[]>([]);
  const [words, setWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [usernameOpen, setUsernameOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setEmail(user.email ?? '');

    const [{ data: prof }, { data: prefs }, { data: blockRows }, { data: muteRows }, { data: wordRows }] =
      await Promise.all([
        supabase
          .from('profiles')
          .select('username, display_name, bio, avatar_url, is_private, message_who, comment_who, mention_who, activity_status, theme, created_at')
          .eq('id', user.id)
          .maybeSingle(),
        supabase.from('settings').select('*').eq('user_id', user.id).maybeSingle(),
        supabase
          .from('blocks')
          .select('blocked_id, profile:profiles!blocks_blocked_id_fkey(username)')
          .eq('blocker_id', user.id),
        supabase
          .from('muted_accounts')
          .select('muted_id, profile:profiles!muted_accounts_muted_id_fkey(username)')
          .eq('user_id', user.id),
        supabase.from('hidden_words').select('word').eq('user_id', user.id),
      ]);

    setProfile((prof as Profile | null) ?? null);
    setSettings((prefs?.data ?? {}) as any);
    setBlocked(((blockRows?.data ?? []) as any[]).map((b) => ({ id: b.blocked_id, username: b.profile?.username ?? 'unknown' })));
    setMuted(((muteRows?.data ?? []) as any[]).map((m) => ({ id: m.muted_id, username: m.profile?.username ?? 'unknown' })));
    setWords(((wordRows?.data ?? []) as any[]).map((w) => w.word));
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

  const unblock = async (id: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setBlocked((b) => b.filter((x) => x.id !== id));
    await supabase.from('blocks').delete().eq('blocker_id', user.id).eq('blocked_id', id);
  };

  const unmute = async (id: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setMuted((m) => m.filter((x) => x.id !== id));
    await supabase.from('muted_accounts').delete().eq('user_id', user.id).eq('muted_id', id);
  };

  const addWord = async () => {
    const w = newWord.trim().toLowerCase();
    if (!w) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setWords((prev) => [...prev, w]);
    setNewWord('');
    await supabase.from('hidden_words').insert({ user_id: user.id, word: w });
  };

  const removeWord = async (word: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setWords((prev) => prev.filter((x) => x !== word));
    await supabase.from('hidden_words').delete().eq('user_id', user.id).eq('word', word);
  };

  const changePassword = async (current: string, next: string) => {
    const { error } = await supabase.auth.updateUser({ password: next });
    return error;
  };

  const logout = async () => {
    await supabase.auth.signOut();
  };

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
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Section title="Account">
          <Row label="Edit profile" onPress={() => setEditOpen(true)} />
          <Row label="Change username" onPress={() => setUsernameOpen(true)} />
          <Row label="Account information" detail={`${email} · joined ${new Date(profile?.created_at ?? Date.now()).toLocaleDateString([], { month: 'short', year: 'numeric' })}`} />
        </Section>

        <Section title="Privacy">
          <ToggleRow
            label="Private account"
            hint="Followers must request to see your stories"
            value={profile?.is_private ?? false}
            onChange={(v) => updateProfile({ is_private: v })}
          />
          <WhoRow label="Who can message me" value={profile?.message_who ?? 'everyone'} onChange={(v) => updateProfile({ message_who: v })} />
          <WhoRow label="Who can comment" value={profile?.comment_who ?? 'everyone'} onChange={(v) => updateProfile({ comment_who: v })} />
          <WhoRow label="Who can mention / tag me" value={profile?.mention_who ?? 'everyone'} onChange={(v) => updateProfile({ mention_who: v })} />
          <ToggleRow
            label="Activity status"
            hint="Show when you're online"
            value={profile?.activity_status ?? true}
            onChange={(v) => updateProfile({ activity_status: v })}
          />
        </Section>

        <Section title="Security">
          <Row label="Change password" onPress={() => setPasswordOpen(true)} />
          <Row label="Two-factor authentication" detail="Enable in the Supabase dashboard" onPress={() => {}} />
          <Row label="Login sessions" detail="Requires admin — coming with the web dashboard" onPress={() => {}} />
        </Section>

        <Section title="Content">
          <Row label={`Blocked accounts (${blocked.length})`} onPress={() => setBlocked((b) => [...b])} />
          {blocked.map((b) => (
            <Row key={b.id} label={`@${b.username}`} action="Unblock" onPress={() => unblock(b.id)} small />
          ))}
          <Row label={`Muted accounts (${muted.length})`} onPress={() => setMuted((m) => [...m])} />
          {muted.map((m) => (
            <Row key={m.id} label={`@${m.username}`} action="Unmute" onPress={() => unmute(m.id)} small />
          ))}
          <Row label={`Hidden words (${words.length})`} onPress={() => setWords((w) => [...w])} />
          <View style={styles.wordRow}>
            <TextInput
              style={styles.wordInput}
              placeholder="Add a word to hide..."
              placeholderTextColor={colors.textFaint}
              value={newWord}
              onChangeText={setNewWord}
              onSubmitEditing={addWord}
            />
            <Pressable style={styles.wordAdd} onPress={addWord}>
              <Text style={styles.wordAddText}>Add</Text>
            </Pressable>
          </View>
          <View style={styles.wordWrap}>
            {words.map((w) => (
              <Pressable key={w} style={styles.wordChip} onPress={() => removeWord(w)}>
                <Text style={styles.wordChipText}>{w} ✕</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section title="Notifications">
          <ToggleRow label="Likes" value={settings.notif_likes ?? true} onChange={(v) => saveSettings({ notif_likes: v })} />
          <ToggleRow label="Comments" value={settings.notif_comments ?? true} onChange={(v) => saveSettings({ notif_comments: v })} />
          <ToggleRow label="Followers" value={settings.notif_followers ?? true} onChange={(v) => saveSettings({ notif_followers: v })} />
          <ToggleRow label="Messages" value={settings.notif_messages ?? true} onChange={(v) => saveSettings({ notif_messages: v })} />
          <ToggleRow label="Mentions" value={settings.notif_mentions ?? true} onChange={(v) => saveSettings({ notif_mentions: v })} />
        </Section>

        <Section title="Appearance">
          <ThemeRow value={profile?.theme ?? 'dark'} onChange={(v) => updateProfile({ theme: v })} />
        </Section>

        <Section title="Account">
          <Row label="Help & Support" detail="genz.support@placeholder.com" onPress={() => {}} />
          <Pressable style={styles.logoutBtn} onPress={logout}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </Section>
      </ScrollView>

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
      <ChangePasswordModal visible={passwordOpen} onClose={() => setPasswordOpen(false)} onSave={changePassword} />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function Row({
  label,
  detail,
  action,
  small,
  onPress,
}: {
  label: string;
  detail?: string;
  action?: string;
  small?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.row, small && styles.rowSmall]} onPress={onPress}>
      <View style={styles.rowInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!detail && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
      {!!action && <Text style={styles.rowAction}>{action}</Text>}
    </Pressable>
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
    <View style={styles.row}>
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

function ThemeRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>Theme</Text>
      <View style={styles.segment}>
        {['dark', 'light', 'system'].map((o) => (
          <Pressable key={o} style={[styles.segmentBtn, value === o && styles.segmentActive]} onPress={() => onChange(o)}>
            <Text style={[styles.segmentText, value === o && styles.segmentTextActive]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

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

function ChangePasswordModal({ visible, onClose, onSave }: any) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (next.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    setError(null);
    const err = await onSave(current, next);
    if (err) setError(err.message);
    else {
      setCurrent('');
      setNext('');
      setConfirm('');
      onClose();
    }
    setSaving(false);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Change password</Text>
          <TextInput style={styles.modalInput} placeholder="Current password" placeholderTextColor={colors.textFaint} secureTextEntry value={current} onChangeText={setCurrent} />
          <TextInput style={styles.modalInput} placeholder="New password" placeholderTextColor={colors.textFaint} secureTextEntry value={next} onChangeText={setNext} />
          <TextInput style={styles.modalInput} placeholder="Confirm new password" placeholderTextColor={colors.textFaint} secureTextEntry value={confirm} onChangeText={setConfirm} />
          {!!error && <Text style={styles.checkBad}>{error}</Text>}
          <Button title="Update password" onPress={save} loading={saving} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
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
  backBtn: {
    width: 70,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 18,
  },
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  rowSmall: {
    paddingVertical: 8,
    paddingLeft: 28,
  },
  rowInfo: {
    flex: 1,
    marginRight: 10,
  },
  rowLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '500',
  },
  rowDetail: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  rowAction: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    padding: 3,
  },
  segmentBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.bg,
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  wordInput: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 13,
  },
  wordAdd: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginLeft: 8,
  },
  wordAddText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '700',
  },
  wordWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  wordChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    margin: 3,
  },
  wordChipText: {
    color: colors.text,
    fontSize: 12,
  },
  logoutBtn: {
    backgroundColor: 'rgba(255,92,124,0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  logoutText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 22,
    paddingBottom: 36,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalAvatarRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  modalAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  modalAvatarPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalAvatarLetter: {
    color: colors.accent,
    fontSize: 32,
    fontWeight: '800',
  },
  modalAvatarCta: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
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
  modalBio: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalCancel: {
    alignItems: 'center',
    marginTop: 12,
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  checkText: {
    fontSize: 13,
    marginBottom: 10,
  },
  checkOk: {
    color: colors.success,
  },
  checkBad: {
    color: colors.danger,
    fontSize: 13,
    marginBottom: 10,
  },
});
