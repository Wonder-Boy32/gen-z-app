import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Avatar from './Avatar';
import { fmtCount } from './FeedPost';

export type ChainPost = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  caption: string | null;
  audio: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
  expires_at: string;
  profile: { username: string; avatar_url: string | null } | null;
};

const H = 3600 * 1000;

function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return '💨 Expired';
  const h = Math.floor(ms / H);
  const m = Math.floor((ms % H) / 60000);
  return `🔥 ${h}h ${m}m left`;
}

export default function ChainModal({
  root,
  onClose,
  onReplyWithDrop,
}: {
  root: ChainPost;
  onClose: () => void;
  onReplyWithDrop: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [children, setChildren] = useState<ChainPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('posts')
        .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url)')
        .eq('parent_drop_id', root.id)
        .order('created_at', { ascending: false })
        .limit(100);
      setChildren((data ?? []) as ChainPost[]);
      setLoading(false);
    })();
  }, [root.id]);

  const rows: (ChainPost & { isRoot: boolean })[] = [
    { ...root, isRoot: true },
    ...children.map((c) => ({ ...c, isRoot: false })),
  ];

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>🔗 Drop Chain</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Every response is its own Drop — 48 hours, no extensions.
          </Text>
          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(r) => r.id}
              style={styles.list}
              contentContainerStyle={{ paddingBottom: 12 }}
              renderItem={({ item }) => (
                <View style={[styles.card, item.isRoot && styles.rootCard]}>
                  <View style={styles.cardHeader}>
                    <Avatar url={item.profile?.avatar_url} name={item.profile?.username ?? 'G'} size={30} ring />
                    <View style={styles.cardNameWrap}>
                      <Text style={styles.cardName}>@{item.profile?.username ?? 'unknown'}</Text>
                      <Text style={styles.cardTime}>{timeLeft(item.expires_at)}</Text>
                    </View>
                    {!item.isRoot && (
                      <View style={styles.responseBadge}>
                        <Text style={styles.responseBadgeText}>↻ response</Text>
                      </View>
                    )}
                  </View>
                  {item.media_url ? (
                    <Image source={{ uri: item.media_url }} style={styles.thumb} resizeMode="cover" />
                  ) : (
                    <View style={[styles.thumb, styles.textThumb]}>
                      <Text style={styles.textThumbText} numberOfLines={4}>
                        {item.content ?? item.caption ?? ''}
                      </Text>
                    </View>
                  )}
                  <View style={styles.cardMeta}>
                    <Text style={styles.metaText}>♥ {fmtCount(item.likes_count)}</Text>
                    <Text style={styles.metaText}>💬 {fmtCount(item.comments_count)}</Text>
                    {!!item.audio && <Text style={styles.metaText} numberOfLines={1}>♪ {item.audio}</Text>}
                  </View>
                </View>
              )}
              ListEmptyComponent={
                <Text style={styles.empty}>No responses yet — start the chain.</Text>
              }
            />
          )}
          <Pressable style={styles.replyBtn} onPress={onReplyWithDrop}>
            <Text style={styles.replyBtnText}>🎥 Reply with Drop</Text>
          </Pressable>
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
    maxHeight: '80%',
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
    fontSize: 17,
    fontWeight: '800',
  },
  close: {
    color: colors.textMuted,
    fontSize: 18,
    padding: 4,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
    marginBottom: 10,
  },
  loader: {
    paddingVertical: 30,
  },
  list: {
    flexGrow: 0,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 10,
  },
  rootCard: {
    borderColor: colors.accent,
    ...shadows.glow,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardNameWrap: {
    flex: 1,
    marginLeft: 8,
  },
  cardName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  cardTime: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  responseBadge: {
    backgroundColor: 'rgba(139,123,255,0.16)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  responseBadgeText: {
    color: colors.violet,
    fontSize: 10,
    fontWeight: '700',
  },
  thumb: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    marginTop: 10,
    backgroundColor: '#000',
  },
  textThumb: {
    backgroundColor: '#101A33',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  textThumbText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  cardMeta: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 8,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 12,
    flexShrink: 1,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
  replyBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 6,
    ...shadows.glow,
  },
  replyBtnText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
  },
});
