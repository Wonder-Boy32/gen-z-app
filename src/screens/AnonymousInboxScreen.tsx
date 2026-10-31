import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { resolveMediaRefs } from '../utils/privateMedia';
import { colors, radius } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import AnonymousSettingsModal from '../components/AnonymousSettingsModal';
import AnonymousCardModal from '../components/AnonymousCardModal';

type AnonMsg = {
  id: string;
  content: string | null;
  media_url: string | null;
  voice_url: string | null;
  message_type: string;
  reaction: string | null;
  expires_at: string | null;
  read_at: string | null;
  created_at: string;
};

const REACTIONS = ['❤️', '😂', '😮', '🔥', '😢'];
const REPORT_REASONS = [
  'Harassment',
  'Bullying',
  'Threats',
  'Sexual content',
  'Hate / abuse',
  'Spam',
  'Scam',
  'Self-harm encouragement',
  'Other',
];

function fmtAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AnonymousInboxScreen({
  onBack,
  onReplyWithDrop,
  onPostToFeed,
}: {
  onBack: () => void;
  onReplyWithDrop?: () => void;
  onPostToFeed?: (uri: string) => void;
}) {
  const [msgs, setMsgs] = useState<AnonMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [myUsername, setMyUsername] = useState('you');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<AnonMsg | null>(null);
  const [reportFor, setReportFor] = useState<AnonMsg | null>(null);
  const [cardFor, setCardFor] = useState<AnonMsg | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data: me } = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle();
    if (me?.username) setMyUsername(me.username);
    const { data } = await supabase
      .from('anonymous_messages_public')
      .select('*')
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    const now = Date.now();
    const live = ((data ?? []) as AnonMsg[]).filter(
      (m) => !m.expires_at || new Date(m.expires_at).getTime() > now
    );

    // Anonymous media now lives in the private `anon-media` bucket, so
    // the stored value is an `sb://` reference rather than a URL. Sign
    // them in one batch before the first render; legacy rows that still
    // hold an https URL are returned unchanged by the resolver.
    const resolved = await resolveMediaRefs(
      live.flatMap((m) => [m.media_url, m.voice_url])
    );
    for (const m of live) {
      if (m.media_url) m.media_url = resolved.get(m.media_url) ?? null;
      if (m.voice_url) m.voice_url = resolved.get(m.voice_url) ?? null;
    }

    setMsgs(live);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Viewing the inbox IS reading it.
  //
  // BUG THIS FIXES: read_at was only ever written by markRead(), and markRead
  // is wired to a card's onPress. So a message you had plainly opened the inbox
  // and read kept its unread badge until you happened to tap that exact card —
  // the badge sat at "1" on a thread you had already seen. Now everything
  // visible is marked read once it has loaded.
  //
  // This settles after one pass: once read_at is set locally, the next run finds
  // no unread rows and returns immediately.
  useEffect(() => {
    if (loading || !msgs.length) return;
    const unread = msgs.filter((m) => !m.read_at);
    if (!unread.length) return;

    const now = new Date().toISOString();
    setMsgs((prev) => prev.map((m) => (m.read_at ? m : { ...m, read_at: now })));
    void (async () => {
      const { error } = await supabase
        .from('anonymous_messages_public')
        .update({ read_at: now })
        .in('id', unread.map((m) => m.id));
      // Surface a failed write instead of letting the optimistic local state
      // hide it — a badge that will not clear should not fail silently.
      if (error) console.warn('[anon] marking read failed:', error.message);
    })();
  }, [loading, msgs]);

  // live refresh: when a new anonymous message arrives (the send RPC creates
  // a notification row), reload from the public view. We watch notifications,
  // NEVER the anonymous_messages table — its realtime payload would leak
  // sender_id to the client.
  useEffect(() => {
    let channel: any = null;
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      // unique per-user name + drop any stale instance (async cleanup race)
      const name = `anon-inbox:${user.id}`;
      supabase
        .getChannels()
        .filter((c) => c.topic === `realtime:${name}`)
        .forEach((c) => supabase.removeChannel(c));
      channel = supabase
        .channel(name)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
          () => load()
        )
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [load]);

  const react = async (m: AnonMsg, emoji: string) => {
    const next = m.reaction === emoji ? null : emoji;
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, reaction: next } : x)));
    await supabase.from('anonymous_messages_public').update({ reaction: next }).eq('id', m.id);
  };

  const markRead = async (m: AnonMsg) => {
    if (!m.read_at) {
      await supabase.from('anonymous_messages_public').update({ read_at: new Date().toISOString() }).eq('id', m.id);
    }
  };

  const doDelete = async (m: AnonMsg) => {
    await supabase.from('anonymous_messages_public').delete().eq('id', m.id);
    setMsgs((prev) => prev.filter((x) => x.id !== m.id));
    setMenuFor(null);
  };

  const confirmDelete = (m: AnonMsg) => {
    Alert.alert('Delete message', 'This anonymous message will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => doDelete(m) },
    ]);
  };

  const doBlock = async (m: AnonMsg) => {
    const { error } = await supabase.rpc('anon_block_message', { p_message_id: m.id });
    if (!error) {
      setMsgs((prev) => prev.filter((x) => x.id !== m.id));
      Alert.alert('Blocked', 'You won\'t receive messages from this sender again.');
    }
    setMenuFor(null);
  };

  const doReport = async (m: AnonMsg, reason: string) => {
    await supabase.rpc('anon_report_message', { p_message_id: m.id, p_reason: reason, p_note: null });
    setReportFor(null);
    setMenuFor(null);
    Alert.alert('Reported', 'Thanks — we\'ll review it.');
  };

  const renderItem = ({ item }: { item: AnonMsg }) => {
    const expiresIn = item.expires_at ? new Date(item.expires_at).getTime() - Date.now() : null;
    return (
      <Pressable style={styles.card} onPress={() => markRead(item)}>
        <View style={styles.cardTop}>
          <View style={styles.anonAvatar}>
            <Icon name="eye-off-outline" size={16} color={colors.accent} />
          </View>
          <View style={styles.cardHead}>
            <Text style={styles.anonName}>🕵️ Anonymous</Text>
            <Text style={styles.cardTime}>{fmtAgo(item.created_at)}</Text>
          </View>
          <Pressable style={styles.menuBtn} onPress={() => setMenuFor(item)} hitSlop={8}>
            <Icon name="ellipsis-horizontal" size={17} color={colors.textMuted} />
          </Pressable>
        </View>

        {item.content ? <Text style={styles.content}>{item.content}</Text> : null}
        {item.media_url ? (
          <Image source={{ uri: item.media_url }} style={styles.media} resizeMode="cover" />
        ) : null}
        {item.voice_url ? (
          <View style={styles.voiceBadge}>
            <Icon name="mic" size={14} color={colors.accent} />
            <Text style={styles.voiceText}>Voice message</Text>
          </View>
        ) : null}

        {expiresIn && expiresIn > 0 ? (
          <Text style={styles.expBadge}>⏳ Disappears {Math.ceil(expiresIn / 3600000)}h from now</Text>
        ) : null}

        <View style={styles.reactions}>
          {REACTIONS.map((r) => {
            const on = item.reaction === r;
            return (
              <Pressable
                key={r}
                style={[styles.reactionChip, on && styles.reactionChipOn]}
                onPress={() => react(item, r)}
              >
                <Text style={styles.reactionText}>{r}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.cardActions}>
          {onReplyWithDrop && (
            <Pressable style={styles.replyBtn} onPress={onReplyWithDrop}>
              <Icon name="flame" size={13} color={colors.accent} />
              <Text style={styles.replyBtnText}>Reply with Drop</Text>
            </Pressable>
          )}
          {onPostToFeed && (
            <Pressable style={[styles.replyBtn, styles.postBtn]} onPress={() => setCardFor(item)}>
              <Icon name="download-outline" size={13} color={colors.accent} />
              <Text style={styles.replyBtnText}>Post as Drop</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Icon name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>🕵️ Anonymous Inbox</Text>
        <Pressable style={styles.settingsBtn} onPress={() => setSettingsOpen(true)} hitSlop={8}>
          <Icon name="settings-outline" size={19} color={colors.textMuted} />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={msgs}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIcon}>
                <Icon name="eye-off-outline" size={26} color={colors.accent} />
              </View>
              <Text style={styles.emptyTitle}>No anonymous messages yet</Text>
              <Text style={styles.emptySub}>
                Share your anonymous link to invite messages you'd never get otherwise 👀
              </Text>
            </View>
          }
        />
      )}

      <AnonymousSettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {cardFor && (
        <AnonymousCardModal
          visible
          username={myUsername}
          message={cardFor.content}
          kind="message"
          onClose={() => setCardFor(null)}
          onPostToFeed={(uri) => onPostToFeed?.(uri)}
        />
      )}

      {/* ••• menu */}
      <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuFor(null)}>
          <View style={styles.menuSheet}>
            <Pressable style={styles.menuItem} onPress={() => { setReportFor(menuFor); setMenuFor(null); }}>
              <Icon name="flag-outline" size={16} color={colors.text} />
              <Text style={styles.menuItemText}>Report</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => menuFor && doBlock(menuFor)}>
              <Icon name="ban-outline" size={16} color={colors.text} />
              <Text style={styles.menuItemText}>Block sender</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => menuFor && confirmDelete(menuFor)}>
              <Icon name="trash-outline" size={16} color="#ff6b6b" />
              <Text style={[styles.menuItemText, { color: '#ff6b6b' }]}>Delete</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* report reasons */}
      <Modal visible={!!reportFor} transparent animationType="slide" onRequestClose={() => setReportFor(null)}>
        <Pressable style={styles.menuOverlay} onPress={() => setReportFor(null)}>
          <View style={styles.reportSheet}>
            <Text style={styles.reportTitle}>Report anonymous message</Text>
            {REPORT_REASONS.map((r) => (
              <Pressable key={r} style={styles.reportItem} onPress={() => reportFor && doReport(reportFor, r)}>
                <Text style={styles.reportItemText}>{r}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP_INSET + 8,
    paddingBottom: 10,
    paddingHorizontal: 14,
  },
  backBtn: { padding: 4 },
  topTitle: { color: colors.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.3 },
  settingsBtn: { padding: 4 },
  listContent: { padding: 16, paddingBottom: 40 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 12,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  anonAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(229,43,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHead: { flex: 1, marginLeft: 10 },
  anonName: { color: colors.accent, fontSize: 13.5, fontWeight: '800' },
  cardTime: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  menuBtn: { padding: 4 },
  content: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
  media: { width: '100%', height: 180, borderRadius: radius.md, marginTop: 10 },
  voiceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(229,43,255,0.1)',
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  voiceText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  expBadge: { color: colors.accent, fontSize: 11, fontWeight: '700', marginTop: 8 },
  reactions: { flexDirection: 'row', gap: 6, marginTop: 10 },
  reactionChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  reactionChipOn: { borderColor: colors.accent, backgroundColor: 'rgba(229,43,255,0.16)' },
  reactionText: { fontSize: 13 },
  replyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  replyBtnText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  cardActions: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  postBtn: { backgroundColor: 'rgba(229,43,255,0.12)' },
  emptyWrap: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 30 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(229,43,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  emptySub: { color: colors.textMuted, fontSize: 12.5, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  menuSheet: {
    backgroundColor: '#0d1426',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 16,
    paddingBottom: 36,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  menuItemText: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  reportSheet: {
    backgroundColor: '#0d1426',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 16,
    paddingBottom: 36,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  reportTitle: { color: colors.text, fontSize: 15, fontWeight: '900', marginBottom: 6 },
  reportItem: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)' },
  reportItemText: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
