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
import VerifiedBadge from '../components/ui/VerifiedBadge';
import PostViewer from '../components/PostViewer';
import ChatThread from './ChatThread';
import AnonymousSendScreen from './AnonymousSendScreen';
import { fetchStatuses, shortTimeLeft, type ProfileStatus } from '../services/profileStatus';

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
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  cover_url: string | null;
  text_bg: string | null;
  text_color: string | null;
  caption: string | null;
  audio: string | null;
  sound: string | null;
  sound_url: string | null;
  sound_start: number | null;
  sound_end: number | null;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
  parent_drop_id: string | null;
  content: string | null;
  drop_id: string | null;
  views_count: number;
  likes_count: number;
  comments_count: number;
  expires_at: string;
  created_at: string;
};

type Filter = 'all' | 'video' | 'text';

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Profile views ("who viewed my profile"). Recording is best-effort: if
// supabase/profile_views.sql has not been run yet the RPC does not exist, so
// we stop trying for the rest of the session instead of throwing on every
// profile open. One record per profile per app session - a remount is not a
// second visit.
let profileViewsMissing = false;
const profileViewsRecorded = new Set<string>();

export default function PublicProfileScreen({
  userId,
  username,
  onClose,
  onFollowChanged,
}: {
  userId: string;
  username: string;
  onClose: () => void;
  onFollowChanged?: (userId: string, following: boolean, pending: boolean) => void;
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
  const [viewer, setViewer] = useState<number | null>(null);
  const [anonOpen, setAnonOpen] = useState(false);
  const [mood, setMood] = useState<ProfileStatus | null>(null);

  // Read the other member's live mood, if they set one. A separate effect on the
  // resolved id, so the existing load() pipeline is untouched and a mood arriving
  // late never delays the profile itself.
  useEffect(() => {
    let alive = true;
    const id = profile?.id;
    if (!id) {
      setMood(null);
      return;
    }
    fetchStatuses([id])
      .then((map) => {
        if (alive) setMood(map[id] ?? null);
      })
      .catch(() => {
        // a missing mood is not worth surfacing as an error
        if (alive) setMood(null);
      });
    return () => {
      alive = false;
    };
  }, [profile?.id]);
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

    // the full profile query can fail on databases missing newer columns —
    // fall back to the core columns so the name + pic ALWAYS show
    let profData: Profile | null = null;
    if (prof?.data) {
      profData = prof.data as unknown as Profile;
    } else {
      const core = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, is_private, verified, created_at')
        .eq('id', userId)
        .maybeSingle();
      if (core?.data) {
        profData = {
          ...(core.data as unknown as Profile),
          location: null,
          pronouns: null,
          verified: false,
          streak_count: 0,
        };
      }
    }
    setProfile(profData);
    setFollowState((myFollow?.data?.status as 'pending' | 'accepted') === 'accepted' ? 'following' : myFollow?.data?.status === 'pending' ? 'pending' : 'none');
    setFollowers(fw.count ?? 0);
    setFollowing(fl.count ?? 0);

    // active content — RLS hides private accounts' posts from non-followers
    const { data: postRows } = await supabase
      .from('posts')
      .select(
        'id, user_id, media_url, media_type, media_items, cover_url, text_bg, text_color, caption, audio, sound, sound_url, sound_start, sound_end, effects, filters, text_layers, stickers, parent_drop_id, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at, allow_likes, allow_comments, allow_shares, allow_reposts, allow_downloads, allow_mentions, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified)'
      )
      .eq('user_id', userId)
      .is('parent_drop_id', null)
      .order('created_at', { ascending: false });
    const active = ((postRows ?? []) as Post[]).filter((p) => new Date(p.expires_at) > new Date());
    setPosts(active);
    const activeSum = active.reduce((s, p) => s + (p.likes_count ?? 0), 0);
    // Lifetime Likes: active posts + likes banked from expired/deleted posts.
    // The column may not exist yet (SQL not run) — treat that as 0, never
    // let it break the whole profile load.
    let lifetime = 0;
    try {
      const { data: ll } = await supabase
        .from('profiles')
        .select('lifetime_likes')
        .eq('id', userId)
        .maybeSingle();
      lifetime = (ll as any)?.lifetime_likes ?? 0;
    } catch {
      // column not added yet — active posts only
    }
    setTotalLikes(activeSum + lifetime);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Count this visit for the profile owner. Deliberately fire-and-forget so it
  // can never delay or break the screen, and the RPC also refuses self-views.
  useEffect(() => {
    if (profileViewsMissing || !userId || profileViewsRecorded.has(userId)) return;
    profileViewsRecorded.add(userId);
    (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || user.id === userId) return;
        const { error } = await supabase.rpc('record_profile_view', { p_profile: userId });
        if (error) profileViewsMissing = true;
      } catch {
        profileViewsMissing = true;
      }
    })();
  }, [userId]);

  const toggleFollow = async () => {
    const me = myIdRef.current;
    if (!me || me === userId) return;
    if (followState === 'following' || followState === 'pending') {
      setFollowState('none');
      setFollowers((v) => Math.max(0, v - 1));
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', userId);
      onFollowChanged?.(userId, false, false);
    } else {
      const privateAccount = profile?.is_private ?? false;
      setFollowState(privateAccount ? 'pending' : 'following');
      setFollowers((v) => v + 1);
      await supabase.from('follows').insert({
        follower_id: me,
        following_id: userId,
        status: privateAccount ? 'pending' : 'accepted',
      });
      onFollowChanged?.(userId, !privateAccount, privateAccount);
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

  // anonymous message flow
  if (anonOpen) {
    return (
      <Modal visible animationType="slide" onRequestClose={() => setAnonOpen(false)} statusBarTranslucent>
        <AnonymousSendScreen
          recipientId={userId}
          recipientName={profile?.username ?? username}
          onBack={() => setAnonOpen(false)}
        />
      </Modal>
    );
  }

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
                      name={profile?.display_name || profile?.username || username || 'G'}
                      size={88}
                      ring
                      verified={!!profile?.verified}
                    />
                  </View>

                  <View style={styles.nameRow}>
                    <Text style={styles.displayName} numberOfLines={1}>
                      {profile?.display_name || profile?.username || username || 'Gen Z user'}
                    </Text>
                    {profile?.verified && <VerifiedBadge size={18} style={styles.verifiedInline} />}
                  </View>
                  <Text style={styles.username}>@{profile?.username ?? username}</Text>

              {/* Read-only here: only the owner can set their own mood. */}
              {!!mood && (
                <View style={moodStyles.chip}>
                  <Text style={moodStyles.emoji}>{mood.emoji}</Text>
                  <Text style={moodStyles.label} numberOfLines={1}>
                    {mood.label}
                  </Text>
                  <Text style={moodStyles.time}>{shortTimeLeft(mood.expiresAt)}</Text>
                </View>
              )}

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
                  ) : null}
                  {!isOwn && (
                    <Pressable style={styles.anonSendBtn} onPress={() => setAnonOpen(true)}>
                      <Icon name="eye-off-outline" size={14} color={colors.accent} />
                      <Text style={styles.anonSendText}>Send me an anonymous message 👀</Text>
                    </Pressable>
                  )}
                  {isOwn ? (
                    <View style={styles.chip}>
                      <Icon name="person-circle-outline" size={14} color={colors.textMuted} />
                      <Text style={styles.chipText}>This is you</Text>
                    </View>
                  ) : null}

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
            renderItem={({ item, index: i }) => (
              <Pressable style={styles.tile} onPress={() => setViewer(i)}>
                {item.media_url ? (
                  item.media_type === 'video' && !item.cover_url ? (
                    <View style={styles.tileImage} />
                  ) : (
                    <Image
                      source={{ uri: item.media_type === 'video' ? item.cover_url! : item.media_url }}
                      style={styles.tileImage}
                      resizeMode="cover"
                    />
                  )
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
              </Pressable>
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

        {viewer !== null && (
          <View style={styles.viewerWrap}>
            <PostViewer posts={visiblePosts as any} index={viewer} onClose={() => setViewer(null)} />
          </View>
        )}
      </View>
    </Modal>
  );
}

// Kept in its own sheet so this feature cannot disturb existing profile styles.
const moodStyles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    maxWidth: '100%',
  },
  emoji: { fontSize: 14 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  time: { color: colors.accent, fontSize: 11, fontWeight: '700' },
});

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
  viewerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    backgroundColor: colors.bg,
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
  verifiedInline: {
    marginLeft: 6,
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
  anonSendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'stretch',
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,122,0,0.4)',
    backgroundColor: 'rgba(255,122,0,0.08)',
    borderRadius: 999,
    paddingVertical: 9,
  },
  anonSendText: { color: colors.accent, fontSize: 12.5, fontWeight: '800' },
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
