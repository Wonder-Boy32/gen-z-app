import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import ChatThread from './ChatThread';
import AnonymousInboxScreen from './AnonymousInboxScreen';
import { colors, radius } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import LogoHeader from '../components/LogoHeader';
import Button from '../components/Button';
import NewChatModal from '../components/NewChatModal';
import Avatar from '../components/Avatar';

type Conv = {
  id: string;
  type: string;
  name: string | null;
  other: { id: string; username: string; avatar_url: string | null; last_seen_at: string | null } | null;
  lastMessage: string | null;
  lastType: string;
  lastTime: string | null;
  unread: number;
  members: number;
};

type ActiveUser = { id: string; username: string; avatar_url: string | null; following: boolean };

const FILTERS: { key: 'all' | 'unread' | 'requests' | 'drops'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'requests', label: 'Requests' },
  { key: 'drops', label: 'Drops' },
];

export default function ChatsScreen({
  onOpenUser,
  onOpenCreate,
  onPostToFeed,
}: {
  onOpenUser?: (userId: string) => void;
  onOpenCreate?: () => void;
  onPostToFeed?: (uri: string) => void;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [anonOpen, setAnonOpen] = useState(false);

  if (anonOpen) {
    return (
      <AnonymousInboxScreen
        onBack={() => setAnonOpen(false)}
        onReplyWithDrop={onOpenCreate}
        onPostToFeed={onPostToFeed}
      />
    );
  }
  if (conversationId) {
    return <ChatThread conversationId={conversationId} onBack={() => setConversationId(null)} />;
  }
  return (
    <ConversationList
      onOpen={setConversationId}
      onOpenUser={onOpenUser}
      onOpenAnon={() => setAnonOpen(true)}
    />
  );
}

function ConversationList({
  onOpen,
  onOpenUser,
  onOpenAnon,
}: {
  onOpen: (id: string) => void;
  onOpenUser?: (userId: string) => void;
  onOpenAnon: () => void;
}) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupModal, setGroupModal] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'requests' | 'drops'>('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  const followingRef = useRef<Set<string>>(new Set());
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;
    const me = user?.id;
    if (!me) {
      setLoading(false);
      return;
    }

    const { data: parts } = await supabase
      .from('conversation_participants')
      .select('conversation_id, last_read_at, conversation:conversations(id, type, name)')
      .eq('user_id', me);
    const rows = (parts ?? []) as any[];
    if (!rows.length) {
      setConvs([]);
      setLoading(false);
      return;
    }

    const ids = rows.map((p) => p.conversation_id);

    const [{ data: others }, { data: msgs }, { data: fws }, { data: activePosts }] = await Promise.all([
      supabase
        .from('conversation_participants')
        .select('conversation_id, user_id, profile:profiles(username, avatar_url, last_seen_at)')
        .in('conversation_id', ids)
        .neq('user_id', me),
      supabase
        .from('messages')
        .select('conversation_id, content, msg_type, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('follows').select('following_id').eq('follower_id', me).eq('status', 'accepted'),
      supabase
        .from('posts')
        .select('user_id, profile:profiles!posts_user_id_fkey(id, username, avatar_url)')
        .gt('expires_at', new Date().toISOString())
        .is('parent_drop_id', null)
        .order('created_at', { ascending: false })
        .limit(60),
    ]);
    followingRef.current = new Set((fws ?? []).map((f: any) => f.following_id));

    // 🔥 Active Drops — distinct recent droppers (real active content only)
    const seenU = new Set<string>();
    const droppers: ActiveUser[] = [];
    ((activePosts ?? []) as any[]).forEach((p: any) => {
      if (!p.user_id || p.user_id === me || seenU.has(p.user_id)) return;
      seenU.add(p.user_id);
      droppers.push({
        id: p.user_id,
        username: p.profile?.username ?? 'unknown',
        avatar_url: p.profile?.avatar_url ?? null,
        following: followingRef.current.has(p.user_id),
      });
    });
    setActiveUsers(droppers.slice(0, 12));

    const memberCount = new Map<string, number>();
    (others ?? []).forEach((o: any) => {
      memberCount.set(o.conversation_id, (memberCount.get(o.conversation_id) ?? 0) + 1);
    });

    const otherByConv = new Map<string, { id: string; username: string; avatar_url: string | null; last_seen_at: string | null }>();
    (others ?? []).forEach((o: any) => {
      if (!otherByConv.has(o.conversation_id)) {
        otherByConv.set(o.conversation_id, {
          id: o.user_id,
          username: o.profile?.username ?? 'unknown',
          avatar_url: o.profile?.avatar_url ?? null,
          last_seen_at: o.profile?.last_seen_at ?? null,
        });
      }
    });

    const readAt = new Map<string, number>();
    rows.forEach((r) => readAt.set(r.conversation_id, r.last_read_at ? new Date(r.last_read_at).getTime() : 0));

    const lastByConv = new Map<string, { content: string | null; msg_type: string; created_at: string }>();
    const unreadByConv = new Map<string, number>();
    (msgs ?? []).forEach((m: any) => {
      if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
      if (new Date(m.created_at).getTime() > (readAt.get(m.conversation_id) ?? 0)) {
        unreadByConv.set(m.conversation_id, (unreadByConv.get(m.conversation_id) ?? 0) + 1);
      }
    });

    setConvs(
      rows.map((r) => {
        const conv = r.conversation ?? { type: 'direct', name: null };
        const last = lastByConv.get(r.conversation_id);
        return {
          id: r.conversation_id,
          type: conv.type ?? 'direct',
          name: conv.name ?? null,
          other: otherByConv.get(r.conversation_id) ?? null,
          lastMessage: last ? previewOf(last) : null,
          lastType: last?.msg_type ?? 'text',
          lastTime: last ? fmtTime(last.created_at) : null,
          unread: unreadByConv.get(r.conversation_id) ?? 0,
          members: (memberCount.get(r.conversation_id) ?? 0) + 1,
        };
      })
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // live updates
  useEffect(() => {
    const channel = supabase
      .channel('chats:list2')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => load())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_participants' }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const openOrCreate = async (otherId: string) => {
    const me = myIdRef.current;
    if (!me || me === otherId) return;

    const { data: mine } = await supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', me);
    const ids = (mine ?? []).map((p) => p.conversation_id);

    if (ids.length) {
      const { data: existing } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .in('conversation_id', ids)
        .eq('user_id', otherId);
      if (existing?.length) {
        onOpen(existing[0].conversation_id);
        setNewChatOpen(false);
        return;
      }
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .insert({ type: 'direct' })
      .select('id')
      .single();
    if (!conv) {
      console.warn('conversation create failed', convErr?.message);
      return;
    }
    const { error: p1 } = await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: me });
    const { error: p2 } = await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: otherId });
    if (p1 || p2) console.warn('participant insert failed', p1?.message ?? p2?.message);

    onOpen(conv.id);
    setNewChatOpen(false);
  };

  const createGroup = async (name: string, memberIds: string[]) => {
    const me = myIdRef.current;
    if (!me || !name.trim() || !memberIds.length) return;
    const { data: conv } = await supabase
      .from('conversations')
      .insert({ type: 'group', name: name.trim(), created_by: me })
      .select('id')
      .single();
    if (!conv) return;
    await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: me });
    for (const uid of memberIds) {
      await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: uid });
    }
    setGroupModal(false);
    onOpen(conv.id);
  };

  const shown = convs.filter((c) => {
    if (filter === 'unread' && c.unread === 0) return false;
    if (filter === 'requests' && !(c.type === 'direct' && c.other && !followingRef.current.has(c.other.id) && c.unread > 0))
      return false;
    if (filter === 'drops' && c.lastType !== 'drop') return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const name = c.type === 'group' ? (c.name ?? '') : (c.other?.username ?? '');
      if (!name.toLowerCase().includes(q) && !(c.lastMessage ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <LogoHeader />
        <Pressable style={styles.headerIconBtn} onPress={() => setSearchOpen((v) => !v)} hitSlop={6}>
          <Icon name="search" size={18} color={colors.text} />
        </Pressable>
        <Pressable style={styles.headerIconBtn} onPress={() => setNewChatOpen(true)} hitSlop={6}>
          <Icon name="add" size={19} color={colors.accent} />
        </Pressable>
        <Pressable style={styles.headerIconBtn} onPress={() => setGroupModal(true)} hitSlop={6}>
          <Icon name="people" size={17} color={colors.text} />
        </Pressable>
      </View>

      {searchOpen && (
        <View style={styles.searchWrap}>
          <Icon name="search" size={15} color={colors.textMuted} />
          <TextInput
            style={styles.chatSearchInput}
            placeholder="Search chats, messages, drops..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
            autoFocus
          />
        </View>
      )}

      <View style={styles.tabsRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.tabChip, filter === f.key && styles.tabChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.tabChipText, filter === f.key && styles.tabChipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <Pressable style={styles.convRow} onPress={() => onOpen(item.id)}>
              <View style={styles.avatarWrap}>
                <Avatar
                  url={item.type === 'group' ? null : item.other?.avatar_url}
                  name={item.type === 'group' ? item.name ?? 'G' : item.other?.username ?? 'G'}
                  size={44}
                  ring
                />
                {item.type === 'direct' && item.other && isOnline(item.other.last_seen_at) && (
                  <View style={styles.onlineDot} />
                )}
              </View>
              <View style={styles.convInfo}>
                <Text style={styles.convName} numberOfLines={1}>
                  {item.type === 'group' ? item.name ?? 'Group' : `@${item.other?.username ?? 'unknown'}`}
                </Text>
                <Text style={styles.convPreview} numberOfLines={1}>
                  {item.lastMessage ?? (item.type === 'group' ? 'Group created' : 'Say hi')}
                </Text>
              </View>
              <View style={styles.rightCol}>
                {!!item.lastTime && <Text style={styles.convTime}>{item.lastTime}</Text>}
                {item.unread > 0 && (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadText}>{item.unread > 99 ? '99+' : item.unread}</Text>
                  </View>
                )}
              </View>
            </Pressable>
          )}
          ListHeaderComponent={
            <>
              {activeUsers.length > 0 && (
                <View style={styles.activeSection}>
                  <Text style={styles.sectionLabel}>🔥 Active Drops</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.activeRow}>
                    {activeUsers.map((u) => (
                      <Pressable
                        key={u.id}
                        style={styles.activeItem}
                        onPress={() => onOpenUser?.(u.id)}
                      >
                        <View style={[styles.activeRing, u.following && styles.activeRingFollowed]}>
                          <Avatar url={u.avatar_url} name={u.username} size={46} />
                        </View>
                        <Text style={styles.activeName} numberOfLines={1}>
                          @{u.username}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}

              <Pressable style={styles.anonCard} onPress={onOpenAnon}>
                <View style={styles.anonIcon}>
                  <Icon name="eye-off-outline" size={18} color={colors.accent} />
                </View>
                <View style={styles.anonInfo}>
                  <Text style={styles.anonTitle}>🕵️ Anonymous Inbox</Text>
                  <Text style={styles.anonSub}>Messages without names — see who's curious 👀</Text>
                </View>
                <Icon name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>
            </>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {search.trim() || filter !== 'all' ? 'Nothing here.' : 'No chats yet. Start one — or create a group.'}
            </Text>
          }
        />
      )}

      <NewGroupModal
        visible={groupModal}
        onClose={() => setGroupModal(false)}
        onCreate={createGroup}
      />

      <NewChatModal
        visible={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        onOpen={openOrCreate}
      />
    </View>
  );
}

function previewOf(m: { content: string | null; msg_type: string }): string {
  if (m.msg_type === 'drop') return '🔥 [Drop]';
  if (m.content) return m.content;
  switch (m.msg_type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎬 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'gif':
      return 'GIF';
    default:
      return '';
  }
}

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function NewGroupModal({
  visible,
  onClose,
  onCreate,
}: {
  visible: boolean;
  onClose: () => void;
  onCreate: (name: string, memberIds: string[]) => void;
}) {
  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<{ id: string; username: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setName('');
    setSelected(new Set());
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      // follows has TWO FKs to profiles — embedding profile:profiles() is
      // ambiguous and returns zero rows; fetch the two queries separately
      const { data } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id)
        .eq('status', 'accepted')
        .limit(100);
      const ids = ((data ?? []) as { following_id: string }[]).map((f) => f.following_id);
      let names = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, username')
          .in('id', ids)
          .limit(100);
        names = new Map(((profs ?? []) as { id: string; username: string }[]).map((p) => [p.id, p.username]));
      }
      setCandidates(ids.map((id) => ({ id, username: names.get(id) ?? 'unknown' })));
    })();
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>New group</Text>
          <TextInput
            style={styles.modalInput}
            placeholder="Group name"
            placeholderTextColor={colors.textFaint}
            value={name}
            onChangeText={setName}
          />
          <Text style={styles.modalHint}>Pick members (people you follow)</Text>
          <View style={styles.memberWrap}>
            {candidates.map((c) => {
              const active = selected.has(c.id);
              return (
                <Pressable
                  key={c.id}
                  style={[styles.memberChip, active && styles.memberChipActive]}
                  onPress={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    })
                  }
                >
                  <Text style={[styles.memberChipText, active && styles.memberChipTextActive]}>
                    @{c.username}
                  </Text>
                </Pressable>
              );
            })}
            {!candidates.length && <Text style={styles.modalHint}>Follow some people first to add them to a group.</Text>}
          </View>
          <Button
            title="Create group"
            onPress={() => onCreate(name, [...selected])}
            disabled={!name.trim() || selected.size === 0}
          />
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
  header: {
    position: 'relative',
    alignItems: 'center',
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
  },
  newBtn: {
    position: 'absolute',
    right: 16,
    top: 52,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  newGroupBtn: {
    right: 'auto',
    left: 16,
  },
  newBtnText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  searchBox: {
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  searchInput: {
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  resultRow: {
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  resultText: {
    color: colors.text,
    fontSize: 14,
  },
  noResults: {
    color: colors.textMuted,
    fontSize: 13,
    paddingVertical: 10,
    textAlign: 'center',
  },
  loader: {
    flex: 1,
  },
  convRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  avatarWrap: {
    position: 'relative',
  },
  avatarText: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '600',
  },
  onlineDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.success,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  convInfo: {
    flex: 1,
    marginLeft: 12,
  },
  convName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  convPreview: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  rightCol: {
    alignItems: 'flex-end',
  },
  convTime: {
    color: colors.textFaint,
    fontSize: 12,
  },
  unreadBadge: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    marginTop: 5,
  },
  unreadText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '800',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 60,
    paddingHorizontal: 40,
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
    marginBottom: 14,
    textAlign: 'center',
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
  modalHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 8,
  },
  memberWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  memberChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
    margin: 3,
  },
  memberChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  memberChipText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  memberChipTextActive: {
    color: colors.bg,
  },
  modalCancel: {
    alignItems: 'center',
    marginTop: 12,
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  headerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  chatSearchInput: { flex: 1, color: colors.text, fontSize: 13.5, padding: 0 },
  tabsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  tabChipActive: { backgroundColor: colors.accent },
  tabChipText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  tabChipTextActive: { color: colors.bg, fontWeight: '800' },
  activeSection: { marginBottom: 6 },
  sectionLabel: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '900',
    paddingHorizontal: 16,
    marginBottom: 10,
    marginTop: 4,
  },
  activeRow: { paddingHorizontal: 16, gap: 14, paddingBottom: 4 },
  activeItem: { alignItems: 'center', width: 62 },
  activeRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
    padding: 2,
    marginBottom: 4,
  },
  activeRingFollowed: { borderColor: colors.accent },
  activeName: { color: colors.textMuted, fontSize: 10.5, fontWeight: '600', maxWidth: 62 },
  anonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    backgroundColor: 'rgba(255,122,0,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,122,0,0.35)',
    borderRadius: radius.lg,
    padding: 13,
  },
  anonIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,122,0,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  anonInfo: { flex: 1 },
  anonTitle: { color: colors.accent, fontSize: 14, fontWeight: '900' },
  anonSub: { color: colors.textMuted, fontSize: 11.5, marginTop: 2 },
});
