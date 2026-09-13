import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Icon, { IconName } from '../components/ui/Icon';
import { NotifyType } from '../utils/notify';
import { showLocalNotification, clearBadge, dismissAll } from '../utils/push';

type PostThumb = { cover_url: string | null; media_url: string | null; media_type: string | null } | null;

type NotifRow = {
  id: string;
  type: NotifyType;
  read: boolean;
  created_at: string;
  post_id: string | null;
  comment_id: string | null;
  actor_id: string;
  actor: { username: string; display_name: string | null; avatar_url: string | null; verified: boolean } | null;
  post: PostThumb;
  comment: { content: string } | null;
};

type Section = { title: string; data: NotifRow[] };

type FilterKey = 'all' | 'comments' | 'likes' | 'follows' | 'messages';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'comments', label: 'Comments' },
  { key: 'likes', label: 'Likes' },
  { key: 'follows', label: 'Follows' },
  { key: 'messages', label: 'Messages' },
];

const FILTER_TYPES: Record<FilterKey, NotifyType[] | null> = {
  all: null,
  comments: ['comment', 'reply'],
  likes: ['like', 'comment_like', 'reaction'],
  follows: ['follow', 'repost'],
  messages: ['anon_message', 'call'],
};

// words that follow the bold username
const COPY: Record<NotifyType, string> = {
  follow: 'started following you',
  like: 'liked your drop',
  comment: 'commented:',
  reply: 'replied to your comment:',
  reaction: 'reacted to your drop',
  repost: 'reposted your drop',
  comment_like: 'liked your comment',
  anon_message: 'sent you an anonymous message',
  call: 'tried to call you',
};

