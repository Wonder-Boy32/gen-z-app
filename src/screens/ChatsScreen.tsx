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
import { useAndroidBack } from '../utils/useAndroidBack';
// MESSAGING v2 — switched to the engine-backed ConversationScreen.
// TO REVERT INSTANTLY: point this back at './ChatThread'.
import ConversationScreen from '../components/chat/ConversationScreen';
// MESSAGING v2 screens — message requests (§32), My Saves (§18), privacy centre (§35)
import RequestsScreen from './RequestsScreen';
import SavesScreen from './SavesScreen';
import PrivacyScreen from './PrivacyScreen';
import NotificationSettingsScreen from './NotificationSettingsScreen';
import AnonymousInboxScreen from './AnonymousInboxScreen';
import { colors, radius } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import Button from '../components/Button';
import NewChatModal from '../components/NewChatModal';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import { useSheetPad } from '../utils/useSheetPad';

type Conv = {
  id: string;
  type: string;
  name: string | null;
  other: { id: string; username: string; avatar_url: string | null; last_seen_at: string | null; verified?: boolean } | null;
  lastMessage: string | null;
  lastType: string;
  lastTime: string | null;
  unread: number;
  members: number;
};

type ActiveUser = { id: string; username: string; avatar_url: string | null; following: boolean; verified?: boolean };

const FILTERS: { key: 'all' | 'unread' | 'favorites' | 'groups' | 'requests' | 'drops'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'groups', label: 'Groups' },
  { key: 'requests', label: 'Requests' },
  { key: 'drops', label: 'Drops' },
];

export default function ChatsScreen({
  onOpenUser,
  onOpenCreate,
  onPostToFeed,
  onUnreadChange,
}: {
  onOpenUser?: (userId: string) => void;
  onOpenCreate?: () => void;
  onPostToFeed?: (uri: string) => void;
  onUnreadChange?: (total: number) => void;
}) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [anonOpen, setAnonOpen] = useState(false);

  // Android back: close the open thread or inbox instead of letting the press
  // fall through to Android's default, which finishes the activity and dumps
  // the user out to the launcher.
  //
  // ONE handler covers both screens, because they are alternatives rendered
  // from this same component. Returning false when neither is open lets the
  // press continue outward — HomeScreen then pops to the Feed tab, and only
  // once everything has declined does Android exit the app.
  useAndroidBack(() => {
    if (anonOpen) {
      setAnonOpen(false);
      return true;
    }
    if (conversationId) {
      setConversationId(null);
      return true;
    }
    return false;
  });

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
    return <ConversationScreen conversationId={conversationId} onBack={() => setConversationId(null)} />;
  }
  return (
    <ConversationList
      onOpen={setConversationId}
      onOpenUser={onOpenUser}
      onOpenAnon={() => setAnonOpen(true)}
      onOpenCreate={onOpenCreate}
      onUnreadChange={onUnreadChange}
    />
  );
}

