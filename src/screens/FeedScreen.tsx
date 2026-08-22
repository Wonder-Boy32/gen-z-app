import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewToken,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import LogoHeader from '../components/LogoHeader';
import DropCountdown from '../components/DropCountdown';
import FeedPost, { setFeedUserId } from '../components/FeedPost';
import CommentsModal from '../components/CommentsModal';
import DropExperienceScreen from './DropExperienceScreen';
import PublicProfileScreen from './PublicProfileScreen';

type Drop = {
  id: string;
  prompt: string;
  status: 'scheduled' | 'live' | 'voting' | 'closed';
  starts_at: string;
  ends_at: string;
  voting_ends_at: string;
};

type StoryUser = {
  id: string;
  username: string;
  avatar_url: string | null;
};

type FeedPostRow = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  content: string | null;
  audio: string | null;
  caption: string | null;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
  likes_count: number;
  comments_count: number;
  views_count: number;
  created_at: string;
  expires_at: string;
  drop_id: string | null;
  profile: { username: string; avatar_url: string | null; is_private: boolean } | null;
};

type FeedPostFull = FeedPostRow & {
  liked_by_me: boolean;
  following: boolean;
  follow_pending: boolean;
  saved_by_me: boolean;
  reposted_by_me: boolean;
  my_reaction: string | null;
  reactions_count: number;
};

const PAGE_SIZE = 50;

