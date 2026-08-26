import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import DropVideoView from '../components/DropVideoView';
import Icon from '../components/ui/Icon';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import DropCountdown from '../components/DropCountdown';
import DropExperienceScreen from './DropExperienceScreen';
import PublicProfileScreen from './PublicProfileScreen';
import SearchResults from '../components/SearchResults';
import { fmtCount } from '../components/FeedPost';
import Avatar from '../components/Avatar';

type Drop = {
  id: string;
  prompt: string;
  status: 'scheduled' | 'live' | 'voting' | 'closed';
  starts_at: string;
  ends_at: string;
  voting_ends_at: string;
};

type P = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  cover_url: string | null;
  text_bg: string | null;
  text_color: string | null;
  content: string | null;
  caption: string | null;
  audio: string | null;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
  likes_count: number;
  comments_count: number;
  views_count: number;
  expires_at: string;
  profile: { username: string; avatar_url: string | null } | null;
};

type Props = {
  onOpenUser: (id: string) => void;
  onOpenAudio: (audio: string) => void;
  onOpenTag: (tag: string) => void;
  onJoinDrop: () => void;
};

const engagement = (p: P) => p.likes_count + p.comments_count + p.views_count;

export default function DiscoverScreen({ onOpenUser, onOpenAudio, onOpenTag, onJoinDrop }: Props) {
  const [posts, setPosts] = useState<P[]>([]);
  const [drops, setDrops] = useState<(Drop & { posts: number })[]>([]);
  const [creators, setCreators] = useState<{ id: string; username: string; avatar_url: string | null }[]>([]);
  const [sounds, setSounds] = useState<{ audio: string; count: number }[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<P | null>(null);
  const [openDrop, setOpenDrop] = useState<Drop | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const me = user?.id ?? null;

    const [{ data: postRows }, { data: dropRows }, { data: creatorRows }, { data: soundRows }, { data: tagRows }] =
      await Promise.all([
        supabase
          .from('posts')
          .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url)')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('drops')
          .select('*')
          .in('status', ['live', 'voting'])
          .order('starts_at', { ascending: false })
          .limit(3),
        supabase
          .from('profiles')
          .select('id, username, avatar_url, created_at')
          .neq('id', me ?? '')
          .order('created_at', { ascending: false })
          .limit(8),
        supabase.from('posts').select('audio').not('audio', 'is', null).limit(500),
        supabase.from('hashtags').select('tag, count').order('count', { ascending: false }).limit(8),
      ]);

    setPosts((postRows ?? []) as P[]);

    const dropsWithPosts: (Drop & { posts: number })[] = [];
    for (const d of (dropRows ?? []) as Drop[]) {
      const { count } = await supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('drop_id', d.id);
      dropsWithPosts.push({ ...d, posts: count ?? 0 });
    }
    setDrops(dropsWithPosts);

    setCreators((creatorRows ?? []) as { id: string; username: string; avatar_url: string | null }[]);

    const soundMap = new Map<string, number>();
    (soundRows ?? []).forEach((s: any) => {
      if (!s.audio) return;
      soundMap.set(s.audio, (soundMap.get(s.audio) ?? 0) + 1);
    });
    setSounds(
      [...soundMap.entries()]
        .map(([audio, count]) => ({ audio, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6)
    );

    setTags((tagRows ?? []) as { tag: string; count: number }[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const trendingVideos = useMemo(
    () => posts.filter((p) => p.media_type === 'video').sort((a, b) => engagement(b) - engagement(a)).slice(0, 10),
    [posts]
  );
  const watching = useMemo(
    () => [...posts].sort((a, b) => engagement(b) - engagement(a)).slice(0, 8),
    [posts]
  );

  const renderCard = (p: P) => (
    <Pressable style={styles.videoCard} onPress={() => setSelected(p)}>
      <CardMedia post={p} />
      <View style={styles.cardOverlay}>
        <View style={styles.statRow}>
          <Icon name="heart" size={12} color={colors.logoWhite} />
          <Text style={styles.cardLikes}>{fmtCount(p.likes_count)}</Text>
        </View>
        <Text style={styles.cardUser} numberOfLines={1}>@{p.profile?.username ?? 'unknown'}</Text>
      </View>
    </Pressable>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchHeader}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search users, sounds, tags..."
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {!!searchQuery && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
              <Text style={styles.searchClear}>✕</Text>
            </Pressable>
          )}
        </View>
      </View>

      {searchQuery.trim() ? (
        <SearchResults
          query={searchQuery.trim()}
          onPickQuery={setSearchQuery}
          onOpenUser={onOpenUser}
          onOpenAudio={onOpenAudio}
          onOpenTag={onOpenTag}
          onJoinDrop={onJoinDrop}
        />
      ) : (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.sectionTitleRow}>
          <Icon name="flame" size={16} color={colors.accent} />
          <Text style={styles.sectionTitle}>Trending Now</Text>
        </View>
        {trendingVideos.length ? (
          <FlatList
            data={trendingVideos}
            horizontal
            keyExtractor={(p) => p.id}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => renderCard(item)}
          />
        ) : (
          <Text style={styles.empty}>Nothing trending yet — post something.</Text>
        )}

        {/* 🚨 Live Drops */}
        <Text style={styles.sectionTitle}>🚨 Live Drops</Text>
        {drops.length ? (
          <FlatList
            data={drops}
            horizontal
            keyExtractor={(d) => d.id}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable style={styles.dropCard} onPress={() => setOpenDrop(item)}>
                <Text style={styles.dropStatus}>{item.status === 'live' ? '● LIVE' : '🗳 VOTING'}</Text>
                <Text style={styles.dropPrompt} numberOfLines={2}>
                  “{item.prompt}”
                </Text>
                <DropCountdown
                  endsAt={item.status === 'live' ? item.ends_at : item.voting_ends_at}
                  mode={item.status}
                />
                <Text style={styles.dropPosts}>{item.posts} submissions</Text>
              </Pressable>
            )}
          />
        ) : (
          <Text style={styles.empty}>No drops live right now — the next one is coming.</Text>
        )}

        {/* 👀 Everyone Is Watching */}
        <Text style={styles.sectionTitle}>👀 Everyone Is Watching</Text>
        <View style={styles.grid}>
          {watching.map((p) => (
            <Pressable key={p.id} style={styles.gridTile} onPress={() => setSelected(p)}>
              <CardMedia post={p} />
              <View style={styles.gridOverlay}>
                <View style={styles.statRow}>
                  <Icon name="heart" size={11} color={colors.logoWhite} />
                  <Text style={styles.gridLikes}>{fmtCount(p.likes_count)}</Text>
                </View>
                <Text style={styles.gridViews}>{fmtCount(p.views_count)} views</Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* ✨ New Creators */}
        <Text style={styles.sectionTitle}>✨ New Creators</Text>
        <FlatList
          data={creators}
          horizontal
          keyExtractor={(c) => c.id}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => (
            <Pressable style={styles.creatorCard} onPress={() => setPublicProfile({ id: item.id, username: item.username })}>
              <Avatar url={item.avatar_url} name={item.username} size={72} ring />
              <Text style={styles.creatorName} numberOfLines={1}>@{item.username}</Text>
              <Text style={styles.creatorCta}>View stories</Text>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No new creators yet.</Text>}
        />

        <View style={styles.sectionTitleRow}>
          <Icon name="musical-notes" size={16} color={colors.cyan} />
          <Text style={styles.sectionTitle}>Trending Sounds</Text>
        </View>
        <View style={styles.chipWrap}>
          {sounds.map((s) => (
            <Pressable key={s.audio} style={styles.chip} onPress={() => onOpenAudio(s.audio)}>
              <View style={styles.statRow}>
                <Icon name="musical-note" size={12} color={colors.cyan} />
                <Text style={styles.chipText}>{s.audio}</Text>
              </View>
              <Text style={styles.chipCount}>{s.count} posts</Text>
            </Pressable>
          ))}
          {!sounds.length && <Text style={styles.empty}>No sounds yet — add one to your post.</Text>}
        </View>

        {/* #️⃣ Trending Tags */}
        <Text style={styles.sectionTitle}>#️⃣ Trending Tags</Text>
        <View style={styles.chipWrap}>
          {tags.map((t) => (
            <Pressable key={t.tag} style={styles.chip} onPress={() => onOpenTag(t.tag)}>
              <Text style={styles.chipText}>#{t.tag}</Text>
              <Text style={styles.chipCount}>{t.count} posts</Text>
            </Pressable>
          ))}
          {!tags.length && <Text style={styles.empty}>No tags yet — add #tags to your caption.</Text>}
        </View>
      </ScrollView>
      )}

      <PostDetailModal post={selected} onClose={() => setSelected(null)} />

      {openDrop && (
        <DropExperienceScreen
          drop={openDrop}
          onClose={() => setOpenDrop(null)}
          onViewAll={() => setOpenDrop(null)}
          onJoin={() => {
            setOpenDrop(null);
            onJoinDrop();
          }}
        />
      )}

      {publicProfile && (
        <PublicProfileScreen
          userId={publicProfile.id}
          username={publicProfile.username}
          onClose={() => setPublicProfile(null)}
        />
      )}
    </View>
  );
}

function CardMedia({ post }: { post: P }) {
  const src = post.cover_url || (post.media_type === 'image' ? post.media_url : null);
  if (src) {
    return <Image source={{ uri: src }} style={styles.cardMedia} resizeMode="cover" />;
  }
  if (post.media_type === 'video') {
    return (
      <View style={[styles.cardMedia, styles.videoPh]}>
        <Text style={styles.videoPhText}>▶ {post.views_count}</Text>
      </View>
    );
  }
  if (post.media_url) {
    return <Image source={{ uri: post.media_url }} style={styles.cardMedia} resizeMode="cover" />;
  }
  return (
    <View style={[styles.cardMedia, styles.cardTextBg, post.text_bg ? { backgroundColor: post.text_bg } : null]}>
      <Text style={[styles.cardText, post.text_color ? { color: post.text_color } : null]} numberOfLines={3}>{post.content}</Text>
    </View>
  );
}

function PostDetailModal({ post, onClose }: { post: P | null; onClose: () => void }) {
  return (
    <Modal visible={!!post} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.detailOverlay}>
        {post && (
          <>
            <Pressable style={styles.detailClose} onPress={onClose} hitSlop={10}>
              <Text style={styles.detailCloseText}>✕</Text>
            </Pressable>
            <View style={styles.detailMedia}>
              {post.media_type === 'video' && post.media_url ? (
                <DropVideoView
                  url={post.media_url}
                  effects={post.effects}
                  filters={post.filters}
                  textLayers={post.text_layers}
                  stickers={post.stickers}
                  isActive
                  contentFit="contain"
                  showProgress={false}
                  showMute={false}
                />
              ) : post.media_url ? (
                <Image source={{ uri: post.media_url }} style={styles.detailMedia} resizeMode="contain" />
              ) : (
                <View style={[styles.detailMedia, styles.detailTextBg]}>
                  <Text style={styles.detailText}>{post.content}</Text>
                </View>
              )}
            </View>
            <View style={styles.detailInfo}>
              <Text style={styles.detailUser}>@{post.profile?.username ?? 'unknown'}</Text>
              {!!post.caption && <Text style={styles.detailCaption}>{post.caption}</Text>}
              {!!post.audio && (
                <View style={styles.statRow}>
                  <Icon name="musical-note" size={12} color={colors.cyan} />
                  <Text style={styles.detailAudio}>{post.audio}</Text>
                </View>
              )}
              <View style={styles.detailStats}>
                <View style={styles.statRow}>
                  <Icon name="heart" size={13} color={colors.logoWhite} />
                  <Text style={styles.detailStat}>{fmtCount(post.likes_count)}</Text>
                </View>
                <View style={styles.statRow}>
                  <Icon name="chatbubble-ellipses-outline" size={13} color={colors.logoWhite} />
                  <Text style={styles.detailStat}>{fmtCount(post.comments_count)}</Text>
                </View>
                <View style={styles.statRow}>
                  <Icon name="eye-outline" size={14} color={colors.logoWhite} />
                  <Text style={styles.detailStat}>{fmtCount(post.views_count)}</Text>
                </View>
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  searchHeader: {
    paddingTop: TOP_INSET + 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: colors.bg,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 14,
  },
  searchClear: {
    color: colors.textMuted,
    fontSize: 15,
    padding: 4,
  },
  content: {
    paddingTop: TOP_INSET + 16,
    paddingBottom: 40,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 20,
    marginBottom: 12,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  videoCard: {
    width: 130,
    height: 210,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginLeft: 20,
    backgroundColor: colors.surface,
  },
  cardMedia: {
    width: '100%',
    height: 170,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  videoPh: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A1220' },
  videoPhText: { color: colors.textMuted, fontSize: 20, fontWeight: '800' },
  cardTextBg: {
    backgroundColor: colors.surfaceAlt,
    padding: 8,
    justifyContent: 'center',
  },
  cardText: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  cardOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 8,
    backgroundColor: 'rgba(3,6,14,0.55)',
  },
  cardLikes: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  cardUser: {
    color: colors.logoWhite,
    fontSize: 11,
    marginTop: 2,
  },
  dropCard: {
    width: 230,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: 14,
    marginLeft: 20,
    ...shadows.glow,
  },
  dropStatus: {
    color: colors.danger,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  dropPrompt: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 10,
    lineHeight: 20,
  },
  dropPosts: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
  },
  gridTile: {
    width: '48%',
    aspectRatio: 0.9,
    borderRadius: radius.md,
    overflow: 'hidden',
    margin: '1%',
    backgroundColor: colors.surface,
  },
  gridOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
    backgroundColor: 'rgba(3,6,14,0.55)',
  },
  gridLikes: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  gridViews: {
    color: colors.logoWhite,
    fontSize: 11,
  },
  creatorCard: {
    width: 96,
    alignItems: 'center',
    marginLeft: 20,
  },
  creatorAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  creatorAvatarPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  creatorLetter: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '800',
  },
  creatorName: {
    color: colors.text,
    fontSize: 12,
    marginTop: 6,
    maxWidth: 96,
  },
  creatorCta: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
  },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    margin: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chipText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  chipCount: {
    color: colors.textMuted,
    fontSize: 11,
    marginLeft: 8,
  },
  detailOverlay: {
    flex: 1,
    backgroundColor: 'rgba(3,6,14,0.92)',
    justifyContent: 'center',
    padding: 20,
  },
  detailClose: {
    position: 'absolute',
    top: 54,
    right: 20,
    zIndex: 10,
  },
  detailCloseText: {
    color: colors.text,
    fontSize: 22,
  },
  detailMedia: {
    width: '100%',
    height: '62%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  detailTextBg: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  detailText: {
    color: colors.text,
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
    fontWeight: '600',
  },
  detailInfo: {
    marginTop: 16,
  },
  detailUser: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  detailCaption: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
  },
  detailAudio: {
    color: colors.cyan,
    fontSize: 13,
    marginTop: 4,
  },
  detailStats: {
    flexDirection: 'row',
    marginTop: 12,
  },
  detailStat: {
    color: colors.textMuted,
    fontSize: 13,
    marginRight: 18,
  },
});
