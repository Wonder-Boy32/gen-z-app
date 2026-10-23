// ============================================================
// GROUP INFO (§27)
//
// One screen that owns everything about a group: identity, invite,
// the member list with role management, add-members, mute and the
// (deliberately two-step) leave action.
//
// ── SOURCE OF TRUTH FOR COLUMNS ──────────────────────────────
// supabase/schema.sql:150            conversations(id, created_at)
// supabase/chat2.sql:8-13            conversations.type / name /
//                                    avatar_url / created_by
// supabase/messaging_v2.sql:386-401  conversation_participants.role
//                                    (+ can_post) with
//                                    participants_role_chk
//                                    check (role in ('member','admin','owner'))
// supabase/chat_settings.sql:15-20   conversation_participants.muted /
//                                    muted_until / nickname / ...
//
// ── NO INVITE-CODE COLUMN EXISTS ─────────────────────────────
// A repo-wide search finds no `invite_code`, `inviteCode`,
// `join_code` or `joinCode` column anywhere — not in schema.sql and
// not in any of the 55 migrations. The Invite section is therefore
// rendered DISABLED with an explicit note instead of inventing a
// column (and instead of a query that would fail at runtime).
//
// ── DEGRADATION POLICY ───────────────────────────────────────
// Every read walks a fallback chain of column lists, so a database
// that predates messaging_v2.sql / chat_settings.sql still renders.
// Controls whose column is missing are shown DISABLED with a note.
// Every failure surfaces in a dismissible inline error bar.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

import { colors, radius, spacing, type } from '../theme';
import { supabase } from '../supabase/client';
import { TOP_INSET } from '../utils/useInsets';
import { uploadMedia } from '../utils/upload';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import AddMembersSheet from '../components/chat/AddMembersSheet';
import { friendlyError } from '../utils/friendlyError';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// ------------------------------------------------------------
// Column sets, most complete first.
// ------------------------------------------------------------

interface ParticipantColumns {
  role: boolean;
  can_post: boolean;
  muted: boolean;
}

/** `role` is the only one with a CHECK constraint: ('member','admin','owner'). */
const PARTICIPANT_FALLBACKS: { select: string; columns: ParticipantColumns }[] = [
  {
    select: 'conversation_id, user_id, role, can_post, muted',
    columns: { role: true, can_post: true, muted: true },
  },
  {
    select: 'conversation_id, user_id, role, can_post',
    columns: { role: true, can_post: true, muted: false },
  },
  {
    select: 'conversation_id, user_id, role',
    columns: { role: true, can_post: false, muted: false },
  },
  {
    select: 'conversation_id, user_id',
    columns: { role: false, can_post: false, muted: false },
  },
];

/** `created_at` is from schema.sql:152; older mirrors may lack it. */
const CONVERSATION_COLUMNS = 'id, name, avatar_url, type, created_at';
const CONVERSATION_COLUMNS_LEGACY = 'id, name, avatar_url, type';

const PROFILES_COLUMNS = 'id, username, avatar_url, verified';

const NAME_MAX = 60;

// ------------------------------------------------------------
// Rows + narrowing (the Supabase client is untyped, so nothing is
// trusted until it is proven — no bare `any` anywhere in this file)
// ------------------------------------------------------------

interface ConversationRow {
  id: string;
  name: string | null;
  avatar_url: string | null;
  type: string | null;
  created_at: string | null;
}

interface ParticipantRow {
  user_id: string;
  role: string | null;
  can_post: boolean | null;
  muted: boolean | null;
}

interface ProfileRow {
  id: string;
  username: string | null;
  avatar_url: string | null;
  verified: boolean | null;
}

interface MemberRow {
  user_id: string;
  role: string | null;
  can_post: boolean | null;
  muted: boolean | null;
  username: string;
  avatarUrl: string | null;
  verified: boolean;
  isSelf: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asArray(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [];
}

function toConversation(raw: unknown): ConversationRow | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    name: asString(raw.name),
    avatar_url: asString(raw.avatar_url),
    type: asString(raw.type),
    created_at: asString(raw.created_at),
  };
}

