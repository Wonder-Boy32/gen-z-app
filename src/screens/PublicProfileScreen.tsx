import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Icon, { IconName } from '../components/ui/Icon';
import { notifyUser } from '../utils/notify';
import { TOP_INSET } from '../utils/useInsets';
import Button from '../components/Button';
import Avatar from '../components/Avatar';
import ChatThread from './ChatThread';

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  location: string | null;
  pronouns: string | null;
  verified: boolean;
  streak_count: number;
  is_private: boolean;
  created_at: string;
};

type Post = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  views_count: number;
  likes_count: number;
  expires_at: string;
};

type Filter = 'all' | 'video' | 'text';

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export default function PublicProfileScreen({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [totalLikes, setTotalLikes] = useState(0);
  const [followState, setFollowState] = useState<'none' | 'pending' | 'following'>('none');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;

    const [prof, myFollow, fw, fl] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, display_name, bio, avatar_url, location, pronouns, verified, streak_count, is_private, created_at')
        .eq('id', userId)
        .maybeSingle(),
      supabase.from('follows').select('status').eq('follower_id', user?.id ?? '').eq('following_id', userId).maybeSingle(),
      supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', userId),
    ]);

    setProfile((prof as Profile | null) ?? null);
    setFollowState((myFollow?.data?.status as 'pending' | 'accepted') === 'accepted' ? 'following' : myFollow?.data?.status === 'pending' ? 'pending' : 'none');
    setFollowers(fw.count ?? 0);
    setFollowing(fl.count ?? 0);

    // active content — RLS hides private accounts' posts from non-followers
    const { data: postRows } = await supabase
      .from('posts')
      .select('id, media_url, media_type, content, views_count, likes_count, expires_at')
      .eq('user_id', userId)
      .is('parent_drop_id', null)
      .order('created_at', { ascending: false });
    const active = ((postRows ?? []) as Post[]).filter((p) => new Date(p.expires_at) > new Date());
    setPosts(active);
    setTotalLikes(active.reduce((s, p) => s + (p.likes_count ?? 0), 0));
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFollow = async () => {
    const me = myIdRef.current;
    if (!me || me === userId) return;
    if (followState === 'following' || followState === 'pending') {
      setFollowState('none');
      setFollowers((v) => Math.max(0, v - 1));
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', userId);
    } else {
      const privateAccount = profile?.is_private ?? false;
      setFollowState(privateAccount ? 'pending' : 'following');
      setFollowers((v) => v + 1);
      await supabase.from('follows').insert({
        follower_id: me,
        following_id: userId,
        status: privateAccount ? 'pending' : 'accepted',
      });
      if (!privateAccount) {
        notifyUser({ userId, actorId: me, type: 'follow' });
      }
    }
  };

  // find-or-create a direct chat with this user, then open the thread
  const openChat = async () => {
    const me = myIdRef.current;
    if (!me || chatBusy) return;
    setChatBusy(true);
    try {
      const { data: mine } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', me);
      const ids = (mine ?? []).map((p) => p.conversation_id);
      if (ids.length) {
        const { data: existing } = await supabase
          .from('conversation_participants')
          .select('conversation_id')
          .in('conversation_id', ids)
          .eq('user_id', userId);
        if (existing?.length) {
          setThreadId(existing[0].conversation_id);
          return;
        }
      }
      const { data: conv } = await supabase
        .from('conversations')
        .insert({ type: 'direct' })
        .select('id')
        .single();
      if (!conv) return;
      await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: me });
      await supabase.from('conversation_participants').insert({ conversation_id: conv.id, user_id: userId });
      setThreadId(conv.id);
    } finally {
      setChatBusy(false);
    }
  };

  const shareProfile = () => {
    Share.share({
      message: `Check out @${profile?.username ?? username} on Gen Z — every story, gone in 48 hours!`,
    });
  };

  const isOwn = myIdRef.current === userId;

  const visiblePosts = useMemo(() => {
    if (filter === 'video') return posts.filter((p) => p.media_type === 'video');
    if (filter === 'text') return posts.filter((p) => !p.media_url && p.content);
    return posts;
  }, [posts, filter]);

  // if a chat is open, show the thread instead
  if (threadId) {
    return (
      <Modal visible animationType="slide" onRequestClose={() => setThreadId(null)} statusBarTranslucent>
        <ChatThread conversationId={threadId} onBack={() => setThreadId(null)} />
      </Modal>
    );
  }

  const stats: { label: string; value: number; icon: IconName; color: string }[] = [
    { label: 'Active', value: posts.length, icon: 'flame', color: colors.accent },
    { label: 'Likes', value: totalLikes, icon: 'heart', color: '#FF4D67' },
    { label: 'Followers', value: followers, icon: 'people', color: colors.cyan },
    { label: 'Following', value: following, icon: 'person-add', color: colors.violet },
  ];

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'video', label: 'Videos' },
    { key: 'text', label: 'Text' },
  ];

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn} hitSlop={8}>
            <Icon name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            @{profile?.username ?? username}
          </Text>
          <Pressable onPress={shareProfile} style={styles.shareBtn} hitSlop={8}>
            <Icon name="share-social-outline" size={20} color={colors.text} />
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : (
          <FlatList
            data={visiblePosts}
            keyExtractor={(p) => p.id}
            numColumns={3}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <View>
                {/* hero card */}
                <View style={styles.heroCard}>
                  <View style={styles.avatarWrap}>
                    <Avatar
                      url={profile?.avatar_url}
                      name={profile?.display_name || profile?.username || 'G'}
                      size={88}
                      ring
                    />
                    {profile?.verified && (
                      <View style={styles.verifiedBadge}>
                        <Icon name="checkmark" size={10} color={colors.bg} />
                      </View>
                    )}
                  </View>

                  <View style={styles.nameRow}>
                    <Text style={styles.displayName} numberOfLines={1}>
                      {profile?.display_name || profile?.username || 'Gen Z user'}
                    </Text>
                    {profile?.verified && <Icon name="checkmark-circle" size={17} color={colors.accent} />}
                  </View>
                  <Text style={styles.username}>@{profile?.username ?? 'unknown'}</Text>

                  {/* info chips */}
                  <View style={styles.chipRow}>
                    {!!profile?.location && (
                      <View style={styles.chip}>
                        <Icon name="location-outline" size={12} color={colors.textMuted} />
                        <Text style={styles.chipText}>{profile.location}</Text>
                      </View>
                    )}
                    {!!profile?.pronouns && (
                      <View style={styles.chip}>
                        <Text style={styles.chipText}>{profile.pronouns}</Text>
                      </View>
                    )}
                    {profile?.streak_count ? (
                      <View style={styles.chip}>
                        <Icon name="flame" size={12} color={colors.accent} />
                        <Text style={styles.chipText}>{profile.streak_count}d streak</Text>
                      </View>
                    ) : null}
                    {profile?.is_private && (
                      <View style={styles.chip}>
                        <Icon name="lock-closed" size={12} color={colors.accent} />
                        <Text style={styles.chipText}>Private</Text>
                      </View>
                    )}
                  </View>

                  {!!profile?.bio && <Text style={styles.bio}>{profile.bio}</Text>}
                  <Text style={styles.joinDate}>
                    Joined{' '}
                    {new Date(profile?.created_at ?? Date.now()).toLocaleDateString([], { month: 'long', year: 'numeric' })}
                  </Text>

                  {/* stats */}
                  <View style={styles.statsRow}>
                    {stats.map((s) => (
                      <View key={s.label} style={styles.stat}>
                        <View style={styles.statIconRow}>
                          <Icon name={s.icon} size={14} color={s.color} />
                          <Text style={styles.statNumber}>{fmtCount(s.value)}</Text>
                        </View>
                        <Text style={styles.statLabel}>{s.label}</Text>
                      </View>
                    ))}
                  </View>

                  {/* actions */}
                  {!isOwn ? (
                    <View style={styles.actionRow}>
                      <Button
                        variant={followState === 'following' ? 'secondary' : 'primary'}
                        title={
                          followState === 'following'
                            ? 'Following'
                            : followState === 'pending'
                              ? 'Requested'
                              : 'Follow'
                        }
                        onPress={toggleFollow}
                        style={styles.followBtn}
                      />
                      <Button variant="ghost" title="Message" onPress={openChat} style={styles.msgBtn} />
                    </View>
                  ) : (
                    <View style={styles.chip}>
                      <Icon name="person-circle-outline" size={14} color={colors.textMuted} />
                      <Text style={styles.chipText}>This is you</Text>
                    </View>
                  )}

                  {profile?.is_private && !isOwn && followState !== 'following' && (
                    <View style={styles.lockBox}>
                      <Icon name="lock-closed" size={13} color={colors.accent} />
                      <Text style={styles.lockText}>Private account — follow to see their stories</Text>
                    </View>
                  )}
                </View>

                {/* filter chips */}
                <View style={styles.filterRow}>
                  {FILTERS.map((f) => (
                    <Pressable
                      key={f.key}
                      style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
                      onPress={() => setFilter(f.key)}
                    >
                      <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>{f.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.tile}>
                {item.media_url ? (
                  <Image source={{ uri: item.media_url }} style={styles.tileImage} />
                ) : (
                  <View style={[styles.tileImage, styles.tileTextBg]}>
                    <Text style={styles.tileText} numberOfLines={3}>{item.content}</Text>
                  </View>
                )}
                {item.media_type === 'video' && (
                  <View style={styles.tileBadge}>
                    <Icon name="play" size={10} color={colors.logoWhite} />
                    <Text style={styles.tileBadgeText}>{fmtCount(item.views_count)}</Text>
                  </View>
                )}
                {(item.likes_count ?? 0) > 0 && (
                  <View style={[styles.tileBadge, styles.tileLikes]}>
                    <Icon name="heart" size={9} color={colors.accent} />
                    <Text style={styles.tileBadgeText}>{fmtCount(item.likes_count)}</Text>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {profile?.is_private && !isOwn && followState !== 'following'
                  ? 'Follow to see their active stories.'
                  : filter === 'all'
                    ? 'No active stories right now.'
                    : 'Nothing here yet.'}
              </Text>
            }
          />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: {
    width: 40,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  shareBtn: {
    width: 40,
    alignItems: 'flex-end',
  },
  loader: {
    flex: 1,
  },
  content: {
    padding: 14,
  },
  heroCard: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingVertical: 20,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  avatarWrap: {
    position: 'relative',
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    maxWidth: '90%',
  },
  displayName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  username: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  bio: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
    paddingHorizontal: 24,
    lineHeight: 18,
  },
  joinDate: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 8,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 16,
    width: '100%',
    justifyContent: 'space-around',
  },
  stat: {
    alignItems: 'center',
  },
  statIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statNumber: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
    width: '100%',
  },
  followBtn: {
    flex: 1,
  },
  msgBtn: {
    flex: 1,
  },
  lockBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: 10,
    marginTop: 14,
  },
  lockText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  filterChip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: colors.accent,
  },
  filterText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  filterTextActive: {
    color: colors.bg,
  },
  tile: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileTextBg: {
    backgroundColor: colors.surfaceAlt,
    padding: 6,
    justifyContent: 'center',
  },
  tileText: {
    color: colors.text,
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
  },
  tileBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tileLikes: {
    top: undefined,
    bottom: 6,
  },
  tileBadgeText: {
    color: colors.logoWhite,
    fontSize: 10,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingTop: 24,
  },
});
