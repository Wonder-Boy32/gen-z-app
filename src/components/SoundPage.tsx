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
import { useInsets } from '../utils/useInsets';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { fmtCount } from './FeedPost';

type SoundRow = {
  id: string;
  name: string;
  artist: string | null;
  category: string;
  usage_count: number;
};

type PostRow = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
  profile: { username: string } | null;
};

export default function SoundPage({
  name,
  onClose,
  onUseSound,
}: {
  name: string;
  onClose: () => void;
  onUseSound: () => void;
}) {
  const insets = useInsets();
  const [sound, setSound] = useState<SoundRow | null>(null);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [s, p] = await Promise.all([
        supabase.from('sounds').select('*').eq('name', name).maybeSingle(),
        supabase
          .from('posts')
          .select('id, media_url, media_type, content, likes_count, comments_count, created_at, profile:profiles(username)')
          .eq('audio', name)
          .order('created_at', { ascending: false })
          .limit(40),
      ]);
      setSound((s.data as unknown as SoundRow) ?? null);
      setPosts((p.data ?? []) as unknown as PostRow[]);
      setLoading(false);
    })();
  }, [name]);

  const engagement = (p: PostRow) => p.likes_count * 1.5 + p.comments_count * 2.5 + (p.created_at ? 0.1 : 0);
  const trending = [...posts].sort((a, b) => engagement(b) - engagement(a)).slice(0, 8);
  const newest = [...posts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 8);

  const Thumb = ({ p }: { p: PostRow }) => (
    <View style={styles.thumb}>
      {p.media_url ? (
        <Image source={{ uri: p.media_url }} style={styles.thumbMedia} resizeMode="cover" />
      ) : (
        <View style={[styles.thumbMedia, styles.thumbTextBg]}>
          <Text style={styles.thumbText} numberOfLines={3}>
            {p.content ?? ''}
          </Text>
        </View>
      )}
      <View style={styles.thumbBadge}>
        <Text style={styles.thumbBadgeText}>♥ {fmtCount(p.likes_count)}</Text>
      </View>
    </View>
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
            <Text style={styles.title}>♪ Sound</Text>
            <View style={{ width: 20 }} />
          </View>
          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <>
              <Text style={styles.soundName}>{name}</Text>
              <Text style={styles.soundArtist}>{sound?.artist ?? 'Unknown artist'} · {sound?.category ?? ''}</Text>
              <View style={styles.countPill}>
                <Text style={styles.countText}>
                  {posts.length} active {posts.length === 1 ? 'Drop' : 'Drops'} using this sound
                </Text>
              </View>

              {trending.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>🔥 Trending with this sound</Text>
                  <FlatList
                    data={trending}
                    horizontal
                    keyExtractor={(p) => p.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => <Thumb p={item} />}
                  />
                </>
              )}
              {newest.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>🆕 New Drops</Text>
                  <FlatList
                    data={newest}
                    horizontal
                    keyExtractor={(p) => p.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => <Thumb p={item} />}
                  />
                </>
              )}
              {!posts.length && (
                <Text style={styles.empty}>No active Drops use this sound yet — be the first.</Text>
              )}
            </>
          )}
          <Pressable style={styles.useBtn} onPress={onUseSound}>
            <Text style={styles.useBtnText}>Use This Sound</Text>
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
  close: {
    color: colors.textMuted,
    fontSize: 18,
    padding: 4,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  loader: {
    paddingVertical: 30,
  },
  soundName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  soundArtist: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  countPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,122,0,0.14)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 10,
  },
  countText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    marginTop: 18,
    marginBottom: 10,
  },
  thumb: {
    width: 120,
    height: 170,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginRight: 10,
    backgroundColor: '#000',
  },
  thumbMedia: {
    width: '100%',
    height: '100%',
  },
  thumbTextBg: {
    backgroundColor: '#101A33',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
  thumbText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  thumbBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  thumbBadgeText: {
    color: colors.logoWhite,
    fontSize: 11,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
  useBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 16,
    ...shadows.glow,
  },
  useBtnText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
  },
});