function toParticipant(raw: unknown): ParticipantRow | null {
  if (!isRecord(raw)) return null;
  const userId = asString(raw.user_id);
  if (!userId) return null;
  return {
    user_id: userId,
    role: asString(raw.role),
    can_post: asBoolean(raw.can_post),
    muted: asBoolean(raw.muted),
  };
}

function toProfile(raw: unknown): ProfileRow | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    username: asString(raw.username),
    avatar_url: asString(raw.avatar_url),
    verified: asBoolean(raw.verified),
  };
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message.length > 0 ? e.message : fallback;
}

/** `owner` outranks `admin`, but the UI calls both of them "Admin". */
function isAdminRole(role: string | null): boolean {
  return role === 'admin' || role === 'owner';
}

function roleLabel(role: string | null): string {
  return isAdminRole(role) ? 'Admin' : 'Member';
}

function formatCreated(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `Created ${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// ------------------------------------------------------------
// Screen
// ------------------------------------------------------------

interface GroupInfoScreenProps {
  conversationId: string;
  onBack: () => void;
}

export default function GroupInfoScreen({ conversationId, onBack }: GroupInfoScreenProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [columns, setColumns] = useState<ParticipantColumns>({
    role: false,
    can_post: false,
    muted: false,
  });
  /** True when the `conversations` read had to fall back (no created_at). */
  const [createdAtAvailable, setCreatedAtAvailable] = useState(true);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [actionMember, setActionMember] = useState<MemberRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // ── Load ──────────────────────────────────────────────────

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setLoading(true);
      setError(null);

      try {
        const userId = await currentUserId();
        if (!userId) {
          setError('You are signed out — sign in again to manage this group.');
          return;
        }
        setMe(userId);

        // 1) conversations — name, avatar_url, type, created_at
        const primary = await supabase
          .from('conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('id', conversationId)
          .maybeSingle();

        let conv: ConversationRow | null = null;
        let createdOk = true;

        if (primary.error) {
          const legacy = await supabase
            .from('conversations')
            .select(CONVERSATION_COLUMNS_LEGACY)
            .eq('id', conversationId)
            .maybeSingle();
          if (legacy.error) {
            setError(friendlyError(legacy.error));
            return;
          }
          conv = toConversation(legacy.data);
          createdOk = false;
        } else {
          conv = toConversation(primary.data);
        }

        setConversation(conv);
        setCreatedAtAvailable(createdOk);
        setNameDraft(conv?.name ?? '');

        // 2) conversation_participants — role/can_post/muted if present
        let participants: ParticipantRow[] = [];
        let activeColumns: ParticipantColumns = { role: false, can_post: false, muted: false };
        let lastError: string | null = null;

        for (const candidate of PARTICIPANT_FALLBACKS) {
          const res = await supabase
            .from('conversation_participants')
            .select(candidate.select)
            .eq('conversation_id', conversationId);

          if (!res.error) {
            participants = asArray(res.data)
              .map(toParticipant)
              .filter((row): row is ParticipantRow => row !== null);
            activeColumns = candidate.columns;
            lastError = null;
            break;
          }
          lastError = res.error.message;
        }

        if (lastError) {
          setError(lastError);
          setMembers([]);
          return;
        }

        setColumns(activeColumns);

        // 3) profiles — a SEPARATE .in('id', userIds) query. No embed name
        //    is guessed, so this keeps working whatever the FK is called.
        const userIds = participants.map((p) => p.user_id);
        const profileById = new Map<string, ProfileRow>();

        if (userIds.length > 0) {
          const res = await supabase.from('profiles').select(PROFILES_COLUMNS).in('id', userIds);
          if (res.error) {
            setError(friendlyError(res.error));
            return;
          }
          asArray(res.data)
            .map(toProfile)
            .forEach((profile) => {
              if (profile) profileById.set(profile.id, profile);
            });
        }

        const composed: MemberRow[] = participants.map((p) => {
          const profile = profileById.get(p.user_id) ?? null;
          return {
            user_id: p.user_id,
            role: activeColumns.role ? p.role : null,
            can_post: activeColumns.can_post ? p.can_post : null,
            muted: activeColumns.muted ? p.muted : null,
            username: profile?.username ?? 'Member',
            avatarUrl: profile?.avatar_url ?? null,
            verified: profile?.verified === true,
            isSelf: p.user_id === userId,
          };
        });

        // Admins first, then alphabetical — matches every chat app.
        composed.sort((a, b) => {
          const rank = Number(isAdminRole(b.role)) - Number(isAdminRole(a.role));
          if (rank !== 0) return rank;
          return a.username.localeCompare(b.username);
        });

        setMembers(composed);
      } catch (e) {
        setError(errorMessage(e, 'Could not load this group.'));
      } finally {
        setLoading(false);
      }
    },
    [conversationId]
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // ── Derived ───────────────────────────────────────────────

  const selfMember = useMemo(() => members.find((m) => m.isSelf) ?? null, [members]);
  const iAmAdmin = isAdminRole(selfMember?.role ?? null);
  const memberCount = members.length;
  const createdLabel = createdAtAvailable ? formatCreated(conversation?.created_at ?? null) : null;
  const groupName = conversation?.name?.trim() || 'Group';

  // The invite section is permanently disabled: no invite_code /
  // join_code column exists in schema.sql or any of the 55 migrations.
  const inviteCode: string | null = null;
  const inviteDisabledNote = 'Invite links are unavailable — conversations needs an invite_code column.';

  const headerNote = useMemo(() => {
    const missing: string[] = [];
    if (!columns.role) missing.push('role');
    if (!columns.can_post) missing.push('can_post');
    if (!columns.muted) missing.push('muted');
    if (missing.length === 0) return null;
    return `Unavailable column(s) on conversation_participants: ${missing.join(', ')} — related controls are disabled.`;
  }, [columns]);

  // ── Writes ────────────────────────────────────────────────

  const setMuted = async (next: boolean) => {
    if (!me || muteBusy) return;
    setMuteBusy(true);
    setError(null);
    try {
      // Own row only: conversation_id + user_id both pinned.
      const res = await supabase
        .from('conversation_participants')
        .update({ muted: next })
        .eq('conversation_id', conversationId)
        .eq('user_id', me);

      if (res.error) {
        setError(friendlyError(res.error));
        return;
      }
      setMembers((prev) => prev.map((m) => (m.isSelf ? { ...m, muted: next } : m)));
    } catch (e) {
      setError(errorMessage(e, 'Could not update notification settings.'));
    } finally {
      setMuteBusy(false);
    }
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (next.length === 0) {
      setError('A group name cannot be empty.');
      return;
    }
    setBusyKey('name');
    setError(null);
    try {
      const res = await supabase
        .from('conversations')
        .update({ name: next.slice(0, NAME_MAX) })
        .eq('id', conversationId);
      if (res.error) {
        setError(friendlyError(res.error));
        return;
      }
      setConversation((prev) => (prev ? { ...prev, name: next.slice(0, NAME_MAX) } : prev));
      setEditingName(false);
    } catch (e) {
      setError(errorMessage(e, 'Could not rename this group.'));
    } finally {
      setBusyKey(null);
    }
  };

  const pickGroupPhoto = async () => {
    if (photoBusy) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError('Allow photo access to change the group photo.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      const asset = res.assets[0];

      setPhotoBusy(true);
      setError(null);

      // uploadMedia(path, uri, mimeType, upsert = false) → public URL
      // Owner-scoped: a chat/<convId>/ path carries no owner, so the
      // storage policy would refuse it. See 20261023_01 §4.
      const { data: authData } = await supabase.auth.getUser();
      const uploaderId = authData.user?.id;
      if (!uploaderId) throw new Error('Not signed in');
      const publicUrl = await uploadMedia(
        `group-avatars/${uploaderId}/group-${Date.now()}.jpg`,
        asset.uri,
        asset.mimeType ?? 'image/jpeg'
      );

      const update = await supabase
        .from('conversations')
        .update({ avatar_url: publicUrl })
        .eq('id', conversationId);

      if (update.error) {
        setError(friendlyError(update.error));
        return;
      }
      setConversation((prev) => (prev ? { ...prev, avatar_url: publicUrl } : prev));
    } catch (e) {
      setError(errorMessage(e, 'Could not update the group photo.'));
    } finally {
      setPhotoBusy(false);
    }
  };

  const changeRole = async (member: MemberRow, role: 'admin' | 'member') => {
    setActionMember(null);
    setBusyKey(`role:${member.user_id}`);
    setError(null);
    try {
      const res = await supabase
        .from('conversation_participants')
        .update({ role })
        .eq('conversation_id', conversationId)
        .eq('user_id', member.user_id);

      if (res.error) {
        setError(friendlyError(res.error));
        return;
      }
      setMembers((prev) =>
        prev.map((m) => (m.user_id === member.user_id ? { ...m, role } : m))
      );
    } catch (e) {
      setError(errorMessage(e, 'Could not change that role.'));
    } finally {
      setBusyKey(null);
    }
  };

  const removeParticipant = async (member: MemberRow) => {
    setActionMember(null);
    setBusyKey(`remove:${member.user_id}`);
    setError(null);
    try {
      const res = await supabase
        .from('conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', member.user_id);

      if (res.error) {
        setError(friendlyError(res.error));
        return;
      }
      setMembers((prev) => prev.filter((m) => m.user_id !== member.user_id));
    } catch (e) {
      setError(errorMessage(e, 'Could not remove that member.'));
    } finally {
      setBusyKey(null);
    }
  };

  const leaveGroup = async () => {
    if (!me) return;
    setBusyKey('leave');
    setError(null);
    try {
      // Own participant row only — never anyone else's.
      const res = await supabase
        .from('conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', me);

      if (res.error) {
        setError(friendlyError(res.error));
        setConfirmLeave(false);
        return;
      }
      onBack();
    } catch (e) {
      setError(errorMessage(e, 'Could not leave this group.'));
      setConfirmLeave(false);
    } finally {
      setBusyKey(null);
    }
  };

  // ── Render ────────────────────────────────────────────────

  const renderMemberRow = (member: MemberRow) => {
    const manageable = iAmAdmin && !member.isSelf && columns.role;
    const body = (
      <>
        <Avatar url={member.avatarUrl} name={member.username} size={44} verified={member.verified} />
        <View style={styles.memberBody}>
          <View style={styles.memberNameRow}>
            <Text style={styles.memberName} numberOfLines={1}>
              {member.username}
              {member.isSelf ? ' (you)' : ''}
            </Text>
            {member.verified ? <VerifiedBadge size={13} /> : null}
          </View>
          <View style={styles.chipRow}>
            <View style={[styles.roleChip, isAdminRole(member.role) && styles.roleChipAdmin]}>
              <Text style={[styles.roleChipText, isAdminRole(member.role) && styles.roleChipTextAdmin]}>
                {roleLabel(member.role)}
              </Text>
            </View>
            {columns.can_post && member.can_post === false ? (
              <View style={styles.mutedChip}>
                <Text style={styles.mutedChipText}>Read-only</Text>
              </View>
            ) : null}
            {columns.muted && member.muted === true ? (
              <View style={styles.mutedChip}>
                <Ionicons name="notifications-off-outline" size={11} color={colors.textFaint} />
                <Text style={styles.mutedChipText}>Muted</Text>
              </View>
            ) : null}
          </View>
        </View>
        {busyKey === `role:${member.user_id}` || busyKey === `remove:${member.user_id}` ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : manageable ? (
          <Ionicons name="ellipsis-horizontal" size={16} color={colors.textFaint} />
        ) : null}
      </>
    );

    if (!manageable) {
      return (
        <View key={member.user_id} style={styles.memberRow} accessible accessibilityLabel={`${member.username}, ${roleLabel(member.role)}`}>
          {body}
        </View>
      );
    }

    return (
      <Pressable
        key={member.user_id}
        onPress={() => setActionMember(member)}
        style={({ pressed }) => [styles.memberRow, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`Manage ${member.username}, ${roleLabel(member.role)}`}
      >
        {body}
      </Pressable>
    );
  };

  return (
    <View style={styles.screen}>
      {/* ── Header ─────────────────────────────────────────── */}
      <View style={[styles.header, { paddingTop: TOP_INSET + spacing.sm }]}>
        <Pressable
          onPress={onBack}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Group info
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* ── Dismissible error bar ──────────────────────────── */}
      {error ? (
        <View style={styles.errorBar} accessibilityRole="alert">
          <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => setError(null)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
          >
            <Ionicons name="close" size={16} color={colors.danger} />
          </Pressable>
        </View>
      ) : null}

      {/* ── Report bar: missing columns / missing invite_code ─ */}
      {notice ? (
        <View style={styles.noticeBar} accessibilityRole="alert">
          <Ionicons name="information-circle-outline" size={16} color={colors.accent} />
          <Text style={styles.noticeText}>{notice}</Text>
          <Pressable
            onPress={() => setNotice(null)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Dismiss note"
          >
            <Ionicons name="close" size={16} color={colors.accent} />
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.stateBlock}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* ── 1) Group header block ─────────────────────── */}
          <View style={styles.card}>
            <View style={styles.identity}>
              <Pressable
                onPress={() => void pickGroupPhoto()}
                disabled={photoBusy}
                style={styles.avatarButton}
                accessibilityRole="button"
                accessibilityLabel="Edit group photo"
              >
                <Avatar url={conversation?.avatar_url ?? null} name={groupName} size={88} ring />
                <View style={styles.avatarEditBadge}>
                  {photoBusy ? (
                    <ActivityIndicator color={colors.text} size="small" />
                  ) : (
                    <Ionicons name="camera" size={13} color={colors.text} />
                  )}
                </View>
              </Pressable>

              {editingName ? (
                <View style={styles.nameEditor}>
                  <TextInput
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    maxLength={NAME_MAX}
                    autoFocus
                    placeholder="Group name"
                    placeholderTextColor={colors.textFaint}
                    style={styles.nameInput}
                    accessibilityLabel="Group name"
                  />
                  <Pressable
                    onPress={() => void saveName()}
                    disabled={busyKey === 'name'}
                    style={styles.primaryButton}
                    accessibilityRole="button"
                    accessibilityLabel="Save group name"
                  >
                    {busyKey === 'name' ? (
                      <ActivityIndicator color={colors.bg} size="small" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Save</Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setEditingName(false);
                      setNameDraft(conversation?.name ?? '');
                    }}
                    style={styles.ghostButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel renaming"
                  >
                    <Text style={styles.ghostButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <Text style={styles.groupName} numberOfLines={2}>
                    {groupName}
                  </Text>
                  <Text style={styles.groupMeta}>
                    {memberCount} {memberCount === 1 ? 'member' : 'members'}
                    {conversation?.type === 'group' ? ' · Group' : ''}
                  </Text>
                  {createdLabel ? <Text style={styles.groupMetaFaint}>{createdLabel}</Text> : null}

                  <View style={styles.editActions}>
                    <Pressable
                      onPress={() => {
                        setNameDraft(conversation?.name ?? '');
                        setEditingName(true);
                      }}
                      style={styles.ghostButton}
                      accessibilityRole="button"
                      accessibilityLabel="Edit group name"
                    >
                      <Ionicons name="create-outline" size={14} color={colors.text} />
                      <Text style={styles.ghostButtonText}>Edit name</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void pickGroupPhoto()}
                      disabled={photoBusy}
                      style={styles.ghostButton}
                      accessibilityRole="button"
                      accessibilityLabel="Edit group photo"
                    >
                      <Ionicons name="image-outline" size={14} color={colors.text} />
                      <Text style={styles.ghostButtonText}>Edit photo</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </View>

          {/* ── 2) Invite link (DISABLED — no invite_code column) ── */}
          <Text style={styles.sectionLabel}>Invite</Text>
          <View style={styles.card}>
            <View style={styles.staticRow}>
              <View style={[styles.iconBadge, styles.iconBadgeDisabled]}>
                <Ionicons name="link-outline" size={17} color={colors.textFaint} />
              </View>
              <View style={styles.staticRowBody}>
                <Text style={styles.rowTitleDisabled}>Invite link</Text>
                <Text style={styles.rowSubtitle}>{inviteDisabledNote}</Text>
                {inviteCode ? <Text style={styles.inviteCode}>{inviteCode}</Text> : null}
              </View>
              <View style={styles.disabledPill}>
                <Text style={styles.disabledPillText}>Disabled</Text>
              </View>
            </View>
          </View>

          {/* ── 3) Members ────────────────────────────────── */}
          <Text style={styles.sectionLabel}>
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </Text>
          <View style={styles.card}>
            {iAmAdmin && columns.role ? (
              <Text style={styles.cardHint}>Tap a member to promote, dismiss or remove them.</Text>
            ) : null}
            {members.length === 0 ? (
              <Text style={styles.emptyText}>No members to show.</Text>
            ) : (
              members.map((member, index) => (
                <View key={member.user_id}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  {renderMemberRow(member)}
                </View>
              ))
            )}
          </View>

          {/* ── 4) Add members ────────────────────────────── */}
          <View style={styles.card}>
            <Pressable
              onPress={() => setAddOpen(true)}
              style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel="Add members to this group"
            >
              <View style={styles.iconBadge}>
                <Ionicons name="person-add-outline" size={17} color={colors.accent} />
              </View>
              <View style={styles.staticRowBody}>
                <Text style={styles.rowTitle}>Add members</Text>
                <Text style={styles.rowSubtitle}>Invite people into this group</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
            </Pressable>
          </View>

          {/* ── 5) Mute notifications ─────────────────────── */}
          <Text style={styles.sectionLabel}>Notifications</Text>
          <View style={styles.card}>
            <View style={styles.staticRow}>
              <View style={styles.iconBadge}>
                <Ionicons name="notifications-outline" size={17} color={colors.accent} />
              </View>
              <View style={styles.staticRowBody}>
                <Text style={styles.rowTitle}>Mute notifications</Text>
                <Text style={styles.rowSubtitle}>
                  {columns.muted ? 'Only affects your own membership.' : 'Needs a muted column on conversation_participants.'}
                </Text>
              </View>
              <Switch
                value={selfMember?.muted === true}
                onValueChange={(next) => void setMuted(next)}
                disabled={!columns.muted || muteBusy}
                trackColor={{ false: colors.surfaceAlt, true: colors.accentGlow }}
                thumbColor={selfMember?.muted ? colors.accent : colors.textMuted}
                accessibilityLabel="Mute notifications for this group"
                accessibilityRole="switch"
                accessibilityState={{ checked: selfMember?.muted === true, disabled: !columns.muted }}
              />
            </View>
          </View>

          {/* ── 6) Leave group (two-step confirm) ─────────── */}
          <Text style={styles.sectionLabel}>Danger zone</Text>
          <View style={styles.card}>
            {confirmLeave ? (
              <View style={styles.confirmBlock}>
                <Text style={styles.confirmText}>
                  Leave “{groupName}”? This removes only your membership.
                </Text>
                <View style={styles.confirmActions}>
                  <Pressable
                    onPress={() => setConfirmLeave(false)}
                    style={styles.ghostButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel leaving the group"
                  >
                    <Text style={styles.ghostButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void leaveGroup()}
                    disabled={busyKey === 'leave'}
                    style={styles.dangerButton}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm leaving the group"
                  >
                    {busyKey === 'leave' ? (
                      <ActivityIndicator color={colors.text} size="small" />
                    ) : (
                      <Text style={styles.dangerButtonText}>Leave</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => setConfirmLeave(true)}
                style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel="Leave group"
              >
                <View style={styles.iconBadgeDanger}>
                  <Ionicons name="exit-outline" size={17} color={colors.danger} />
                </View>
                <View style={styles.staticRowBody}>
                  <Text style={styles.rowTitleDanger}>Leave group</Text>
                  <Text style={styles.rowSubtitle}>Removes you from this group</Text>
                </View>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}

      {/* ── Member action sheet ──────────────────────────── */}
      <Modal
        visible={actionMember !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setActionMember(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setActionMember(null)}
          accessibilityRole="button"
          accessibilityLabel="Close member actions"
        >
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {actionMember?.username ?? ''}
            </Text>
            {actionMember && !isAdminRole(actionMember.role) ? (
              <Pressable
                onPress={() => void changeRole(actionMember, 'admin')}
                style={({ pressed }) => [styles.sheetAction, pressed && styles.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Promote ${actionMember.username} to admin`}
              >
                <Ionicons name="shield-checkmark-outline" size={18} color={colors.text} />
                <Text style={styles.sheetActionText}>Promote to admin</Text>
              </Pressable>
            ) : null}
            {actionMember && isAdminRole(actionMember.role) ? (
              <Pressable
                onPress={() => void changeRole(actionMember, 'member')}
                style={({ pressed }) => [styles.sheetAction, pressed && styles.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Dismiss ${actionMember.username} as admin`}
              >
                <Ionicons name="shield-outline" size={18} color={colors.text} />
                <Text style={styles.sheetActionText}>Dismiss as admin</Text>
              </Pressable>
            ) : null}
            {actionMember ? (
              <Pressable
                onPress={() => void removeParticipant(actionMember)}
                style={({ pressed }) => [styles.sheetAction, pressed && styles.rowPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${actionMember.username} from the group`}
              >
                <Ionicons name="person-remove-outline" size={18} color={colors.danger} />
                <Text style={styles.sheetActionDanger}>Remove from group</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Modal>

      {/* ── Add members sheet ────────────────────────────── */}
      <AddMembersSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        conversationId={conversationId}
        existingMemberIds={members.map((m) => m.user_id)}
        onAdded={() => {
          void load('refresh');
        }}
      />
    </View>
  );
}

// ------------------------------------------------------------
// Styles — tokens from src/theme.ts only, dark theme only
// ------------------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  headerTitle: {
    ...type.title,
    color: colors.text,
    flex: 1,
  },
  headerSpacer: {
    width: 34,
  },

  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: {
    ...type.caption,
    color: colors.danger,
    flex: 1,
  },
  noticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentGlow,
  },
  noticeText: {
    ...type.caption,
    color: colors.accent,
    flex: 1,
  },

  content: {
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  stateBlock: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
  },

  sectionLabel: {
    ...type.micro,
    color: colors.textFaint,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  card: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  cardHint: {
    ...type.caption,
    color: colors.textFaint,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
  },

  identity: {
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.xs,
  },
  avatarButton: {
    marginBottom: spacing.sm,
  },
  avatarEditBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentStrong,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  groupName: {
    ...type.title,
    color: colors.text,
    textAlign: 'center',
  },
  groupMeta: {
    ...type.caption,
    color: colors.textMuted,
  },
  groupMetaFaint: {
    ...type.caption,
    color: colors.textFaint,
  },
  editActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  nameEditor: {
    width: '100%',
    marginTop: spacing.sm,
    gap: spacing.sm,
    alignItems: 'center',
  },
  nameInput: {
    width: '100%',
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },

  primaryButton: {
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...type.caption,
    color: colors.bg,
    fontWeight: '700',
  },
  ghostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostButtonText: {
    ...type.caption,
    color: colors.text,
  },
  dangerButton: {
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerButtonText: {
    ...type.caption,
    color: colors.text,
    fontWeight: '700',
  },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  staticRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  staticRowBody: {
    flex: 1,
    gap: 2,
  },
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconBadgeDisabled: {
    backgroundColor: colors.surfaceAlt,
  },
  iconBadgeDanger: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  rowTitle: {
    ...type.heading,
    color: colors.text,
  },
  rowTitleDisabled: {
    ...type.heading,
    color: colors.textFaint,
  },
  rowTitleDanger: {
    ...type.heading,
    color: colors.danger,
  },
  rowSubtitle: {
    ...type.caption,
    color: colors.textMuted,
  },
  inviteCode: {
    ...type.caption,
    color: colors.accent,
  },
  disabledPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  disabledPillText: {
    ...type.micro,
    color: colors.textFaint,
  },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  memberBody: {
    flex: 1,
    gap: 4,
  },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    ...type.heading,
    color: colors.text,
    flexShrink: 1,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  roleChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleChipAdmin: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentGlow,
  },
  roleChipText: {
    ...type.micro,
    color: colors.textMuted,
  },
  roleChipTextAdmin: {
    color: colors.accent,
  },
  mutedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  mutedChipText: {
    ...type.micro,
    color: colors.textFaint,
  },
  emptyText: {
    ...type.body,
    color: colors.textMuted,
    padding: spacing.lg,
    textAlign: 'center',
  },

  confirmBlock: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  confirmText: {
    ...type.body,
    color: colors.text,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },

  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: spacing.xl,
    paddingTop: spacing.sm,
  },
  sheetTitle: {
    ...type.heading,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sheetAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sheetActionText: {
    ...type.body,
    color: colors.text,
  },
  sheetActionDanger: {
    ...type.body,
    color: colors.danger,
  },
});
