import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
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
import { notifyUser } from '../utils/notify';

type CommentRow = {
  id: string;
  content: string;
  created_at: string;
  parent_id: string | null;
  user_id?: string;
  likes_count?: number;
  liked_by_me?: boolean;
  profile: { username: string } | null;
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
  profile: { username: string; avatar_url: string | null } | null;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type SortKey = 'newest' | 'discussed' | 'top';

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

type Props = {
  post: { id: string; user_id?: string } | null;
  onClose: () => void;
  onPosted: () => void;
  onReplyWithDrop?: () => void;
};

export default function CommentsModal({ post, onClose, onPosted, onReplyWithDrop }: Props) {
  const insets = useInsets();
  const [roots, setRoots] = useState<CommentNode[]>([]);
  const [dropReplies, setDropReplies] = useState<DropReply[]>([]);
  const [viewing, setViewing] = useState<DropReply | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('discussed');
  const [replyingTo, setReplyingTo] = useState<{ id: string; username: string } | null>(null);

  const load = useCallback(async () => {
    if (!post) return;
    setLoading(true);
    const { data } = await supabase
      .from('comments')
      .select('id, content, created_at, parent_id, user_id, profile:profiles(username)')
      .eq('post_id', post.id)
      .limit(500);
    const rows = (data ?? []) as unknown as CommentRow[];
    // build thread tree
    const byId = new Map<string, CommentNode>();
    rows.forEach((r) => byId.set(r.id, { ...r, replies: [], reply_count: 0, likes_count: 0, liked_by_me: false }));
    const rootList: CommentNode[] = [];
    rows.forEach((r) => {
      const node = byId.get(r.id)!;
      if (r.parent_id && byId.has(r.parent_id)) {
        byId.get(r.parent_id)!.replies.push(node);
        // count direct + nested replies
        let parent: CommentNode | undefined = byId.get(r.parent_id);
        while (parent) {
          parent.reply_count += 1;
          parent = parent.parent_id && byId.get(parent.parent_id) ? byId.get(parent.parent_id) : undefined;
        }
      } else {
        rootList.push(node);
      }
    });
    // reply-with-drop posts — they live in the comments, not the home feed
    const { data: replyRows } = await supabase
      .from('posts')
      .select(
        'id, user_id, media_url, media_type, content, text_bg, text_color, created_at, profile:profiles!posts_user_id_fkey(username, avatar_url)'
      )
      .eq('parent_drop_id', post.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setDropReplies((replyRows ?? []) as unknown as DropReply[]);

    // like counts + which ones I liked
    const ids = rows.map((r) => r.id);
    const me = (await supabase.auth.getUser()).data.user;
    const [lk, myLk] = await Promise.all([
      ids.length
        ? supabase.from('comment_likes').select('comment_id').in('comment_id', ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length && me
        ? supabase.from('comment_likes').select('comment_id').in('comment_id', ids).eq('user_id', me.id)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const likeCounts = new Map<string, number>();
    (lk.data ?? []).forEach((x: any) => likeCounts.set(x.comment_id, (likeCounts.get(x.comment_id) ?? 0) + 1));
    const mySet = new Set<string>((myLk.data ?? []).map((x: any) => x.comment_id));
    rows.forEach((r) => {
      const node = byId.get(r.id);
      if (node) {
        node.likes_count = likeCounts.get(r.id) ?? 0;
        node.liked_by_me = mySet.has(r.id);
      }
    });
    setRoots(rootList);
    setLoading(false);
  }, [post?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const sorted = [...roots].sort((a, b) => {
    if (sort === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (sort === 'discussed') return b.reply_count - a.reply_count || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    return b.reply_count - a.reply_count;
  });

  const send = async () => {
    const clean = text.trim();
    if (!clean || !post || sending) return;
    setSending(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data: row } = await supabase
      .from('comments')
      .insert({
        post_id: post.id,
        user_id: user.id,
        content: clean,
        parent_id: replyingTo?.id ?? null,
      })
      .select('id, content, created_at, parent_id, profile:profiles(username)')
      .single();
    if (row) {
      const inserted = row as unknown as CommentRow;
      setText('');
      setReplyingTo(null);
      onPosted();
      if (inserted.parent_id) {
        // reply: notify the comment owner, then refresh the tree
        const { data: parentRow } = await supabase
          .from('comments')
          .select('user_id')
          .eq('id', inserted.parent_id)
          .maybeSingle();
        const parentOwner = (parentRow as { user_id?: string } | null)?.user_id;
        if (parentOwner) {
          notifyUser({ userId: parentOwner, actorId: user.id, type: 'reply', postId: post.id, commentId: inserted.id });
        }
        load();
      } else {
        setRoots((prev) => [
          ...prev,
          { ...inserted, replies: [], reply_count: 0, user_id: user.id, likes_count: 0, liked_by_me: false },
        ]);
        // notify the post owner (fetch owner id if the caller didn't pass it)
        const ownerId = post.user_id ?? (await fetchPostOwner(post.id));
        if (ownerId) {
          notifyUser({ userId: ownerId, actorId: user.id, type: 'comment', postId: post.id, commentId: inserted.id });
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
    const me = (await supabase.auth.getUser()).data.user;
    if (!me) return;
    if (node.liked_by_me) {
      await supabase.from('comment_likes').delete().eq('comment_id', node.id).eq('user_id', me.id);
      updateNode(node.id, (n) => ({ ...n, liked_by_me: false, likes_count: Math.max(0, (n.likes_count ?? 1) - 1) }));
    } else {
      await supabase.from('comment_likes').insert({ comment_id: node.id, user_id: me.id });
      updateNode(node.id, (n) => ({ ...n, liked_by_me: true, likes_count: (n.likes_count ?? 0) + 1 }));
      if (node.user_id && post) {
        notifyUser({ userId: node.user_id, actorId: me.id, type: 'comment_like', postId: post.id, commentId: node.id });
      }
    }
  };

  const renderNode = (node: CommentNode, depth: number) => (
    <View key={node.id} style={[styles.row, depth > 0 && styles.replyRow]}>
      <Text style={styles.user}>
        @{node.profile?.username ?? 'unknown'}
        {node.reply_count > 0 && <Text style={styles.replyCount}>  · {node.reply_count} replies</Text>}
      </Text>
      <Text style={styles.text}>{node.content}</Text>
      <View style={styles.rowActions}>
        <Pressable
          onPress={() => setReplyingTo({ id: node.id, username: node.profile?.username ?? 'unknown' })}
          hitSlop={6}
        >
          <Text style={styles.replyAction}>Reply</Text>
        </Pressable>
        <Pressable onPress={() => toggleCommentLike(node)} hitSlop={8} style={styles.likeBtn}>
          <Icon
            name={node.liked_by_me ? 'heart' : 'heart-outline'}
            size={15}
            color={node.liked_by_me ? colors.accent : colors.textMuted}
          />
          {(node.likes_count ?? 0) > 0 && (
            <Text style={[styles.likeCount, node.liked_by_me && styles.likeCountActive]}>
              {node.likes_count}
            </Text>
          )}
        </Pressable>
      </View>
      {node.replies.map((r) => renderNode(r, depth + 1))}
    </View>
  );

  return (
    <Modal visible={!!post} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: 30 + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>Comments</Text>
            <Pressable style={styles.dropReplyBtn} onPress={() => onReplyWithDrop?.()}>
              <Text style={styles.dropReplyText}>🎥 Reply with Drop</Text>
            </Pressable>
          </View>
          <View style={styles.sortRow}>
            {SORTS.map((s) => (
              <Pressable
                key={s.key}
                style={[styles.sortChip, sort === s.key && styles.sortChipActive]}
                onPress={() => setSort(s.key)}
              >
                <Text style={[styles.sortText, sort === s.key && styles.sortTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <>
              {dropReplies.length > 0 && (
                <View style={styles.dropReplySection}>
                  <View style={styles.dropReplyHeader}>
                    <Icon name="videocam-outline" size={13} color={colors.accent} />
                    <Text style={styles.dropReplyHeaderText}>Replied with a drop</Text>
                  </View>
                  {dropReplies.map((r) => (
                    <Pressable key={r.id} style={styles.dropReplyRow} onPress={() => setViewing(r)}>
                      <Avatar url={r.profile?.avatar_url} name={r.profile?.username ?? 'G'} size={28} ring />
                      <View style={styles.dropReplyBody}>
                        <Text style={styles.dropReplyUser} numberOfLines={1}>
                          @{r.profile?.username ?? 'unknown'}
                        </Text>
                        <Text style={styles.dropReplyMeta}>
                          {r.media_type === 'video' ? 'Video drop' : r.media_url ? 'Photo drop' : 'Text drop'} ·{' '}
                          {timeAgo(r.created_at)}
                        </Text>
                      </View>
                      {r.media_url ? (
                        <Image source={{ uri: r.media_url }} style={styles.dropReplyThumb} />
                      ) : (
                        <View
                          style={[
                            styles.dropReplyThumb,
                            styles.dropReplyThumbText,
                            r.text_bg ? { backgroundColor: r.text_bg } : null,
                          ]}
                        >
                          <Text
                            style={[styles.dropReplyThumbTextContent, r.text_color ? { color: r.text_color } : null]}
                            numberOfLines={2}
                          >
                            {r.content}
                          </Text>
                        </View>
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
              <FlatList
                data={sorted}
                keyExtractor={(c) => c.id}
                style={styles.list}
                renderItem={({ item }) => renderNode(item, 0)}
                ListEmptyComponent={<Text style={styles.empty}>No comments yet. Be the first.</Text>}
              />
            </>
          )}
          {replyingTo && (
            <View style={styles.replyingBar}>
              <Text style={styles.replyingText}>Replying to @{replyingTo.username}</Text>
              <Pressable onPress={() => setReplyingTo(null)} hitSlop={6}>
                <Text style={styles.replyingX}>✕</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder={replyingTo ? `Reply to @${replyingTo.username}...` : 'Add a comment...'}
              placeholderTextColor={colors.textFaint}
              value={text}
              onChangeText={setText}
              onSubmitEditing={send}
            />
            <Pressable
              style={[styles.sendBtn, (!text.trim() || sending) && styles.disabled]}
              onPress={send}
              disabled={!text.trim() || sending}
            >
              <Text style={styles.sendText}>Post</Text>
            </Pressable>
          </View>
        </View>
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
          <Text style={styles.viewerCloseText}>✕</Text>
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
          <Text style={styles.viewerCloseText}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
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
    paddingBottom: 30,
    maxHeight: '75%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  dropReplyBtn: {
    backgroundColor: 'rgba(255,122,0,0.16)',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 10,
  },
  dropReplyText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  sortRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  sortChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.surfaceAlt,
  },
  sortChipActive: {
    backgroundColor: 'rgba(255,122,0,0.18)',
  },
  sortText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  sortTextActive: {
    color: colors.accent,
  },
  loader: {
    paddingVertical: 30,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  replyRow: {
    marginLeft: 18,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    paddingLeft: 12,
  },
  user: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  replyCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },
  text: {
    color: colors.text,
    fontSize: 14,
    marginTop: 3,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 6,
  },
  replyAction: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  likeCount: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  likeCountActive: {
    color: colors.accent,
  },
  dropReplySection: {
    marginBottom: 8,
  },
  dropReplyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  dropReplyHeaderText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  dropReplyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 7,
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    marginBottom: 7,
  },
  dropReplyBody: { flex: 1 },
  dropReplyUser: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
  dropReplyMeta: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 1,
  },
  dropReplyThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#0A1220',
  },
  dropReplyThumbText: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 5,
  },
  dropReplyThumbTextContent: {
    color: colors.logoWhite,
    fontSize: 9,
    fontWeight: '700',
  },
  viewerWrap: {
    flex: 1,
    backgroundColor: 'rgba(2,4,10,0.97)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerMedia: {
    width: '100%',
    height: '80%',
  },
  viewerTextMedia: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    padding: 24,
    width: '90%',
    alignSelf: 'center',
  },
  viewerTextContent: {
    color: colors.logoWhite,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 52,
    right: 18,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    padding: 10,
    zIndex: 10,
  },
  viewerCloseText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
  },
  replyingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(139,123,255,0.12)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 10,
  },
  replyingText: {
    color: colors.violet,
    fontSize: 12,
    fontWeight: '600',
  },
  replyingX: {
    color: colors.textMuted,
    fontSize: 14,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  sendBtn: {
    marginLeft: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    ...shadows.glow,
  },
  sendText: {
    color: colors.bg,
    fontSize: 14,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
});
