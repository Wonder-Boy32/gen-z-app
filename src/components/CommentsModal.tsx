import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
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
import { VideoView, useVideoPlayer } from 'expo-video';
import { useInsets } from '../utils/useInsets';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Icon from './ui/Icon';
import Avatar from './Avatar';
import VerifiedBadge from './ui/VerifiedBadge';
import { notifyUser } from '../utils/notify';

type CommentProfile = { username: string; avatar_url?: string | null; verified?: boolean } | null;

type CommentRow = {
  id: string;
  content: string;
  created_at: string;
  parent_id: string | null;
  user_id?: string;
  likes_count?: number;
  liked_by_me?: boolean;
  dislikes_count?: number;
  disliked_by_me?: boolean;
  profile: CommentProfile;
};

type CommentNode = CommentRow & {
  replies: CommentNode[];
  reply_count: number;
};

type DropReply = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  text_bg: string | null;
  text_color: string | null;
  created_at: string;
  profile: { username: string; avatar_url: string | null; verified?: boolean } | null;
};

type Me = { id: string; username: string; avatar_url: string | null; verified: boolean } | null;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function compactCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

// dislike table may not exist yet - only warn once, then stop probing
let dislikesTableMissing = false;

type SortKey = 'discussed' | 'newest' | 'top';

async function fetchPostOwner(postId: string): Promise<string | null> {
  try {
    const { data } = await supabase.from('posts').select('user_id').eq('id', postId).maybeSingle();
    return (data as { user_id?: string } | null)?.user_id ?? null;
  } catch {
    return null;
  }
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'discussed', label: 'Most discussed' },
  { key: 'newest', label: 'Newest' },
  { key: 'top', label: 'Top replies' },
];

const QUICK_EMOJI = ['\u2764\uFE0F', '\u{1F602}', '\u{1F525}', '\u{1F62E}', '\u{1F44F}', '\u{1F4AF}', '\u{1F64C}', '\u{1F622}'];

type Props = {
  post: { id: string; user_id?: string } | null;
  onClose: () => void;
  onPosted: () => void;
  onReplyWithDrop?: () => void;
};

