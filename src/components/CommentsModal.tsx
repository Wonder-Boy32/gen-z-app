import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useInsets } from '../utils/useInsets';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';

type CommentRow = {
  id: string;
  content: string;
  created_at: string;
  parent_id: string | null;
  profile: { username: string } | null;
};

type CommentNode = CommentRow & {
  replies: CommentNode[];
  reply_count: number;
};

type SortKey = 'newest' | 'discussed' | 'top';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'discussed', label: 'Most discussed' },
  { key: 'newest', label: 'Newest' },
  { key: 'top', label: 'Top replies' },
];

type Props = {
  post: { id: string } | null;
  onClose: () => void;
  onPosted: () => void;
  onReplyWithDrop: () => void;
};

export default function CommentsModal({ post, onClose, onPosted, onReplyWithDrop }: Props) {
  const insets = useInsets();
  const [roots, setRoots] = useState<CommentNode[]>([]);
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
      .select('id, content, created_at, parent_id, profile:profiles(username)')
      .eq('post_id', post.id)
      .limit(500);
    const rows = (data ?? []) as unknown as CommentRow[];
    // build thread tree
    const byId = new Map<string, CommentNode>();
    rows.forEach((r) => byId.set(r.id, { ...r, replies: [], reply_count: 0 }));
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
        // reply: refresh the tree so the reply count updates
        load();
      } else {
        setRoots((prev) => [...prev, { ...inserted, replies: [], reply_count: 0 }]);
      }
    }
    setSending(false);
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
            <Pressable style={styles.dropReplyBtn} onPress={onReplyWithDrop}>
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
            <FlatList
              data={sorted}
              keyExtractor={(c) => c.id}
              style={styles.list}
              renderItem={({ item }) => renderNode(item, 0)}
              ListEmptyComponent={<Text style={styles.empty}>No comments yet. Be the first.</Text>}
            />
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
    marginTop: 6,
  },
  replyAction: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
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