const CHIP: Record<NotifyType, { icon: IconName; color: string }> = {
  follow: { icon: 'person-add', color: '#4DD8FF' },
  like: { icon: 'heart', color: '#FF3B5C' },
  comment: { icon: 'chatbubble', color: '#8B7BFF' },
  reply: { icon: 'chatbubble-ellipses', color: '#8B7BFF' },
  reaction: { icon: 'sparkles', color: '#FF9D1F' },
  repost: { icon: 'repeat', color: '#34D399' },
  comment_like: { icon: 'heart', color: '#FF3B5C' },
  anon_message: { icon: 'eye-off', color: '#A8E6F2' },
  call: { icon: 'call', color: '#FF5C7C' },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** New / Today / This week / Earlier */
function bucket(iso: string, isUnread: boolean): string {
  if (isUnread) return 'New';
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (new Date(iso).toDateString() === new Date().toDateString()) return 'Today';
  if (now - t < 7 * 24 * 60 * 60 * 1000) return 'This week';
  return 'Earlier';
}

const BUCKET_ORDER = ['New', 'Today', 'This week', 'Earlier'];

export default function ActivityScreen({
  onBack,
  onChanged,
  onOpenPost,
}: {
  onBack: () => void;
  onChanged?: () => void;
  onOpenPost?: (postId: string) => void;
}) {
  const [items, setItems] = useState<NotifRow[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [likedComments, setLikedComments] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [replyTo, setReplyTo] = useState<{ commentId: string; username: string; postId: string | null } | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const myIdRef = useRef<string | null>(null);
  const replyInput = useRef<TextInput>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    myIdRef.current = user.id;

    const { data } = await supabase
      .from('notifications')
      .select(
        'id, type, read, created_at, post_id, comment_id, actor_id, ' +
          'actor:profiles!notifications_actor_id_fkey(username, display_name, avatar_url, verified), ' +
          'post:posts!notifications_post_id_fkey(cover_url, media_url, media_type), ' +
          'comment:comments!notifications_comment_id_fkey(content)'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(120);

    const rows = (data ?? []) as unknown as NotifRow[];
    setItems(rows);
    // snapshot which ones were unread when the screen opened - the tint stays
    // for this visit even though we mark them read below
    setUnreadIds(new Set(rows.filter((r) => !r.read).map((r) => r.id)));

    const commentIds = rows.map((r) => r.comment_id).filter((x): x is string => !!x);
    const actorIds = Array.from(new Set(rows.map((r) => r.actor_id))).filter((id) => id !== user.id);

    const [myLikes, myFollows] = await Promise.all([
      commentIds.length
        ? supabase.from('comment_likes').select('comment_id').eq('user_id', user.id).in('comment_id', commentIds)
        : Promise.resolve({ data: [] as { comment_id: string }[] }),
      actorIds.length
        ? supabase.from('follows').select('following_id').eq('follower_id', user.id).in('following_id', actorIds)
        : Promise.resolve({ data: [] as { following_id: string }[] }),
    ]);
    setLikedComments(new Set((myLikes.data ?? []).map((x) => (x as { comment_id: string }).comment_id)));
    setFollowing(new Set((myFollows.data ?? []).map((x) => (x as { following_id: string }).following_id)));

    setLoading(false);
    setRefreshing(false);

    // seen: clear the bell badge + the app icon badge
    const hadUnread = rows.some((r) => !r.read);
    if (hadUnread) {
      await supabase.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
      onChanged?.();
    }
    void clearBadge();
    void dismissAll();
  }, [onChanged]);

  useEffect(() => {
    load();
  }, [load]);

  // live activity: a new notification arrives -> prepend it and let the phone
  // announce it, exactly like a push would
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      channel = supabase
        .channel(`activity-${user.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
          async (payload) => {
            const row = payload.new as {
              id: string;
              type: NotifyType;
              created_at: string;
              post_id: string | null;
              comment_id: string | null;
              actor_id: string;
            };

            const [actorRes, postRes, commentRes] = await Promise.all([
              supabase
                .from('profiles')
                .select('username, display_name, avatar_url, verified')
                .eq('id', row.actor_id)
                .maybeSingle(),
              row.post_id
                ? supabase
                    .from('posts')
                    .select('cover_url, media_url, media_type')
                    .eq('id', row.post_id)
                    .maybeSingle()
                : Promise.resolve({ data: null }),
              row.comment_id
                ? supabase.from('comments').select('content').eq('id', row.comment_id).maybeSingle()
                : Promise.resolve({ data: null }),
            ]);

            const enriched: NotifRow = {
              id: row.id,
              type: row.type,
              read: false,
              created_at: row.created_at,
              post_id: row.post_id,
              comment_id: row.comment_id,
              actor_id: row.actor_id,
              actor: (actorRes.data ?? null) as NotifRow['actor'],
              post: (postRes.data ?? null) as PostThumb,
              comment: (commentRes.data ?? null) as { content: string } | null,
            };

            setItems((prev) => [enriched, ...prev]);
            setUnreadIds((prev) => new Set(prev).add(row.id));

            const who = enriched.actor?.display_name || enriched.actor?.username || 'Someone';
            const preview = enriched.comment?.content?.trim();
            const title =
              row.type === 'follow'
                ? 'New follower'
                : row.type === 'like' || row.type === 'comment_like' || row.type === 'reaction'
                  ? 'New like'
                  : row.type === 'comment'
                    ? 'New comment'
                    : row.type === 'reply'
                      ? 'New reply'
                      : row.type === 'repost'
                        ? 'New repost'
                        : row.type === 'anon_message'
                          ? 'Anonymous message'
                          : row.type === 'call'
                            ? 'Missed call'
                            : 'Gen Z';

            void showLocalNotification({
              type: row.type,
              title,
              body:
                row.type === 'comment' || row.type === 'reply'
                  ? `${who}: ${preview ?? COPY[row.type].replace(':', '')}`
                  : row.type === 'follow'
                    ? `${who} started following you`
                    : row.type === 'anon_message'
                      ? 'Someone sent you an anonymous message'
                      : row.type === 'call'
                        ? `${who} tried to call you`
                        : `${who} ${COPY[row.type]}`,
              actor: enriched.actor?.username ?? null,
              postId: row.post_id,
              commentId: row.comment_id,
              notificationId: row.id,
            });
          }
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const filtered = useMemo(() => {
    const types = FILTER_TYPES[filter];
    return types ? items.filter((i) => types.includes(i.type)) : items;
  }, [items, filter]);

  const sections = useMemo<Section[]>(() => {
    const map = new Map<string, NotifRow[]>();
    for (const n of filtered) {
      const key = bucket(n.created_at, unreadIds.has(n.id));
      const list = map.get(key) ?? [];
      list.push(n);
      map.set(key, list);
    }
    return BUCKET_ORDER.filter((t) => map.has(t)).map((title) => ({ title, data: map.get(title) ?? [] }));
  }, [filtered, unreadIds]);

  const markAllRead = async () => {
    const me = myIdRef.current;
    if (!me) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadIds(new Set());
    await supabase.from('notifications').update({ read: true }).eq('user_id', me).eq('read', false);
    onChanged?.();
  };

  const toggleCommentLike = async (row: NotifRow) => {
    const me = myIdRef.current;
    if (!me || !row.comment_id) return;
    const liked = likedComments.has(row.comment_id);
    setLikedComments((prev) => {
      const next = new Set(prev);
      if (liked) next.delete(row.comment_id!);
      else next.add(row.comment_id!);
      return next;
    });
    if (liked) {
      await supabase.from('comment_likes').delete().eq('comment_id', row.comment_id).eq('user_id', me);
    } else {
      await supabase.from('comment_likes').insert({ comment_id: row.comment_id, user_id: me });
    }
  };

  const followBack = async (row: NotifRow) => {
    const me = myIdRef.current;
    if (!me || row.actor_id === me) return;
    const already = following.has(row.actor_id);
    setFollowing((prev) => {
      const next = new Set(prev);
      if (already) next.delete(row.actor_id);
      else next.add(row.actor_id);
      return next;
    });
    if (already) {
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', row.actor_id);
    } else {
      await supabase.from('follows').insert({ follower_id: me, following_id: row.actor_id, status: 'accepted' });
    }
  };

  const openReply = (row: NotifRow) => {
    if (!row.comment_id) return;
    setReplyTo({
      commentId: row.comment_id,
      username: row.actor?.username ?? 'them',
      postId: row.post_id,
    });
    setReplyText('');
    setTimeout(() => replyInput.current?.focus(), 60);
  };

  const sendReply = async () => {
    const me = myIdRef.current;
    const clean = replyText.trim();
    if (!me || !clean || !replyTo || !replyTo.postId || sending) return;
    setSending(true);
    await supabase.from('comments').insert({
      post_id: replyTo.postId,
      user_id: me,
      content: clean,
      parent_id: replyTo.commentId,
    });
    setSending(false);
    setReplyText('');
    setReplyTo(null);
  };

  const renderRow = (row: NotifRow) => {
    const unread = unreadIds.has(row.id);
    const chip = CHIP[row.type];
    const isCommentish = (row.type === 'comment' || row.type === 'reply') && !!row.comment_id;
    const isFollow = row.type === 'follow';
    const preview = row.comment?.content?.trim();
    const thumb =
      row.post && (row.post.cover_url || (row.post.media_type !== 'text' ? row.post.media_url : null));

    return (
      <Pressable
        style={[styles.row, unread && styles.rowUnread]}
        onPress={() => row.post_id && onOpenPost?.(row.post_id)}
      >
        {unread && <View style={styles.unreadBar} />}

        <View style={styles.avatarWrap}>
          {row.type === 'anon_message' ? (
            <View style={styles.anonAvatar}>
              <Icon name="eye-off-outline" size={18} color={colors.cyan} />
            </View>
          ) : (
            <Avatar
              url={row.actor?.avatar_url}
              name={row.actor?.display_name || row.actor?.username || 'G'}
              size={44}
              ring
              verified={!!row.actor?.verified}
            />
          )}
          <View style={[styles.chipDot, { backgroundColor: chip.color }]}>
            <Icon name={chip.icon} size={10} color={colors.bg} />
          </View>
        </View>

        <View style={styles.body}>
          <View style={styles.line}>
            {row.type === 'anon_message' ? (
              <Text style={styles.action}>{COPY[row.type]}</Text>
            ) : (
              <>
                <Text style={styles.username} numberOfLines={1}>
                  {row.actor?.display_name || row.actor?.username || 'someone'}
                </Text>
                {!!row.actor?.verified && <VerifiedBadge size={12} glow={false} style={styles.badge} />}
                <Text style={styles.action} numberOfLines={2}>
                  {' '}
                  {COPY[row.type]}
                </Text>
              </>
            )}
          </View>

          {!!preview && row.type !== 'comment_like' && (
            <Text style={styles.preview} numberOfLines={2}>
              {preview}
            </Text>
          )}

          <View style={styles.metaRow}>
            <Text style={styles.time}>{timeAgo(row.created_at)}</Text>
            {isCommentish && (
              <>
                <Pressable onPress={() => toggleCommentLike(row)} hitSlop={8} style={styles.metaAction}>
                  <Icon
                    name={likedComments.has(row.comment_id!) ? 'heart' : 'heart-outline'}
                    size={15}
                    color={likedComments.has(row.comment_id!) ? colors.accent : colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.metaActionText,
                      likedComments.has(row.comment_id!) && styles.metaActionTextActive,
                    ]}
                  >
                    Like
                  </Text>
                </Pressable>
                <Pressable onPress={() => openReply(row)} hitSlop={8} style={styles.metaAction}>
                  <Icon name="chatbubble-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.metaActionText}>Reply</Text>
                </Pressable>
              </>
            )}
            {isFollow && row.actor_id !== myIdRef.current && (
              <Pressable
                onPress={() => followBack(row)}
                style={[styles.followBtn, following.has(row.actor_id) && styles.followBtnActive]}
              >
                <Text
                  style={[
                    styles.followBtnText,
                    following.has(row.actor_id) && styles.followBtnTextActive,
                  ]}
                >
                  {following.has(row.actor_id) ? 'Following' : 'Follow back'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>

        {!!thumb && (
          <Image
            source={{ uri: (row.post?.cover_url ?? row.post?.media_url) as string }}
            style={styles.thumb}
          />
        )}
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Icon name="chevron-back" size={20} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Activity</Text>
        <Pressable onPress={markAllRead} style={styles.headerRight} hitSlop={8}>
          {unreadIds.size > 0 ? (
            <Icon name="checkmark-done-outline" size={21} color={colors.accent} />
          ) : null}
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(n) => n.id}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.title === 'New' && <View style={styles.newDot} />}
            </View>
          )}
          renderItem={({ item }) => renderRow(item)}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Icon name="notifications-outline" size={26} color={colors.textFaint} />
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyBody}>
                Likes, comments, follows and messages land here the moment they happen - and on your
                phone's notification bar.
              </Text>
            </View>
          }
        />
      )}

      {replyTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyLabel} numberOfLines={1}>
            Replying to {replyTo.username}
          </Text>
          {replyTo.postId ? (
            <View style={styles.replyInputRow}>
              <TextInput
                ref={replyInput}
                style={styles.replyInput}
                placeholder="Write a reply..."
                placeholderTextColor={colors.textFaint}
                value={replyText}
                onChangeText={setReplyText}
                multiline
                onSubmitEditing={sendReply}
              />
              <Pressable
                style={[styles.sendBtn, (!replyText.trim() || sending) && styles.sendBtnDisabled]}
                onPress={sendReply}
                disabled={!replyText.trim() || sending}
                hitSlop={6}
              >
                <Icon name="arrow-up" size={18} color={colors.bg} />
              </Pressable>
            </View>
          ) : (
            <Text style={styles.replyUnavailable}>This reply is no longer available.</Text>
          )}
          <Pressable onPress={() => setReplyTo(null)} hitSlop={8} style={styles.replyClose}>
            <Icon name="close" size={14} color={colors.textMuted} />
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
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
    paddingHorizontal: 12,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: {
    width: 80,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  headerRight: {
    width: 80,
    alignItems: 'flex-end',
  },
  chipRow: {
    flexGrow: 0,
    // NO maxHeight. It was 46, which is less than the row's real content height
    // (16 row padding + 14 chip padding/border + ~18 text line box = ~48), so the
    // row was clipped and every chip label rendered sliced across the middle.
    // Sizing to content also means the labels survive a larger system font scale.
  },
  chipRowContent: {
    // without this the chips stretch to the row's height and the text is squeezed
    // inside them — the other half of the same bug
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 13,
    paddingVertical: 6,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '700',
    // an explicit line box so the chip height is deterministic on every device
    // instead of depending on font metrics
    lineHeight: 17,
  },
  chipTextActive: {
    color: colors.accent,
  },
  loader: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 30,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  newDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  rowUnread: {
    backgroundColor: colors.accentSoft,
  },
  unreadBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.accent,
  },
  avatarWrap: {
    position: 'relative',
  },
  anonAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipDot: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  username: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '800',
    maxWidth: '62%',
  },
  badge: {
    marginLeft: 4,
  },
  action: {
    color: colors.textMuted,
    fontSize: 13.5,
    fontWeight: '500',
  },
  preview: {
    color: colors.text,
    fontSize: 13.5,
    lineHeight: 18,
    marginTop: 3,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 6,
    minHeight: 18,
  },
  time: {
    color: colors.textFaint,
    fontSize: 11.5,
    fontWeight: '600',
  },
  metaAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaActionText: {
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '700',
  },
  metaActionTextActive: {
    color: colors.accent,
  },
  followBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  followBtnActive: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  followBtnText: {
    color: colors.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  followBtnTextActive: {
    color: colors.textMuted,
  },
  thumb: {
    width: 52,
    height: 68,
    borderRadius: 9,
    backgroundColor: colors.surfaceAlt,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 40,
    marginTop: 80,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 12,
  },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 6,
  },
  replyBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 12,
  },
  replyLabel: {
    color: colors.accent,
    fontSize: 11.5,
    fontWeight: '700',
    marginBottom: 6,
  },
  replyInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  replyInput: {
    flex: 1,
    maxHeight: 90,
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 13.5,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  replyUnavailable: {
    color: colors.textFaint,
    fontSize: 12.5,
  },
  replyClose: {
    position: 'absolute',
    right: 14,
    top: 8,
  },
});