function ConversationList({
  onOpen,
  onOpenUser,
  onOpenAnon,
  onOpenCreate,
  onUnreadChange,
}: {
  onOpen: (id: string) => void;
  onOpenUser?: (userId: string) => void;
  onOpenAnon: () => void;
  onOpenCreate?: () => void;
  onUnreadChange?: (total: number) => void;
}) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [loading, setLoading] = useState(true);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupModal, setGroupModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [savesOpen, setSavesOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'favorites' | 'groups' | 'requests' | 'drops'>('all');
  const [search, setSearch] = useState('');
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  const followingRef = useRef<Set<string>>(new Set());
  const myIdRef = useRef<string | null>(null);
  const [anonUnread, setAnonUnread] = useState(0);

  // unread anonymous messages (read_at null, not expired) — badge on the inbox card
  const loadAnonUnread = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setAnonUnread(0);
      return;
    }
    const { count } = await supabase
      .from('anonymous_messages_public')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', user.id)
      .is('read_at', null)
      .or(`expires_at.is.null,expires_at.gt."${new Date().toISOString()}"`);
    setAnonUnread(count ?? 0);
  }, []);

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
      .select('conversation_id, last_read_at, last_read_seq, conversation:conversations(id, type, name)')
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
        .select('conversation_id, user_id, profile:profiles(username, avatar_url, last_seen_at, verified)')
        .in('conversation_id', ids)
        .neq('user_id', me),
      supabase
        .from('messages')
        .select('conversation_id, sender_id, content, msg_type, created_at, seq')
        .in('conversation_id', ids)
        // A soft-deleted or expired message must never count as unread.
        // Disappearing messages set deleted_at when they expire, so without this
        // they stayed in the unread tally long after the bytes were gone.
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('follows').select('following_id').eq('follower_id', me).eq('status', 'accepted'),
      supabase
        .from('posts')
        .select('user_id, profile:profiles!posts_user_id_fkey(id, username, avatar_url, verified)')
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
        verified: p.profile?.verified ?? false,
      });
    });
    setActiveUsers(droppers.slice(0, 12));

    const memberCount = new Map<string, number>();
    (others ?? []).forEach((o: any) => {
      memberCount.set(o.conversation_id, (memberCount.get(o.conversation_id) ?? 0) + 1);
    });

    const otherByConv = new Map<string, { id: string; username: string; avatar_url: string | null; last_seen_at: string | null; verified?: boolean }>();
    (others ?? []).forEach((o: any) => {
      if (!otherByConv.has(o.conversation_id)) {
        otherByConv.set(o.conversation_id, {
          id: o.user_id,
          username: o.profile?.username ?? 'unknown',
          avatar_url: o.profile?.avatar_url ?? null,
          last_seen_at: o.profile?.last_seen_at ?? null,
          verified: o.profile?.verified ?? false,
        });
      }
    });

    const readAt = new Map<string, number>();
    rows.forEach((r) => readAt.set(r.conversation_id, r.last_read_at ? new Date(r.last_read_at).getTime() : 0));

    // The authoritative read cursor, where it exists.
    //
    // WHY SEQUENCE AND NOT TIME: last_read_at is stamped with the DEVICE clock,
    // while message.created_at is stamped with the DATABASE clock. Comparing two
    // different clocks means that whenever the device runs even slightly behind
    // the server, the newest messages stay permanently "newer than last read" —
    // the badge shows a count that opening the chat can never clear. seq is
    // assigned by the server, so seq-vs-seq is exact and clock-independent.
    //
    // Nullable on purpose: reads recorded by the pre-engine thread only ever
    // wrote last_read_at, so those fall back to the timestamp comparison rather
    // than suddenly flagging every old message as unread.
    const readSeq = new Map<string, number>();
    rows.forEach((r) => {
      if (typeof r.last_read_seq === 'number') readSeq.set(r.conversation_id, r.last_read_seq);
    });

    const lastByConv = new Map<string, { content: string | null; msg_type: string; created_at: string }>();
    const unreadByConv = new Map<string, number>();
    (msgs ?? []).forEach((m: any) => {
      if (!lastByConv.has(m.conversation_id)) lastByConv.set(m.conversation_id, m);
      // only messages from OTHERS count as unread — your own sends never flag yourself
      if (m.sender_id === me) return;

      const cursor = readSeq.get(m.conversation_id);
      const unread =
        cursor !== undefined
          ? typeof m.seq === 'number' && m.seq > cursor
          : new Date(m.created_at).getTime() > (readAt.get(m.conversation_id) ?? 0);

      if (unread) {
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

  // report the TOTAL unread (chat messages + anonymous) up to the tab bar —
  // same data the per-chat badges use, so the nav badge can never disagree.
  useEffect(() => {
    const total = convs.reduce((sum, c) => sum + (c.unread || 0), 0) + (anonUnread || 0);
    onUnreadChange?.(total);
  }, [convs, anonUnread, onUnreadChange]);

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

  // anonymous inbox badge: initial count + live refresh when a new
  // anonymous message arrives (watches notifications — never the base
  // table, whose payload would leak sender_id).
  useEffect(() => {
    let channel: any = null;
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      loadAnonUnread();
      // unique per-user name + remove any stale instance: if a previous mount
      // leaked a channel (async cleanup race), reuse-by-topic would return the
      // subscribed instance and .on() would throw.
      const name = `chats:anon-badge:${user.id}`;
      supabase
        .getChannels()
        .filter((c) => c.topic === `realtime:${name}`)
        .forEach((c) => supabase.removeChannel(c));
      channel = supabase
        .channel(name)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
          () => loadAnonUnread()
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [loadAnonUnread]);

  const openOrCreate = async (otherId: string) => {
    // Re-validate the session server-side: an expired/dead token would make
    // the insert run as anon -> cryptic RLS violation instead of a clean result.
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    const me = user?.id ?? null;
    if (!me) {
      console.warn('[chat] no valid session at create time', authErr?.message ?? 'no user');
      return;
    }
    if (me === otherId) return;

    // Atomic find-or-create via SECURITY DEFINER RPC (bypasses RLS on the
    // conversations/participants tables, so policy state can't break chat).
    const { data: convId, error: convErr } = await supabase.rpc('create_direct_conversation', { p_other: otherId });
    if (convErr || !convId) {
      console.warn('conversation create failed', convErr?.message, convErr?.code, 'uid:', me);
      return;
    }

    onOpen(convId);
    setNewChatOpen(false);
  };

  const createGroup = async (name: string, memberIds: string[]) => {
    const me = myIdRef.current;
    if (!me || !name.trim() || !memberIds.length) return;
    // SECURITY DEFINER RPC — client-side inserts into conversations fail RLS
    // (the same bug direct chats had). One atomic call, creator + members.
    const { data: convId, error } = await supabase.rpc('create_group_conversation', {
      p_name: name.trim(),
      p_members: memberIds,
    });
    if (error || !convId) {
      console.warn('group create failed', error?.message, error?.code, 'uid:', me);
      return;
    }
    setGroupModal(false);
    onOpen(convId);
  };

  const unreadTotal = convs.reduce((sum, c) => sum + (c.unread || 0), 0);

  const shown = convs.filter((c) => {
    if (filter === 'unread' && c.unread === 0) return false;
    if (filter === 'favorites' && !(c.type === 'direct' && c.other && followingRef.current.has(c.other.id))) return false;
    if (filter === 'groups' && c.type !== 'group') return false;
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
        <Text style={styles.headerTitle}>Chats</Text>
        <View style={styles.headerActions}>
          {!!onOpenCreate && (
            <Pressable style={styles.headerIconBtn} onPress={() => onOpenCreate?.()} hitSlop={6}>
              <Icon name="camera-outline" size={20} color={colors.text} />
            </Pressable>
          )}
          <Pressable style={styles.headerIconBtn} onPress={() => setMenuOpen(true)} hitSlop={6}>
            <Icon name="ellipsis-vertical" size={20} color={colors.text} />
          </Pressable>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <Icon name="search" size={15} color={colors.textMuted} />
        <TextInput
          style={styles.chatSearchInput}
          placeholder="Search chats, messages, drops..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.tabsRow}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const label = f.key === 'unread' && unreadTotal > 0 ? `Unread ${unreadTotal}` : f.label;
          return (
            <Pressable
              key={f.key}
              style={[styles.tabChip, active && styles.tabChipActive]}
              onPress={() => setFilter(f.key)}
            >
              <Text style={[styles.tabChipText, active && styles.tabChipTextActive]}>{label}</Text>
            </Pressable>
          );
        })}
        <Pressable style={[styles.tabChip, styles.plusChip]} onPress={() => setNewChatOpen(true)}>
          <Icon name="add" size={16} color={colors.textMuted} />
        </Pressable>
      </ScrollView>

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
                  verified={item.type !== 'group' && !!item.other?.verified}
                />
                {item.type === 'direct' && item.other && isOnline(item.other.last_seen_at) && (
                  <View style={styles.onlineDot} />
                )}
              </View>
              <View style={styles.convInfo}>
                <View style={styles.convNameRow}>
                  <Text style={styles.convName} numberOfLines={1}>
                    {item.type === 'group' ? item.name ?? 'Group' : `@${item.other?.username ?? 'unknown'}`}
                  </Text>
                  {item.type !== 'group' && !!item.other?.verified && (
                    <VerifiedBadge size={12} style={styles.verifiedInline} />
                  )}
                </View>
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
                          <Avatar url={u.avatar_url} name={u.username} size={46} verified={!!(u as any).verified} />
                        </View>
                        <View style={styles.activeNameRow}>
                          <Text style={styles.activeName} numberOfLines={1}>
                            @{u.username}
                          </Text>
                          {!!(u as any).verified && <VerifiedBadge size={11} glow={false} style={styles.verifiedInline} />}
                        </View>
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
                {anonUnread > 0 && (
                  <View style={styles.anonBadge}>
                    <Text style={styles.anonBadgeText}>{anonUnread > 99 ? '99+' : anonUnread}</Text>
                  </View>
                )}
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

      {/* beautiful floating new-chat button */}
      <Pressable style={styles.fab} onPress={() => setNewChatOpen(true)} hitSlop={8} accessibilityLabel="New chat">
        <View style={styles.fabHalo} pointerEvents="none" />
        <Icon name="add" size={30} color={colors.bg} />
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuSheet}>
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setNewChatOpen(true);
              }}
            >
              <Icon name="chatbubble-ellipses-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>New chat</Text>
            </Pressable>
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setGroupModal(true);
              }}
            >
              <Icon name="people-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>New group</Text>
            </Pressable>

            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setRequestsOpen(true);
              }}
              accessibilityRole="button"
            >
              <Icon name="mail-unread-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>Message requests</Text>
            </Pressable>

            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setSavesOpen(true);
              }}
              accessibilityRole="button"
            >
              <Icon name="bookmark-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>My saves</Text>
            </Pressable>

            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setPrivacyOpen(true);
              }}
              accessibilityRole="button"
            >
              <Icon name="shield-checkmark-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>Privacy</Text>
            </Pressable>

            <Pressable
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setNotifSettingsOpen(true);
              }}
              accessibilityRole="button"
            >
              <Icon name="notifications-outline" size={18} color={colors.text} />
              <Text style={styles.menuRowText}>Notifications</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal
        visible={requestsOpen}
        animationType="slide"
        onRequestClose={() => setRequestsOpen(false)}
      >
        <RequestsScreen onBack={() => setRequestsOpen(false)} />
      </Modal>

      <Modal visible={savesOpen} animationType="slide" onRequestClose={() => setSavesOpen(false)}>
        <SavesScreen onBack={() => setSavesOpen(false)} />
      </Modal>

      <Modal
        visible={privacyOpen}
        animationType="slide"
        onRequestClose={() => setPrivacyOpen(false)}
      >
        <PrivacyScreen onBack={() => setPrivacyOpen(false)} />
      </Modal>

      <Modal
        visible={notifSettingsOpen}
        animationType="slide"
        onRequestClose={() => setNotifSettingsOpen(false)}
      >
        <NotificationSettingsScreen onBack={() => setNotifSettingsOpen(false)} />
      </Modal>
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

  const sheetPad = useSheetPad(36);

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
        <View style={[styles.modalSheet, { paddingBottom: sheetPad }]}>
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
                  <View style={styles.memberChipLine}>
                    <Text style={[styles.memberChipText, active && styles.memberChipTextActive]}>
                      @{c.username}
                    </Text>
                    {!!(c as any).verified && <VerifiedBadge size={10} glow={false} />}
                  </View>
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP_INSET + 8,
    paddingBottom: 8,
    paddingHorizontal: 20,
  },
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
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
  convNameRow: { flexDirection: 'row', alignItems: 'center' },
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
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    elevation: 8,
    shadowColor: colors.accent,
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
  },
  fabHalo: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1.5,
    borderColor: 'rgba(255,157,31,0.45)',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingVertical: 10,
    paddingBottom: 28,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  menuRowText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
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
  chipsScroll: { flexGrow: 0, height: 40 },
  tabsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  tabChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabChipText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  tabChipTextActive: { color: colors.bg, fontWeight: '800' },
  plusChip: { paddingHorizontal: 12, justifyContent: 'center' },
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
  activeName: { color: colors.textMuted, fontSize: 10.5, fontWeight: '600', maxWidth: 56 },
  activeNameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 3, gap: 2 },
  verifiedInline: { marginLeft: 4 },
  memberChipLine: { flexDirection: 'row', alignItems: 'center', gap: 3 },
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
  anonBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  anonBadgeText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '800',
  },
});