export default function CommentsModal({ post, onClose, onPosted, onReplyWithDrop }: Props) {
  const insets = useInsets();
  const inputRef = useRef<TextInput>(null);

  // ---- Android keyboard handling ------------------------------------------
  // KeyboardAvoidingView does NOT help here on Android. In RN 0.86 it has no
  // defaultProps, so `behavior={undefined}` falls through to its `default:`
  // branch and renders a plain View with no paddingBottom — it subscribes to
  // keyboardDidShow and then discards the result. That is why the keyboard
  // covered the composer.
  //
  // iOS keeps KeyboardAvoidingView (proven to work there). Android gets the
  // sheet lifted by the reported keyboard height instead. Exactly one mechanism
  // is active per platform, so nothing fights.
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setKbHeight(e?.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // this component stays mounted while the sheet is closed, so clear a stale
  // height on close — otherwise reopening could show an over-tall sheet
  useEffect(() => {
    if (!post) setKbHeight(0);
  }, [post]);

  // with the IME open the nav bar sits behind it, so the keyboard height is the
  // full distance from the screen bottom that the composer must clear
  const padBottom =
    Platform.OS === 'android' && kbHeight > 0 ? kbHeight : Math.max(insets.bottom, 10);

  const [roots, setRoots] = useState<CommentNode[]>([]);
  const [dropReplies, setDropReplies] = useState<DropReply[]>([]);
  const [viewing, setViewing] = useState<DropReply | null>(null);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('discussed');
  const [sortOpen, setSortOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [replyingTo, setReplyingTo] = useState<{ id: string; username: string } | null>(null);
  const [me, setMe] = useState<Me>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!post) return;
    setLoading(true);
    setExpanded({});
    setSearch('');

    const authUser = (await supabase.auth.getUser()).data.user;
    setOwnerId(post.user_id ?? (await fetchPostOwner(post.id)));

    if (authUser) {
      const { data: meRow } = await supabase
        .from('profiles')
        .select('username, avatar_url, verified')
        .eq('id', authUser.id)
        .maybeSingle();
      const p = meRow as { username?: string; avatar_url?: string | null; verified?: boolean } | null;
      setMe({
        id: authUser.id,
        username: p?.username ?? 'you',
        avatar_url: p?.avatar_url ?? null,
        verified: !!p?.verified,
      });
    }

    const { data } = await supabase
      .from('comments')
      .select('id, content, created_at, parent_id, user_id, profile:profiles(username, avatar_url, verified)')
      .eq('post_id', post.id)
      .limit(500);
    const rows = (data ?? []) as unknown as CommentRow[];

    // build the thread tree
    const byId = new Map<string, CommentNode>();
    rows.forEach((r) =>
      byId.set(r.id, {
        ...r,
        replies: [],
        reply_count: 0,
        likes_count: 0,
        liked_by_me: false,
        dislikes_count: 0,
        disliked_by_me: false,
      })
    );
    const rootList: CommentNode[] = [];
    rows.forEach((r) => {
      const node = byId.get(r.id)!;
      if (r.parent_id && byId.has(r.parent_id)) {
        byId.get(r.parent_id)!.replies.push(node);
        let parent: CommentNode | undefined = byId.get(r.parent_id);
        while (parent) {
          parent.reply_count += 1;
          parent = parent.parent_id && byId.get(parent.parent_id) ? byId.get(parent.parent_id) : undefined;
        }
      } else {
        rootList.push(node);
      }
    });

    // reply-with-drop posts live in the comments, not the home feed
    const { data: replyRows } = await supabase
      .from('posts')
      .select(
        'id, user_id, media_url, media_type, content, text_bg, text_color, created_at, profile:profiles!posts_user_id_fkey(username, avatar_url, verified)'
      )
      .eq('parent_drop_id', post.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setDropReplies((replyRows ?? []) as unknown as DropReply[]);

    // likes (and dislikes when the table exists)
    const ids = rows.map((r) => r.id);
    const likeCounts = new Map<string, number>();
    const myLikes = new Set<string>();
    const dislikeCounts = new Map<string, number>();
    const myDislikes = new Set<string>();

    if (ids.length) {
      const { data: likeRows } = await supabase.from('comment_likes').select('comment_id, user_id').in('comment_id', ids);
      (likeRows ?? []).forEach((x: { comment_id: string; user_id: string }) => {
        likeCounts.set(x.comment_id, (likeCounts.get(x.comment_id) ?? 0) + 1);
        if (authUser && x.user_id === authUser.id) myLikes.add(x.comment_id);
      });

      if (!dislikesTableMissing) {
        const { data: dislikeRows, error } = await supabase
          .from('comment_dislikes')
          .select('comment_id, user_id')
          .in('comment_id', ids);
        if (error) {
          dislikesTableMissing = true;
        } else {
          (dislikeRows ?? []).forEach((x: { comment_id: string; user_id: string }) => {
            dislikeCounts.set(x.comment_id, (dislikeCounts.get(x.comment_id) ?? 0) + 1);
            if (authUser && x.user_id === authUser.id) myDislikes.add(x.comment_id);
          });
        }
      }
    }

    rows.forEach((r) => {
      const node = byId.get(r.id);
      if (!node) return;
      node.likes_count = likeCounts.get(r.id) ?? 0;
      node.liked_by_me = myLikes.has(r.id);
      node.dislikes_count = dislikeCounts.get(r.id) ?? 0;
      node.disliked_by_me = myDislikes.has(r.id);
    });

    setRoots(rootList);
    setLoading(false);
  }, [post?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const sorted = useMemo(() => {
    const list = [...roots];
    list.sort((a, b) => {
      if (sort === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sort === 'discussed')
        return b.reply_count - a.reply_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return (b.likes_count ?? 0) - (a.likes_count ?? 0) || b.reply_count - a.reply_count;
    });
    return list;
  }, [roots, sort]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    const hit = (n: CommentNode) =>
      n.content.toLowerCase().includes(q) || (n.profile?.username ?? '').toLowerCase().includes(q);
    return sorted.filter((r) => hit(r) || r.replies.some(hit));
  }, [sorted, search]);

  const totalCount = useMemo(
    () => roots.reduce((sum, r) => sum + 1 + r.reply_count, 0) + dropReplies.length,
    [roots, dropReplies.length]
  );

  const send = async () => {
    const clean = text.trim();
    if (!clean || !post || sending) return;
    setSending(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSending(false);
      return;
    }
    const { data: row } = await supabase
      .from('comments')
      .insert({
        post_id: post.id,
        user_id: user.id,
        content: clean,
        parent_id: replyingTo?.id ?? null,
      })
      .select('id, content, created_at, parent_id, profile:profiles(username, avatar_url, verified)')
      .single();

    if (row) {
      const inserted = row as unknown as CommentRow;
      setText('');
      setEmojiOpen(false);
      setReplyingTo(null);
      onPosted();
      if (inserted.parent_id) {
        setExpanded((prev) => ({ ...prev, [inserted.parent_id as string]: true }));
        const { data: parentRow } = await supabase
          .from('comments')
          .select('user_id')
          .eq('id', inserted.parent_id)
          .maybeSingle();
        const parentOwner = (parentRow as { user_id?: string } | null)?.user_id;
        if (parentOwner) {
          notifyUser({
            userId: parentOwner,
            actorId: user.id,
            type: 'reply',
            postId: post.id,
            commentId: inserted.id,
          });
        }
        await load();
      } else {
        setRoots((prev) => [
          { ...inserted, replies: [], reply_count: 0, user_id: user.id, likes_count: 0, liked_by_me: false },
          ...prev,
        ]);
        const owner = post.user_id ?? (await fetchPostOwner(post.id));
        if (owner) {
          notifyUser({ userId: owner, actorId: user.id, type: 'comment', postId: post.id, commentId: inserted.id });
        }
      }
    }
    setSending(false);
  };

  const mapNode = (n: CommentNode, id: string, fn: (c: CommentNode) => CommentNode): CommentNode =>
    n.id === id ? fn(n) : { ...n, replies: n.replies.map((r) => mapNode(r, id, fn)) };

  const updateNode = (id: string, fn: (n: CommentNode) => CommentNode) =>
    setRoots((prev) => prev.map((n) => mapNode(n, id, fn)));

  const toggleCommentLike = async (node: CommentNode) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const nowLiked = !node.liked_by_me;
    updateNode(node.id, (n) => ({
      ...n,
      liked_by_me: nowLiked,
      likes_count: Math.max(0, (n.likes_count ?? 0) + (nowLiked ? 1 : -1)),
      // liking clears an existing dislike (one vote per person)
      disliked_by_me: nowLiked ? false : n.disliked_by_me,
      dislikes_count: nowLiked ? Math.max(0, (n.dislikes_count ?? 0) - (n.disliked_by_me ? 1 : 0)) : n.dislikes_count,
    }));
    if (nowLiked) {
      await supabase.from('comment_likes').insert({ comment_id: node.id, user_id: user.id });
      if (!dislikesTableMissing && node.disliked_by_me) {
        await supabase.from('comment_dislikes').delete().eq('comment_id', node.id).eq('user_id', user.id);
      }
      if (node.user_id && post) {
        notifyUser({ userId: node.user_id, actorId: user.id, type: 'comment_like', postId: post.id, commentId: node.id });
      }
    } else {
      await supabase.from('comment_likes').delete().eq('comment_id', node.id).eq('user_id', user.id);
    }
  };

  const toggleCommentDislike = async (node: CommentNode) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const nowDisliked = !node.disliked_by_me;
    const wasLiked = !!node.liked_by_me;
    updateNode(node.id, (n) => ({
      ...n,
      disliked_by_me: nowDisliked,
      dislikes_count: Math.max(0, (n.dislikes_count ?? 0) + (nowDisliked ? 1 : -1)),
      liked_by_me: nowDisliked ? false : n.liked_by_me,
      likes_count: nowDisliked ? Math.max(0, (n.likes_count ?? 0) - (wasLiked ? 1 : 0)) : n.likes_count,
    }));
    try {
      if (nowDisliked) {
        const { error } = await supabase
          .from('comment_dislikes')
          .insert({ comment_id: node.id, user_id: user.id });
        if (error) throw error;
        if (wasLiked) await supabase.from('comment_likes').delete().eq('comment_id', node.id).eq('user_id', user.id);
      } else {
        await supabase.from('comment_dislikes').delete().eq('comment_id', node.id).eq('user_id', user.id);
      }
    } catch {
      // comment_dislikes table not created yet - the vote stays local for this session
      dislikesTableMissing = true;
    }
  };

  const startReply = (node: CommentNode) => {
    setReplyingTo({ id: node.id, username: node.profile?.username ?? 'unknown' });
    inputRef.current?.focus();
  };

  const renderReply = (node: CommentNode, parentUsername: string) => (
    <View key={node.id} style={styles.replyRow}>
      <Avatar
        url={node.profile?.avatar_url}
        name={node.profile?.username ?? 'G'}
        size={28}
        verified={!!node.profile?.verified}
      />
      <View style={styles.body}>
        <View style={styles.usernameRow}>
          <Text style={styles.username} numberOfLines={1}>
            {node.profile?.username ?? 'unknown'}
          </Text>
          {!!node.profile?.verified && <VerifiedBadge size={11} glow={false} style={styles.badgeInline} />}
          {!!ownerId && node.user_id === ownerId && (
            <>
              <Text style={styles.dotSep}>{'\u00B7'}</Text>
              <Text style={styles.creatorTag}>Creator</Text>
            </>
          )}
        </View>
        <Text style={styles.replyingHint}>
          <Text style={styles.replyingHintGlyph}>{'\u21B3 '}</Text>
          replying to {parentUsername}
        </Text>
        <Text style={styles.commentText}>{node.content}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{timeAgo(node.created_at)}</Text>
          <Pressable onPress={() => startReply(node)} hitSlop={8}>
            <Text style={styles.metaText}>Reply</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.rail}>
        <Pressable onPress={() => toggleCommentLike(node)} hitSlop={8} style={styles.railBtn}>
          <Icon
            name={node.liked_by_me ? 'heart' : 'heart-outline'}
            size={17}
            color={node.liked_by_me ? colors.accent : colors.textFaint}
          />
          {(node.likes_count ?? 0) > 0 && (
            <Text style={[styles.railCount, node.liked_by_me && styles.railCountActive]}>
              {compactCount(node.likes_count ?? 0)}
            </Text>
          )}
        </Pressable>
        <Pressable onPress={() => toggleCommentDislike(node)} hitSlop={8} style={styles.railBtn}>
          <Icon
            name={node.disliked_by_me ? 'thumbs-down' : 'thumbs-down-outline'}
            size={15}
            color={node.disliked_by_me ? colors.violet : colors.textFaint}
          />
        </Pressable>
      </View>
    </View>
  );

  const renderNode = (node: CommentNode) => {
    const isOpen = !!expanded[node.id];
    const showReplyBar = node.replies.length > 0 && !isOpen;
    return (
      <View key={node.id} style={styles.row}>
        <View style={styles.rowMain}>
          <Avatar
            url={node.profile?.avatar_url}
            name={node.profile?.username ?? 'G'}
            size={40}
            ring={!!ownerId && node.user_id === ownerId}
            verified={!!node.profile?.verified}
          />
          <View style={styles.body}>
            <View style={styles.usernameRow}>
              <Text style={styles.username} numberOfLines={1}>
                {node.profile?.username ?? 'unknown'}
              </Text>
              {!!node.profile?.verified && <VerifiedBadge size={12} glow={false} style={styles.badgeInline} />}
              {!!ownerId && node.user_id === ownerId && (
                <>
                  <Text style={styles.dotSep}>{'\u00B7'}</Text>
                  <Text style={styles.creatorTag}>Creator</Text>
                </>
              )}
            </View>
            <Text style={styles.commentText}>{node.content}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaText}>{timeAgo(node.created_at)}</Text>
              <Pressable onPress={() => startReply(node)} hitSlop={8}>
                <Text style={styles.metaText}>Reply</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.rail}>
            <Pressable onPress={() => toggleCommentLike(node)} hitSlop={8} style={styles.railBtn}>
              <Icon
                name={node.liked_by_me ? 'heart' : 'heart-outline'}
                size={19}
                color={node.liked_by_me ? colors.accent : colors.textFaint}
              />
              {(node.likes_count ?? 0) > 0 && (
                <Text style={[styles.railCount, node.liked_by_me && styles.railCountActive]}>
                  {compactCount(node.likes_count ?? 0)}
                </Text>
              )}
            </Pressable>
            <Pressable onPress={() => toggleCommentDislike(node)} hitSlop={8} style={styles.railBtn}>
              <Icon
                name={node.disliked_by_me ? 'thumbs-down' : 'thumbs-down-outline'}
                size={17}
                color={node.disliked_by_me ? colors.violet : colors.textFaint}
              />
            </Pressable>
          </View>
        </View>

        {showReplyBar && (
          <Pressable
            style={styles.viewReplies}
            onPress={() => setExpanded((prev) => ({ ...prev, [node.id]: true }))}
            hitSlop={6}
          >
            <View style={styles.threadLine} />
            <Text style={styles.viewRepliesText}>
              View {node.reply_count} {node.reply_count === 1 ? 'reply' : 'replies'}
            </Text>
            <Icon name="chevron-down" size={13} color={colors.textMuted} />
          </Pressable>
        )}

        {isOpen && node.replies.length > 0 && (
          <View style={styles.repliesWrap}>
            {node.replies.map((r) => renderReply(r, node.profile?.username ?? 'unknown'))}
            {node.reply_count > node.replies.length && (
              <Text style={styles.moreReplies}>
                {node.reply_count - node.replies.length} more{' '}
                {node.reply_count - node.replies.length === 1 ? 'reply' : 'replies'} hidden
              </Text>
            )}
          </View>
        )}
      </View>
    );
  };

  const hasText = !!text.trim();

  return (
    <Modal visible={!!post} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.sheet, { paddingBottom: padBottom }]}>
            <View style={styles.handle} />

            {/* search */}
            <View style={styles.searchRow}>
              <View style={styles.searchPill}>
                <Icon name="search-outline" size={16} color={colors.textFaint} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search comments"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="search"
                />
                {!!search && (
                  <Pressable onPress={() => setSearch('')} hitSlop={8}>
                    <Icon name="close-circle" size={16} color={colors.textFaint} />
                  </Pressable>
                )}
              </View>
            </View>

            {/* header */}
            <View style={styles.headerRow}>
              <Text style={styles.title}>
                {totalCount > 0 ? `${compactCount(totalCount)} comments` : 'Comments'}
              </Text>
              <View style={styles.headerActions}>
                <Pressable onPress={() => setSortOpen((v) => !v)} hitSlop={10} style={styles.headerBtn}>
                  <Icon name="options-outline" size={20} color={colors.textMuted} />
                </Pressable>
                <Pressable onPress={onClose} hitSlop={10} style={styles.headerBtn}>
                  <Icon name="close-outline" size={24} color={colors.text} />
                </Pressable>
              </View>
            </View>

            {sortOpen && (
              <View style={styles.sortMenu}>
                {SORTS.map((s) => (
                  <Pressable
                    key={s.key}
                    style={styles.sortItem}
                    onPress={() => {
                      setSort(s.key);
                      setSortOpen(false);
                    }}
                  >
                    <Text style={[styles.sortItemText, sort === s.key && styles.sortItemTextActive]}>{s.label}</Text>
                    {sort === s.key && <Icon name="checkmark" size={15} color={colors.accent} />}
                  </Pressable>
                ))}
              </View>
            )}

            {loading ? (
              <ActivityIndicator color={colors.accent} style={styles.loader} />
            ) : (
              <FlatList
                data={visible}
                keyExtractor={(c) => c.id}
                style={styles.list}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.listContent}
                renderItem={({ item }) => renderNode(item)}
                ListHeaderComponent={
                  dropReplies.length > 0 ? (
                    <View style={styles.dropReplySection}>
                      <View style={styles.dropReplyHeader}>
                        <Icon name="videocam-outline" size={13} color={colors.accent} />
                        <Text style={styles.dropReplyHeaderText}>Replied with a drop</Text>
                      </View>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {dropReplies.map((r) => (
                          <Pressable key={r.id} style={styles.dropCard} onPress={() => setViewing(r)}>
                            {r.media_url ? (
                              <Image source={{ uri: r.media_url }} style={styles.dropCardMedia} />
                            ) : (
                              <View
                                style={[
                                  styles.dropCardMedia,
                                  styles.dropCardTextMedia,
                                  r.text_bg ? { backgroundColor: r.text_bg } : null,
                                ]}
                              >
                                <Text
                                  style={[styles.dropCardText, r.text_color ? { color: r.text_color } : null]}
                                  numberOfLines={3}
                                >
                                  {r.content}
                                </Text>
                              </View>
                            )}
                            <View style={styles.dropCardFooter}>
                              <Avatar
                                url={r.profile?.avatar_url}
                                name={r.profile?.username ?? 'G'}
                                size={18}
                                verified={!!r.profile?.verified}
                              />
                              <Text style={styles.dropCardUser} numberOfLines={1}>
                                {r.profile?.username ?? 'unknown'}
                              </Text>
                            </View>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </View>
                  ) : null
                }
                ListEmptyComponent={
                  <Text style={styles.empty}>
                    {search ? 'No comments match that search.' : 'No comments yet. Be the first.'}
                  </Text>
                }
              />
            )}

            {replyingTo && (
              <View style={styles.replyingBar}>
                <Text style={styles.replyingBarText} numberOfLines={1}>
                  Replying to {replyingTo.username}
                </Text>
                <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
                  <Icon name="close" size={14} color={colors.textMuted} />
                </Pressable>
              </View>
            )}

            {emojiOpen && (
              <View style={styles.emojiStrip}>
                {QUICK_EMOJI.map((e) => (
                  <Pressable
                    key={e}
                    style={styles.emojiBtn}
                    onPress={() => setText((t) => `${t}${e}`)}
                    hitSlop={4}
                  >
                    <Text style={styles.emojiGlyph}>{e}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* composer */}
            <View style={styles.composer}>
              <Avatar url={me?.avatar_url} name={me?.username ?? 'G'} size={34} verified={!!me?.verified} />
              <View style={styles.composerField}>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  placeholder={replyingTo ? `Reply to ${replyingTo.username}...` : 'Add comment...'}
                  placeholderTextColor={colors.textFaint}
                  value={text}
                  onChangeText={setText}
                  multiline
                  onSubmitEditing={send}
                  blurOnSubmit={false}
                />
                <View style={styles.inputActions}>
                  {!!onReplyWithDrop && (
                    <Pressable onPress={onReplyWithDrop} hitSlop={8} style={styles.inputIcon}>
                      <Icon name="image-outline" size={20} color={colors.textMuted} />
                    </Pressable>
                  )}
                  <Pressable onPress={() => setEmojiOpen((v) => !v)} hitSlop={8} style={styles.inputIcon}>
                    <Icon
                      name="happy-outline"
                      size={20}
                      color={emojiOpen ? colors.accent : colors.textMuted}
                    />
                  </Pressable>
                  <Pressable onPress={() => setText((t) => `${t}@`)} hitSlop={8} style={styles.inputIcon}>
                    <Icon name="at-outline" size={20} color={colors.textMuted} />
                  </Pressable>
                </View>
              </View>
              {hasText && (
                <Pressable
                  style={[styles.sendBtn, sending && styles.disabled]}
                  onPress={send}
                  disabled={sending}
                  hitSlop={6}
                >
                  <Icon name="arrow-up" size={19} color={colors.bg} />
                </Pressable>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>

      {viewing && viewing.media_type === 'video' && viewing.media_url && (
        <VideoReplyViewer item={viewing} onClose={() => setViewing(null)} />
      )}
      {viewing && viewing.media_type !== 'video' && (
        <MediaReplyViewer item={viewing} onClose={() => setViewing(null)} />
      )}
    </Modal>
  );
}

function VideoReplyViewer({ item, onClose }: { item: DropReply; onClose: () => void }) {
  const player = useVideoPlayer({ uri: item.media_url! }, (p) => {
    p.loop = true;
    p.play();
  });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerWrap}>
        <VideoView player={player} style={styles.viewerMedia} contentFit="contain" nativeControls />
        <Pressable style={styles.viewerClose} onPress={onClose} hitSlop={10}>
          <Icon name="close" size={20} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

function MediaReplyViewer({ item, onClose }: { item: DropReply; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewerWrap}>
        {item.media_url ? (
          <Image source={{ uri: item.media_url }} style={styles.viewerMedia} resizeMode="contain" />
        ) : (
          <View
            style={[
              styles.viewerMedia,
              styles.viewerTextMedia,
              item.text_bg ? { backgroundColor: item.text_bg } : null,
            ]}
          >
            <Text style={[styles.viewerTextContent, item.text_color ? { color: item.text_color } : null]}>
              {item.content}
            </Text>
          </View>
        )}
        <Pressable style={styles.viewerClose} onPress={onClose} hitSlop={10}>
          <Icon name="close" size={20} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2,5,12,0.62)',
    justifyContent: 'flex-end',
  },
  scrim: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 8,
    maxHeight: '84%',
    minHeight: 320,
    width: '100%',
  },
  handle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 10,
  },
  searchRow: { paddingHorizontal: 14, marginBottom: 10 },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    padding: 0,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerBtn: { padding: 2 },
  sortMenu: {
    position: 'absolute',
    right: 16,
    top: 92,
    zIndex: 30,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    minWidth: 168,
    ...shadows.md,
  },
  sortItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 12,
  },
  sortItemText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  sortItemTextActive: { color: colors.text },
  loader: { paddingVertical: 40 },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { paddingBottom: 6 },
  row: { paddingHorizontal: 14 },
  rowMain: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10 },
  body: { flex: 1, paddingTop: 1 },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  username: { color: colors.text, fontSize: 13, fontWeight: '800', maxWidth: '70%' },
  badgeInline: { marginLeft: 1 },
  dotSep: { color: colors.textFaint, fontSize: 12, marginHorizontal: 1 },
  creatorTag: { color: colors.accent, fontSize: 11.5, fontWeight: '800' },
  commentText: { color: colors.text, fontSize: 14, lineHeight: 19, marginTop: 3 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  metaText: { color: colors.textFaint, fontSize: 12, fontWeight: '600' },
  rail: { alignItems: 'center', gap: 10, paddingTop: 3, width: 38 },
  railBtn: { alignItems: 'center', gap: 2 },
  railCount: { color: colors.textFaint, fontSize: 11, fontWeight: '700' },
  railCountActive: { color: colors.accent },
  viewReplies: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6, paddingLeft: 50 },
  threadLine: { width: 22, height: 1, backgroundColor: colors.borderStrong },
  viewRepliesText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  repliesWrap: { paddingLeft: 50, borderLeftWidth: 2, borderLeftColor: colors.border, marginLeft: 13, paddingRight: 4 },
  replyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 9 },
  replyingHint: { color: colors.textFaint, fontSize: 11.5, marginTop: 2 },
  replyingHintGlyph: { color: colors.textFaint },
  moreReplies: { color: colors.textFaint, fontSize: 12, fontWeight: '600', paddingVertical: 8 },
  dropReplySection: { paddingHorizontal: 14, paddingBottom: 8 },
  dropReplyHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  dropReplyHeaderText: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  dropCard: {
    width: 116,
    marginRight: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  dropCardMedia: { width: '100%', height: 116, backgroundColor: '#0A1220' },
  dropCardTextMedia: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  dropCardText: { color: colors.logoWhite, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  dropCardFooter: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 6 },
  dropCardUser: { flex: 1, color: colors.textMuted, fontSize: 10.5, fontWeight: '700' },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 30 },
  replyingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.accentSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginHorizontal: 14,
    marginTop: 8,
  },
  replyingBarText: { color: colors.accent, fontSize: 12, fontWeight: '700', flex: 1 },
  emojiStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: 6,
  },
  emojiBtn: { padding: 2 },
  emojiGlyph: { fontSize: 22 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    paddingHorizontal: 14,
    paddingTop: 10,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    maxHeight: 110,
    borderRadius: 20,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: 14,
    paddingRight: 6,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 9,
    paddingRight: 6,
    maxHeight: 96,
  },
  inputActions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 4 },
  inputIcon: { paddingVertical: 4 },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  disabled: { opacity: 0.5 },
  viewerWrap: {
    flex: 1,
    backgroundColor: 'rgba(2,4,10,0.97)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerMedia: { width: '100%', height: '80%' },
  viewerTextMedia: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    padding: 24,
    width: '90%',
    alignSelf: 'center',
  },
  viewerTextContent: { color: colors.logoWhite, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  viewerClose: {
    position: 'absolute',
    top: 52,
    right: 18,
    backgroundColor: 'rgba(3,6,14,0.75)',
    borderRadius: 999,
    padding: 10,
    zIndex: 10,
  },
});