export default function FeedScreen({
  onJoinDrop,
  initialUserMode = null,
  initialAudioMode = null,
  initialHashtagMode = null,
}: {
  onJoinDrop?: () => void;
  initialUserMode?: string | null;
  initialAudioMode?: string | null;
  initialHashtagMode?: string | null;
}) {
  const { height } = useWindowDimensions();
  const [posts, setPosts] = useState<FeedPostFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [commentPost, setCommentPost] = useState<FeedPostFull | null>(null);
  const [activeDrop, setActiveDrop] = useState<Drop | null>(null);
  const [dropMode, setDropMode] = useState<string | null>(null);
  const [userMode, setUserMode] = useState<string | null>(initialUserMode);
  const [audioMode, setAudioMode] = useState<string | null>(initialAudioMode);
  const [hashtagMode, setHashtagMode] = useState<string | null>(initialHashtagMode);
  const [showDrop, setShowDrop] = useState(false);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);
  const [storyUsers, setStoryUsers] = useState<StoryUser[]>([]);
  const myIdRef = useRef<string | null>(null);

  // banner entrance + live halo animations
  const bannerAnim = useRef(new Animated.Value(0)).current;
  const bannerSlide = useRef(new Animated.Value(-14)).current;
  const haloPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!activeDrop) return;
    bannerAnim.setValue(0);
    bannerSlide.setValue(-14);
    Animated.parallel([
      Animated.timing(bannerAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(bannerSlide, { toValue: 0, friction: 7, tension: 90, useNativeDriver: true }),
    ]).start();
  }, [activeDrop?.id]);

  useEffect(() => {
    if (activeDrop?.status !== 'live') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(haloPulse, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(haloPulse, { toValue: 0, duration: 1100, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [activeDrop?.status]);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;
    setFeedUserId(user?.id ?? null);

    let query = supabase
      .from('posts')
      .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private)')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (dropMode) query = query.eq('drop_id', dropMode);
    else if (userMode) query = query.eq('user_id', userMode);
    else if (audioMode) query = query.eq('audio', audioMode);
    else if (hashtagMode) {
      const { data: tagRows } = await supabase
        .from('post_hashtags')
        .select('post_id')
        .eq('tag', hashtagMode)
        .limit(100);
      const postIds = (tagRows ?? []).map((r) => r.post_id);
      if (!postIds.length) {
        setPosts([]);
        setLoading(false);
        return;
      }
      query = query.in('id', postIds);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('feed load error', error.message);
      return;
    }

    const rows = (data ?? []) as FeedPostRow[];
    const ids = rows.map((p) => p.id);
    const userIds = [...new Set(rows.map((p) => p.user_id))];

    let liked = new Set<string>();
    let following = new Set<string>();
    let pending = new Set<string>();
    let saved = new Set<string>();
    let reposted = new Set<string>();
    let myReaction = new Map<string, string>();
    let reactionCounts = new Map<string, number>();

    if (user && ids.length) {
      const [l, f, s, r, rp] = await Promise.all([
        supabase.from('likes').select('post_id').in('post_id', ids).eq('user_id', user.id),
        userIds.length
          ? supabase
              .from('follows')
              .select('following_id, status')
              .eq('follower_id', user.id)
              .in('following_id', userIds)
          : Promise.resolve({ data: [] }),
        supabase.from('saved_posts').select('post_id').in('post_id', ids).eq('user_id', user.id),
        supabase.from('post_reactions').select('post_id, user_id, reaction').in('post_id', ids),
        supabase.from('reposts').select('post_id').in('post_id', ids).eq('user_id', user.id),
      ]);
      liked = new Set((l.data ?? []).map((x) => x.post_id));
      following = new Set((f.data ?? []).filter((x) => x.status === 'accepted').map((x) => x.following_id));
      pending = new Set((f.data ?? []).filter((x) => x.status === 'pending').map((x) => x.following_id));
      saved = new Set((s.data ?? []).map((x) => x.post_id));
      reposted = new Set((rp.data ?? []).map((x) => x.post_id));
      const counts = new Map<string, number>();
      (r.data ?? []).forEach((x: any) => {
        if (x.user_id === user.id) myReaction.set(x.post_id, x.reaction);
        counts.set(x.post_id, (counts.get(x.post_id) ?? 0) + 1);
      });
      reactionCounts = counts;
    }

    setPosts(
      rows.map((p) => ({
        ...p,
        liked_by_me: liked.has(p.id),
        following: following.has(p.user_id),
        follow_pending: pending.has(p.user_id),
        saved_by_me: saved.has(p.id),
        reposted_by_me: reposted.has(p.id),
        my_reaction: myReaction.get(p.id) ?? null,
        reactions_count: reactionCounts.get(p.id) ?? 0,
      }))
    );

    const { data: dropData } = await supabase
      .from('drops')
      .select('*')
      .in('status', ['live', 'voting'])
      .order('starts_at', { ascending: false })
      .limit(1);
    setActiveDrop((dropData?.[0] as Drop) ?? null);

    if (!userMode && !dropMode) {
      const { data: storyData } = await supabase
        .from('posts')
        .select('user_id, profile:profiles!posts_user_id_fkey(id, username, avatar_url)')
        .order('created_at', { ascending: false })
        .limit(40);
      const seen = new Set<string>();
      const users: StoryUser[] = [];
      (storyData ?? []).forEach((s: any) => {
        const p = s.profile;
        if (!p || p.id === user?.id || seen.has(p.id)) return;
        seen.add(p.id);
        users.push({ id: p.id, username: p.username, avatar_url: p.avatar_url });
      });
      setStoryUsers(users.slice(0, 12));
    }

    setLoading(false);
  }, [dropMode, userMode, audioMode, hashtagMode]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleLike = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me) return;
    const optimistic: FeedPostFull = {
      ...post,
      liked_by_me: !post.liked_by_me,
      likes_count: post.likes_count + (post.liked_by_me ? -1 : 1),
    };
    setPosts((prev) => prev.map((p) => (p.id === post.id ? optimistic : p)));
    if (post.liked_by_me) {
      const { error } = await supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', me);
      if (error) load();
    } else {
      const { error } = await supabase.from('likes').insert({ post_id: post.id, user_id: me });
      if (error) load();
    }
  };

  const toggleFollow = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me || me === post.user_id) return;
    if (post.following) {
      // unfollow
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, following: false } : p)));
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else if (post.follow_pending) {
      // cancel request
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, follow_pending: false } : p)));
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else {
      // follow — private accounts get a pending request
      const privateAccount = post.profile?.is_private ?? false;
      setPosts((prev) =>
        prev.map((p) =>
          p.id === post.id ? { ...p, following: !privateAccount, follow_pending: privateAccount } : p
        )
      );
      const { error } = await supabase.from('follows').insert({
        follower_id: me,
        following_id: post.user_id,
        status: privateAccount ? 'pending' : 'accepted',
      });
      if (error) load();
    }
  };

  const toggleSave = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me) return;
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, saved_by_me: !p.saved_by_me } : p)));
    if (post.saved_by_me) {
      await supabase.from('saved_posts').delete().eq('post_id', post.id).eq('user_id', me);
    } else {
      await supabase.from('saved_posts').insert({ post_id: post.id, user_id: me });
    }
  };
  const toggleRepost = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me) return;
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, reposted_by_me: !p.reposted_by_me } : p)));
    if (post.reposted_by_me) {
      await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', me);
    } else {
      await supabase.from('reposts').insert({ post_id: post.id, user_id: me });
    }
  };

  const toggleReaction = async (post: FeedPostFull, reaction: string) => {
    const me = myIdRef.current;
    if (!me) return;
    const next: FeedPostFull = {
      ...post,
      my_reaction: reaction || null,
      reactions_count: post.reactions_count - (post.my_reaction ? 1 : 0) + (reaction ? 1 : 0),
    };
    setPosts((prev) => prev.map((p) => (p.id === post.id ? next : p)));
    await supabase.from('post_reactions').delete().eq('post_id', post.id).eq('user_id', me);
    if (reaction) {
      await supabase.from('post_reactions').insert({ post_id: post.id, user_id: me, reaction });
    }
  };

  const recordView = useCallback(async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me || me === post.user_id) return;
    const { error } = await supabase.from('post_views').insert({ post_id: post.id, user_id: me });
    if (error && error.code !== '23505') console.warn('view error', error.message);
    if (!error) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, views_count: p.views_count + 1 } : p)));
    }
  }, []);

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (!viewableItems.length) return;
      const idx = viewableItems[0].index ?? 0;
      setActiveIndex(idx);
      recordView(viewableItems[0].item as FeedPostFull);
    },
    [recordView]
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const keyExtractor = (p: FeedPostFull) => p.id;

  const sharePost = (post: FeedPostFull) => {
    Share.share({
      message: `Check this out on Gen Z — @${post.profile?.username ?? 'someone'}: ${post.caption ?? post.content ?? ''}`,
    });
  };

  const storiesVisible =
    storyUsers.length > 0 && !dropMode && !userMode && !audioMode && !hashtagMode;
  const userModeName = storyUsers.find((u) => u.id === userMode)?.username;

  const renderItem = ({ item, index }: { item: FeedPostFull; index: number }) => (
    <FeedPost
      post={item}
      isActive={index === activeIndex}
      height={height}
      onLike={() => toggleLike(item)}
      onFollow={() => toggleFollow(item)}
      onComment={() => setCommentPost(item)}
      onShare={() => sharePost(item)}
      onSave={() => toggleSave(item)}
      onRepost={() => toggleRepost(item)}
      onOpenProfile={() =>
        setPublicProfile({ id: item.user_id, username: item.profile?.username ?? 'unknown' })
      }
      onReact={(r) => toggleReaction(item, r)}
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.topBrand} pointerEvents="none">
        <LogoHeader compact transparent />
      </View>

      {storiesVisible && (
        <View style={styles.storiesWrap}>
          <FlatList
            data={storyUsers}
            horizontal
            keyExtractor={(u) => u.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storiesContent}
            renderItem={({ item }) => (
              <Pressable style={styles.storyItem} onPress={() => setUserMode(item.id)}>
                <View style={styles.storyRing}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={styles.storyAvatar} />
                  ) : (
                    <View style={styles.storyAvatarPlaceholder}>
                      <Text style={styles.storyAvatarLetter}>
                        {item.username.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.storyName} numberOfLines={1}>
                  {item.username}
                </Text>
              </Pressable>
            )}
          />
        </View>
      )}

      {activeDrop && (
        <Animated.View
          style={[
            styles.dropBanner,
            {
              top: storiesVisible ? 190 : 100,
              opacity: bannerAnim,
              transform: [{ translateY: bannerSlide }],
            },
          ]}
        >
          <Pressable
            style={styles.dropBannerInner}
            onPress={() => {
              setUserMode(null);
              if (dropMode) setDropMode(null);
              else setShowDrop(true);
            }}
          >
            <View style={styles.liveHeader}>
              {activeDrop.status === 'live' ? (
                <View style={styles.liveBadge}>
                  <Animated.View
                    style={[
                      styles.liveHalo,
                      {
                        opacity: haloPulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.5] }),
                      },
                    ]}
                  />
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>LIVE</Text>
                </View>
              ) : (
                <View style={[styles.liveBadge, styles.votingBadge]}>
                  <Text style={[styles.liveText, styles.votingText]}>VOTING</Text>
                </View>
              )}
              <Text style={styles.dropBannerTitle}>{dropMode ? '📦 IN DROP' : '🚨 GEN Z DROP'}</Text>
            </View>

            <Text style={styles.dropBannerPrompt} numberOfLines={1}>
              “{activeDrop.prompt}”
            </Text>

            <View style={styles.bannerBottom}>
              {activeDrop.status === 'live' ? (
                <DropCountdown endsAt={activeDrop.ends_at} mode="live" />
              ) : (
                <DropCountdown endsAt={activeDrop.voting_ends_at} mode="voting" />
              )}
              {dropMode ? (
                <Text style={styles.bannerBack}>← Back to feed</Text>
              ) : (
                <View style={styles.joinPill}>
                  <Text style={styles.joinPillText}>JOIN DROP →</Text>
                </View>
              )}
            </View>
          </Pressable>
        </Animated.View>
      )}

      {(userMode || audioMode || hashtagMode) && (
        <Pressable
          style={[styles.dropBanner, { top: 100 }]}
          onPress={() => {
            setUserMode(null);
            setAudioMode(null);
            setHashtagMode(null);
          }}
        >
          <Text style={styles.dropBannerTitle}>
            ◉ VIEWING{' '}
            {userMode ? `@${userModeName ?? 'user'}` : audioMode ? `♪ ${audioMode}` : `#${hashtagMode}`}
          </Text>
          <Text style={styles.dropBannerPrompt} numberOfLines={1}>
            {userMode ? 'Their stories, last 48 hours' : 'Matching stories — last 48 hours'}
          </Text>
          <Text style={styles.dropBannerAction}>← Back to general feed</Text>
        </Pressable>
      )}

      {loading ? (
        <SkeletonFeed height={height} />
      ) : (
        <FlatList
          data={posts}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={height}
          decelerationRate="fast"
          onViewableItemsChanged={onViewable}
          viewabilityConfig={viewabilityConfig}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          windowSize={5}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>No stories yet</Text>
              <Text style={styles.emptyText}>
                Be the first to post — tap the plus button and drop something before it vanishes.
              </Text>
            </View>
          }
        />
      )}

      <CommentsModal
        post={commentPost}
        onClose={() => setCommentPost(null)}
        onPosted={() =>
          setPosts((prev) =>
            prev.map((p) => (p.id === commentPost?.id ? { ...p, comments_count: p.comments_count + 1 } : p))
          )
        }
      />

      {showDrop && activeDrop && (
        <DropExperienceScreen
          drop={activeDrop}
          onClose={() => setShowDrop(false)}
          onViewAll={() => {
            setDropMode(activeDrop.id);
            setShowDrop(false);
          }}
          onJoin={() => {
            setShowDrop(false);
            onJoinDrop?.();
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

function SkeletonFeed({ height }: { height: number }) {
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);
  return (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={[styles.skeletonBlock, { height, opacity: pulse }]}>
          <View style={styles.skeletonBar} />
          <View style={styles.skeletonCircle} />
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBrand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    alignItems: 'center',
    paddingTop: 48,
  },
  storiesWrap: {
    position: 'absolute',
    top: 96,
    left: 0,
    right: 0,
    zIndex: 8,
  },
  storiesContent: {
    paddingHorizontal: 16,
  },
  storyItem: {
    alignItems: 'center',
    marginRight: 14,
    width: 64,
  },
  storyRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: colors.accent,
    padding: 2,
    ...shadows.glow,
  },
  storyAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  storyAvatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storyAvatarLetter: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: '800',
  },
  storyName: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 5,
  },
  dropBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 9,
    alignSelf: 'center',
    marginHorizontal: 40,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 18,
    ...shadows.glow,
  },
  dropBannerInner: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  liveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,92,124,0.15)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  liveHalo: {
    position: 'absolute',
    left: 3,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.danger,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  liveText: {
    color: colors.danger,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginLeft: 5,
  },
  votingBadge: {
    backgroundColor: 'rgba(139,123,255,0.15)',
  },
  votingText: {
    color: colors.violet,
  },
  bannerBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  joinPill: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    ...shadows.glow,
  },
  joinPillText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  bannerBack: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
  dropBannerTitle: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  dropBannerPrompt: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 3,
  },
  dropBannerTime: {
    marginTop: 4,
  },
  dropBannerAction: {
    color: colors.cyan,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  skeletonWrap: {
    flex: 1,
  },
  skeletonBlock: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    justifyContent: 'flex-end',
    padding: 20,
    paddingBottom: 40,
  },
  skeletonBar: {
    width: '55%',
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
  },
  skeletonCircle: {
    position: 'absolute',
    top: 40,
    left: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceAlt,
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    backgroundColor: colors.bg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 20,
  },
});
