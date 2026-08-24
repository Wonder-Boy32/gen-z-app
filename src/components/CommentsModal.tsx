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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';

type CommentRow = {
  id: string;
  content: string;
  created_at: string;
  profile: { username: string } | null;
};

type Props = {
  post: { id: string } | null;
  onClose: () => void;
  onPosted: () => void;
};

export default function CommentsModal({ post, onClose, onPosted }: Props) {
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!post) return;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from('comments')
        .select('id, content, created_at, profile:profiles(username)')
        .eq('post_id', post.id)
        .order('created_at', { ascending: true });
      setComments((data ?? []) as CommentRow[]);
      setLoading(false);
    })();
  }, [post?.id]);

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
      .insert({ post_id: post.id, user_id: user.id, content: clean })
      .select('id, content, created_at, profile:profiles(username)')
      .single();
    if (row) {
      setComments((prev) => [...prev, row as CommentRow]);
      setText('');
      onPosted();
    }
    setSending(false);
  };

  return (
    <Modal visible={!!post} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: 30 + insets.bottom }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Comments</Text>
          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <FlatList
              data={comments}
              keyExtractor={(c) => c.id}
              style={styles.list}
              renderItem={({ item }) => (
                <View style={styles.row}>
                  <Text style={styles.user}>@{item.profile?.username ?? 'unknown'}</Text>
                  <Text style={styles.text}>{item.content}</Text>
                </View>
              )}
              ListEmptyComponent={
                <Text style={styles.empty}>No comments yet. Be the first.</Text>
              }
            />
          )}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Add a comment..."
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
    maxHeight: '70%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
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
  user: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  text: {
    color: colors.text,
    fontSize: 14,
    marginTop: 3,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
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
