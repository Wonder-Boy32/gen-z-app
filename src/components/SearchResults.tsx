import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import DropVideoView from './DropVideoView';
import Icon from './ui/Icon';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import DropExperienceScreen from '../screens/DropExperienceScreen';
import PublicProfileScreen from '../screens/PublicProfileScreen';
import { fmtCount } from './FeedPost';
import Avatar from './Avatar';
import VerifiedBadge from './ui/VerifiedBadge';

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

type Drop = {
  id: string;
  prompt: string;
  status: 'scheduled' | 'live' | 'voting' | 'closed';
  starts_at: string;
  ends_at: string;
  voting_ends_at: string;
};

type Props = {
  query: string;
  onPickQuery: (q: string) => void;
  onOpenUser: (id: string) => void;
  onOpenAudio: (audio: string) => void;
  onOpenTag: (tag: string) => void;
  onJoinDrop: () => void;
};

export default function SearchResults({ query, onPickQuery, onOpenUser, onOpenAudio, onOpenTag, onJoinDrop }: Props) {
  const [users, setUsers] = useState<{ id: string; username: string; avatar_url: string | null }[]>([]);
  const [posts, setPosts] = useState<P[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [sounds, setSounds] = useState<{ audio: string; count: number }[]>([]);
  const [drops, setDrops] = useState<Drop[]>([]);
  const [history, setHistory] = useState<{ query: string }[]>([]);
  const [trending, setTrending] = useState<{ query: string; searches: number }[]>([]);
  const [mayKnow, setMayKnow] = useState<{ id: string; username: string; avatar_url: string | null }[]>([]);
  const [because, setBecause] = useState<{ id: string; username: string; avatar_url: string | null }[]>([]);
  const [popular, setPopular] = useState<{ id: string; username: string; avatar_url: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<P | null>(null);
  const [openDrop, setOpenDrop] = useState<Drop | null>(null);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);

  const loadIdle = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const me = user?.id ?? null;

    const [{ data: h }, { data: t }, { data: allProfiles }, { data: allFollows }, { data: myFollowRows }] =
      await Promise.all([
        me
          ? supabase.from('search_history').select('query').eq('user_id', me).order('created_at', { ascending: false }).limit(8)
          : Promise.resolve({ data: [] }),
        supabase.rpc('get_trending_searches', { limit_n: 6 }),
        supabase.from('profiles').select('id, username, avatar_url, verified').limit(200),
        supabase.from('follows').select('follower_id, following_id').limit(1000),
        me
          ? supabase.from('follows').select('following_id').eq('follower_id', me).limit(500)
          : Promise.resolve({ data: [] }),
      ]);
    setHistory((h ?? []) as { query: string }[]);
    setTrending((t ?? []) as { query: string; searches: number }[]);

    // these are already the rows from the destructured responses above, not
    // response objects - reading .data here made all three silently empty
    const profiles = (allProfiles ?? []) as { id: string; username: string; avatar_url: string | null }[];
    const follows = (allFollows ?? []) as { follower_id: string; following_id: string }[];
    const myFollowing = new Set(
      ((myFollowRows ?? []) as { following_id: string }[]).map((f) => f.following_id)
    );

    const followerCount = new Map<string, number>();
    follows.forEach((f) => followerCount.set(f.following_id, (followerCount.get(f.following_id) ?? 0) + 1));

    const notMe = profiles.filter((p) => p.id !== me);
    const notFollowed = notMe.filter((p) => !myFollowing.has(p.id));

    // how many of my followings follow each user (2-hop affinity)
    const affinity = new Map<string, number>();
    follows.forEach((f) => {
      if (myFollowing.has(f.follower_id) && f.following_id !== me && !myFollowing.has(f.following_id)) {
        affinity.set(f.following_id, (affinity.get(f.following_id) ?? 0) + 1);
      }
    });

    setMayKnow(
      [...notFollowed]
        .sort((a, b) => (affinity.get(b.id) ?? 0) - (affinity.get(a.id) ?? 0))
        .slice(0, 8)
    );

    const becauseList: { id: string; username: string; avatar_url: string | null }[] = [];
    [...affinity.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([id]) => {
        const p = notMe.find((x) => x.id === id);
        if (p) becauseList.push(p);
      });
    setBecause(becauseList.slice(0, 8));

    setPopular(
      [...notFollowed]
        .sort((a, b) => (followerCount.get(b.id) ?? 0) - (followerCount.get(a.id) ?? 0))
        .slice(0, 8)
    );
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      loadIdle();
      setUsers([]);
      setPosts([]);
      setTags([]);
      setSounds([]);
      setDrops([]);
    }
  }, [query]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    const t = setTimeout(async () => {
      const [u, p, tg, s, d] = await Promise.all([
        supabase.from('profiles').select('id, username, avatar_url, verified').ilike('username', `%${q}%`).limit(10),
        supabase
          .from('posts')
          .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, verified)')
          .or(`caption.ilike.%${q}%,content.ilike.%${q}%,audio.ilike.%${q}%`)
          .is('parent_drop_id', null)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('hashtags').select('tag, count').ilike('tag', `%${q}%`).order('count', { ascending: false }).limit(10),
        supabase.from('posts').select('audio').not('audio', 'is', null).ilike('audio', `%${q}%`).limit(20),
        supabase.from('drops').select('*').ilike('prompt', `%${q}%`).order('starts_at', { ascending: false }).limit(5),
      ]);
      setUsers((u.data ?? []) as { id: string; username: string; avatar_url: string | null }[]);
      setPosts((p.data ?? []) as P[]);
      setTags((tg.data ?? []) as { tag: string; count: number }[]);
      const soundMap = new Map<string, number>();
      (s.data ?? []).forEach((x: any) => {
        if (!x.audio) return;
        soundMap.set(x.audio, (soundMap.get(x.audio) ?? 0) + 1);
      });
      setSounds(
        [...soundMap.entries()]
          .map(([audio, count]) => ({ audio, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8)
      );
      setDrops((d.data ?? []) as Drop[]);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const record = async (q: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('search_history')
      .upsert({ user_id: user.id, query: q, created_at: new Date().toISOString() }, { onConflict: 'user_id,query' });
  };

  const clearHistory = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('search_history').delete().eq('user_id', user.id);
    loadIdle();
  };

  const pick = (q: string) => {
    record(q);
    onPickQuery(q);
  };

  if (!query.trim()) {
    return (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {history.length > 0 && (
          <>
            <View style={styles.rowHeader}>
              <Text style={styles.title}>Recent searches</Text>
              <Pressable onPress={clearHistory} hitSlop={8}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            </View>
            <View style={styles.chipWrap}>
              {history.map((h) => (
                <Pressable key={h.query} style={styles.chip} onPress={() => pick(h.query)}>
                  <Text style={styles.chipText}>🕒 {h.query}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {trending.length > 0 && (
          <>
            <Text style={styles.title}>Trending searches</Text>
            <View style={styles.chipWrap}>
              {trending.map((t, i) => (
                <Pressable key={t.query} style={styles.chip} onPress={() => pick(t.query)}>
                  <View style={styles.statRow}>
                    {i < 2 && <Icon name="flame" size={12} color={colors.accent} />}
                    <Text style={styles.chipText}>{t.query}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {mayKnow.length > 0 && (
          <>
            <Text style={styles.title}>People you may know</Text>
            <SuggestionRow users={mayKnow} onOpenProfile={setPublicProfile} />
          </>
        )}

        {because.length > 0 && (
          <>
            <Text style={styles.title}>Because you follow...</Text>
            <SuggestionRow users={because} onOpenProfile={setPublicProfile} />
          </>
        )}

        {popular.length > 0 && (
          <>
            <Text style={styles.title}>Popular in GEN Z</Text>
            <SuggestionRow users={popular} onOpenProfile={setPublicProfile} />
          </>
        )}

        {publicProfile && (
          <PublicProfileScreen
            userId={publicProfile.id}
            username={publicProfile.username}
            onClose={() => setPublicProfile(null)}
          />
        )}
      </ScrollView>
    );
  }

  const hasResults = users.length || posts.length || tags.length || sounds.length || drops.length;

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {searching && <ActivityIndicator color={colors.accent} style={styles.spinner} />}

      {!hasResults && !searching && <Text style={styles.noResults}>No results for “{query}”</Text>}

      {users.length > 0 && (
        <>
          <Text style={styles.title}>Users</Text>
          {users.map((u) => (
            <Pressable
              key={u.id}
              style={styles.userRow}
              onPress={() => {
                record(query);
                setPublicProfile({ id: u.id, username: u.username });
              }}
            >
              <Avatar url={u.avatar_url} name={u.username} size={40} ring verified={!!(u as any).verified} />
              <View style={styles.userNameRow}>
                <Text style={styles.userName}>@{u.username}</Text>
                {!!(u as any).verified && <VerifiedBadge size={12} style={styles.verifiedInline} />}
              </View>
            </Pressable>
          ))}
        </>
      )}

      {posts.length > 0 && (
        <>
          <Text style={styles.title}>Posts</Text>
          <View style={styles.grid}>
            {posts.slice(0, 12).map((p) => (
              <Pressable
                key={p.id}
                style={styles.tile}
                onPress={() => {
                  record(query);
                  setSelected(p);
                }}
              >
                {p.cover_url || (p.media_type === 'image' && p.media_url) ? (
                  <Image source={{ uri: p.cover_url ?? p.media_url! }} style={styles.tileImage} resizeMode="cover" />
                ) : p.media_type === 'video' ? (
                  <View style={[styles.tileImage, styles.videoPh]}>
                    <Icon name="play" size={16} color={colors.logoWhite} />
                  </View>
                ) : (
                  <View style={[styles.tileImage, styles.tileTextBg, p.text_bg ? { backgroundColor: p.text_bg } : null]}>
                    <Text style={[styles.tileText, p.text_color ? { color: p.text_color } : null]} numberOfLines={3}>{p.content}</Text>
                  </View>
                )}
                <View style={styles.statRow}>
                  <Icon name="heart" size={11} color={colors.accent} />
                  <Text style={styles.tileLikes}>{fmtCount(p.likes_count)}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {tags.length > 0 && (
        <>
          <Text style={styles.title}>Hashtags</Text>
          <View style={styles.chipWrap}>
            {tags.map((t) => (
              <Pressable
                key={t.tag}
                style={styles.chip}
                onPress={() => {
                  record(query);
                  onOpenTag(t.tag);
                }}
              >
                <Text style={styles.chipText}>#{t.tag}</Text>
                <Text style={styles.chipCount}>{t.count}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {sounds.length > 0 && (
        <>
          <Text style={styles.title}>Sounds</Text>
          <View style={styles.chipWrap}>
            {sounds.map((s) => (
              <Pressable
                key={s.audio}
                style={styles.chip}
                onPress={() => {
                  record(query);
                  onOpenAudio(s.audio);
                }}
              >
                <View style={styles.statRow}>
                  <Icon name="musical-note" size={12} color={colors.cyan} />
                  <Text style={styles.chipText}>{s.audio}</Text>
                </View>
                <Text style={styles.chipCount}>{s.count}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {drops.length > 0 && (
        <>
          <Text style={styles.title}>Drops</Text>
          {drops.map((d) => (
            <Pressable
              key={d.id}
              style={styles.dropRow}
              onPress={() => {
                record(query);
                setOpenDrop(d);
              }}
            >
              <Text style={styles.dropStatus}>{d.status === 'live' ? '● LIVE' : d.status === 'voting' ? '🗳 VOTING' : '💨 CLOSED'}</Text>
              <Text style={styles.dropPrompt} numberOfLines={1}>“{d.prompt}”</Text>
            </Pressable>
          ))}
        </>
      )}

      <PostModal post={selected} onClose={() => setSelected(null)} />

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
    </ScrollView>
  );
}

function SuggestionRow({
  users,
  onOpenProfile,
}: {
  users: { id: string; username: string; avatar_url: string | null }[];
  onOpenProfile: (u: { id: string; username: string }) => void;
}) {
  return (
    <FlatList
      data={users}
      horizontal
      keyExtractor={(s) => s.id}
      showsHorizontalScrollIndicator={false}
      renderItem={({ item }) => (
        <Pressable style={styles.suggestCard} onPress={() => onOpenProfile({ id: item.id, username: item.username })}>
          <Avatar url={item.avatar_url} name={item.username} size={64} ring verified={!!(item as any).verified} />
          <View style={styles.suggestNameRow}>
            <Text style={styles.suggestName} numberOfLines={1}>@{item.username}</Text>
            {!!(item as any).verified && <VerifiedBadge size={11} glow={false} />}
          </View>
        </Pressable>
      )}
    />
  );
}

function PostModal({ post, onClose }: { post: P | null; onClose: () => void }) {
  return (
    <Modal visible={!!post} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        {post && (
          <>
            <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={10}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
            <View style={styles.media}>
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
                <Image source={{ uri: post.media_url }} style={styles.media} resizeMode="contain" />
              ) : (
                <View style={[styles.media, styles.mediaTextBg]}>
                  <Text style={styles.mediaText}>{post.content}</Text>
                </View>
              )}
            </View>
            <View style={styles.info}>
              <Text style={styles.infoUser}>@{post.profile?.username ?? 'unknown'}</Text>
              {!!post.caption && <Text style={styles.infoCaption}>{post.caption}</Text>}
              <View style={styles.stats}>
                <View style={styles.statRow}>
                  <Icon name="heart" size={13} color={colors.logoWhite} />
                  <Text style={styles.stat}>{fmtCount(post.likes_count)}</Text>
                </View>
                <View style={styles.statRow}>
                  <Icon name="chatbubble-ellipses-outline" size={13} color={colors.logoWhite} />
                  <Text style={styles.stat}>{fmtCount(post.comments_count)}</Text>
                </View>
                <View style={styles.statRow}>
                  <Icon name="eye-outline" size={14} color={colors.logoWhite} />
                  <Text style={styles.stat}>{fmtCount(post.views_count)}</Text>
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
  content: {
    padding: 20,
    paddingTop: 8,
    paddingBottom: 40,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 14,
    marginBottom: 10,
  },
  clearText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  suggestCard: {
    width: 92,
    alignItems: 'center',
    marginRight: 14,
  },
  suggestAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  suggestAvatarPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestLetter: {
    color: colors.accent,
    fontSize: 24,
    fontWeight: '800',
  },
  suggestNameRow: { flexDirection: "row", alignItems: "center", marginTop: 6, justifyContent: "center" },
  suggestName: {
    color: colors.text,
    fontSize: 11,
    marginTop: 5,
  },
  spinner: {
    marginVertical: 16,
  },
  noResults: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 30,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  userAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  userAvatarPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userLetter: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '700',
  },
  userNameRow: { flexDirection: "row", alignItems: "center" },
  verifiedInline: { marginLeft: 4 },
  userName: {
    color: colors.text,
    fontSize: 14,
    marginLeft: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tile: {
    width: '31%',
    aspectRatio: 0.85,
    borderRadius: radius.sm,
    overflow: 'hidden',
    margin: '1%',
    backgroundColor: colors.surface,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileTextBg: {
    backgroundColor: colors.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  videoPh: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A1220' },
  videoPhText: { color: colors.textMuted, fontSize: 18, fontWeight: '800' },
  tileText: {
    color: colors.text,
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
  },
  tileLikes: {
    position: 'absolute',
    bottom: 5,
    left: 6,
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  dropRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 8,
  },
  dropStatus: {
    color: colors.danger,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  dropPrompt: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(3,6,14,0.92)',
    justifyContent: 'center',
    padding: 20,
  },
  closeBtn: {
    position: 'absolute',
    top: 54,
    right: 20,
    zIndex: 10,
  },
  closeText: {
    color: colors.text,
    fontSize: 22,
  },
  media: {
    width: '100%',
    height: '62%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  mediaTextBg: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  mediaText: {
    color: colors.text,
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
    fontWeight: '600',
  },
  info: {
    marginTop: 16,
  },
  infoUser: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  infoCaption: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
  },
  stats: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 18,
  },
  stat: {
    color: colors.textMuted,
    fontSize: 13,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
