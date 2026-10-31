import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import NeonGradientFill from '../components/ui/NeonGradient';
import Button from '../components/Button';
import NeonButton from '../components/ui/NeonButton';
import Icon, { IconName } from '../components/ui/Icon';
import { FILL, GradientFill } from '../components/ui/Futuristic';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import AvatarPickerModal from '../components/AvatarPickerModal';
import PostViewer from '../components/PostViewer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PeopleScreen from './PeopleScreen';
import SettingsScreen from './SettingsScreen';
import ProfileViewersScreen, { PROFILE_VIEWS_SEEN_KEY } from './ProfileViewersScreen';
import AnonymousSettingsModal from '../components/AnonymousSettingsModal';
import { useSheetPad } from '../utils/useSheetPad';
import AnonymousCardModal from '../components/AnonymousCardModal';
import MoodStatusModal from '../components/MoodStatusModal';
import { fetchMyStatus, shortTimeLeft, type ProfileStatus } from '../services/profileStatus';
import { useAndroidBack } from '../utils/useAndroidBack';
import * as ImagePicker from 'expo-image-picker';
import { uploadMedia } from '../utils/upload';
import { useUploads } from '../utils/uploadManager';
import { friendlyError } from '../utils/friendlyError';

type Profile = {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  location: string | null;
  region: string | null;
  pronouns: string | null;
  verified: boolean;
  streak_count: number;
  created_at: string;
  is_private: boolean;
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
  liked_by_me?: boolean;
  following?: boolean;
  follow_pending?: boolean;
  saved_by_me?: boolean;
  reposted_by_me?: boolean;
  my_reaction?: string | null;
  reactions_count?: number;
  profile: { username: string; avatar_url: string | null; is_private: boolean; region: string | null } | null;
};

type RepostRow = Post;

type Tab = 'active' | 'videos' | 'reposts' | 'saved';

const H48 = 48 * 3600 * 1000;

export default function ProfileScreen({
  onOpenDropsFeed,
  onPostToFeed,
}: {
  onOpenDropsFeed?: (userId: string) => void;
  onPostToFeed?: (uri: string) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ list: (Post | RepostRow)[]; index: number } | null>(null);
  const [avatarSheet, setAvatarSheet] = useState(false);
  const [avatarFull, setAvatarFull] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [reposts, setReposts] = useState<RepostRow[]>([]);
  const [saved, setSaved] = useState<Post[]>([]);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [totalLikes, setTotalLikes] = useState(0);
  const [tab, setTab] = useState<Tab>('active');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [anonSettingsOpen, setAnonSettingsOpen] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  const [mood, setMood] = useState<ProfileStatus | null>(null);

  // The mood lives in its own table and gets its own read, deliberately separate
  // from load() so the existing profile pipeline is untouched. It reads the live
  // view, so an expired mood comes back null instead of needing a client check.
  const loadMood = useCallback(async () => {
    setMood(await fetchMyStatus());
  }, []);

  useEffect(() => {
    loadMood();
  }, [loadMood]);
  const [anonCardOpen, setAnonCardOpen] = useState(false);
  const [peopleMode, setPeopleMode] = useState<'followers' | 'following' | null>(null);
  const [viewersOpen, setViewersOpen] = useState(false);

  // Android back control. Settings, the follower/following list and the viewers
  // list all replace this screen wholesale (early returns, not <Modal>s), so
  // each one is a real navigation level and back must peel off exactly one.
  useAndroidBack(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return true;
    }
    if (peopleMode) {
      setPeopleMode(null);
      return true;
    }
    if (viewersOpen) {
      setViewersOpen(false);
      return true;
    }
    return false;
  });
  const [unseenViews, setUnseenViews] = useState(0);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const [{ data: prof }, { data: myPosts }, { data: repostRows }, { data: savedRows }, fw, fl] =
      await Promise.all([
        supabase
          .from('profiles')
          .select('username, display_name, bio, avatar_url, cover_url, location, region, pronouns, verified, streak_count, created_at, is_private')
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('posts')
          .select(
            'id, user_id, media_url, media_type, media_items, cover_url, text_bg, text_color, caption, audio, sound, sound_url, sound_start, sound_end, effects, filters, text_layers, stickers, parent_drop_id, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at, allow_likes, allow_comments, allow_shares, allow_reposts, allow_downloads, allow_mentions, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified)'
          )
          .eq('user_id', user.id)
          .is('parent_drop_id', null) // reply-with-drop posts are comments, not grid content
          .order('created_at', { ascending: false }),
        supabase
          .from('reposts')
          .select(
            'post_id, post:posts!reposts_post_id_fkey(id, user_id, media_url, media_type, media_items, cover_url, text_bg, text_color, caption, audio, sound, sound_url, sound_start, sound_end, effects, filters, text_layers, stickers, parent_drop_id, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at, allow_likes, allow_comments, allow_shares, allow_reposts, allow_downloads, allow_mentions, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified))'
          )
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('saved_posts')
          .select(
            'post_id, post:posts!saved_posts_post_id_fkey(id, user_id, media_url, media_type, media_items, cover_url, text_bg, text_color, caption, audio, sound, sound_url, sound_start, sound_end, effects, filters, text_layers, stickers, parent_drop_id, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at, allow_likes, allow_comments, allow_shares, allow_reposts, allow_downloads, allow_mentions, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified))'
          )
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', user.id),
        supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', user.id),
      ]);

    setProfile((prof as Profile | null) ?? null);
    setMyId(user.id);
    // Hide drops past their expiry. PublicProfileScreen already does exactly this
    // (its own `active` filter); this screen never did, so YOUR OWN ended drops
    // kept sitting in your grid — the owner can always read their own rows, so
    // RLS does not hide them from you even when it hides them from everyone else.
    // The row itself is removed by the genz_purge_expired() cron job; this only
    // stops it being DISPLAYED in the meantime (or if that job is not running).
    setPosts(((myPosts ?? []) as unknown as Post[]).filter((p) => new Date(p.expires_at) > new Date()));
    setReposts(((repostRows ?? []).map((r: any) => r.post).filter(Boolean)) as unknown as RepostRow[]);
    setSaved(((savedRows ?? []).map((s: any) => s.post).filter(Boolean)) as unknown as Post[]);
    setFollowing(fw.count ?? 0);
    setFollowers(fl.count ?? 0);
    const activeSum = ((myPosts ?? []) as unknown as Post[]).reduce((sum, p) => sum + (p.likes_count ?? 0), 0);
    // Lifetime Likes: active posts + likes banked from expired/deleted posts.
    // The column may not exist yet (SQL not run) — treat that as 0, never
    // let it break the whole profile load.
    let lifetime = 0;
    try {
      const { data: ll } = await supabase
        .from('profiles')
        .select('lifetime_likes')
        .eq('id', user.id)
        .maybeSingle();
      lifetime = (ll as any)?.lifetime_likes ?? 0;
    } catch {
      // column not added yet — active posts only
    }
    setTotalLikes(activeSum + lifetime);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Pull in a drop that was made a moment ago.
  //
  // Posting no longer completes on the create screen — uploadManager owns it and
  // inserts the row when the bytes land. This grid was therefore built BEFORE that
  // row existed, so a fresh post was missing from the user's own profile. Refetch
  // when a job reports done, the same way HomeScreen refreshes the feed.
  //
  // The ref starts at 0 on purpose: if the upload finished while this screen was
  // still unmounted, the first render must still refetch once.
  const uploads = useUploads();
  const uploadsDone = uploads.filter((u) => u.status === 'done').length;
  const postedRefreshRef = React.useRef(0);
  useEffect(() => {
    if (uploadsDone > postedRefreshRef.current) void load();
    postedRefreshRef.current = uploadsDone;
  }, [uploadsDone, load]);

  // Unseen profile views, for the badge on the eye icon. Best-effort: if
  // supabase/profile_views.sql has not been run the RPC errors and the badge
  // simply stays hidden — nothing else on this screen is affected.
  const loadUnseenViews = useCallback(async () => {
    try {
      const seenAt = await AsyncStorage.getItem(PROFILE_VIEWS_SEEN_KEY);
      const { data, error } = await supabase.rpc('my_profile_view_stats', { p_since: seenAt ?? null });
      if (error) {
        setUnseenViews(0);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      setUnseenViews(Number((row as { unseen?: number } | null)?.unseen ?? 0));
    } catch {
      setUnseenViews(0);
    }
  }, []);

  useEffect(() => {
    loadUnseenViews();
  }, [loadUnseenViews]);

  const openViewers = () => {
    // everything is about to be on screen, so drop the badge immediately
    setUnseenViews(0);
    setViewersOpen(true);
  };

  // long-press a tile/card to delete your own post
  const confirmDelete = (p: Post) => {
    if (p.user_id !== myId) return;
    Alert.alert('Delete drop?', 'This removes it everywhere — likes, comments and replies go too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!myId) return;
          await supabase.from('posts').delete().eq('id', p.id).eq('user_id', myId);
          setPosts((prev) => prev.filter((x) => x.id !== p.id));
          setReposts((prev) => prev.filter((x) => x.id !== p.id));
          setSaved((prev) => prev.filter((x) => x.id !== p.id));
        },
      },
    ]);
  };

  const shareProfile = () => {
    Share.share({
              message: `Check out @${profile?.username ?? 'unknown'} on Gen Z — every story, gone in 7 days!`,
    });
  };

  const shareAnonLink = () => setAnonCardOpen(true);

  const achievements = useAchievements(profile, posts, totalLikes);
  const activePosts = posts; // RLS already returns only unexpired posts

  // Average engagement per drop, from this profile's own rows: a like counts 1,
  // a comment 2, because a comment costs the reader more. Deliberately a plain
  // average of real numbers rather than a weighted 0–10 score, which would look
  // like a metric the app does not actually keep.
  const engagementScore = activePosts.length
    ? Math.round(
        activePosts.reduce((s, p) => s + (p.likes_count ?? 0) + 2 * (p.comments_count ?? 0), 0) /
          activePosts.length
      )
    : 0;

  const tabData: { [k in Tab]: (Post | RepostRow)[] } = {
    active: posts,
    videos: posts.filter((p) => p.media_type === 'video'),
    reposts: reposts,
    saved: saved,
  };

  const grid = tabData[tab];

  if (settingsOpen) return <SettingsScreen onBack={() => setSettingsOpen(false)} />;
  if (peopleMode) return <PeopleScreen mode={peopleMode} onBack={() => setPeopleMode(null)} />;
  if (viewersOpen)
    return (
      <ProfileViewersScreen
        onBack={() => {
          setViewersOpen(false);
          // the viewers screen stamps them as seen — re-check for anything new
          loadUnseenViews();
        }}
      />
    );

  return (
    <View style={styles.container}>
      {loading ? null : (
        <FlatList
          data={grid}
          keyExtractor={(p, i) => `${p.id}-${i}`}
          numColumns={3}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View style={styles.header}>
              {/* Top bar as in the reference: the handle is the title, with one
                  control at each edge. The logo lockup belongs on the feed, not
                  repeated over your own profile. */}
              <View style={styles.topRow}>
                <Pressable
                  style={styles.settingsBtn}
                  onPress={openViewers}
                  hitSlop={8}
                  accessibilityLabel="Who viewed my profile"
                >
                  <Icon name="eye-outline" size={18} color={unseenViews > 0 ? colors.accent : colors.textMuted} />
                  {unseenViews > 0 && (
                    <View style={styles.viewBadge}>
                      <Text style={styles.viewBadgeText}>{unseenViews > 99 ? '99+' : unseenViews}</Text>
                    </View>
                  )}
                </Pressable>
                <View style={styles.titleWrap}>
                  <Text style={styles.titleName} numberOfLines={1}>
                    @{profile?.username ?? 'unknown'}
                  </Text>
                  {profile?.verified && <VerifiedBadge size={14} glow={false} />}
                </View>
                <Pressable
                  style={styles.settingsBtn}
                  onPress={() => setSettingsOpen(true)}
                  hitSlop={8}
                  accessibilityLabel="Settings"
                >
                  <Icon name="settings" size={17} color={colors.textMuted} />
                </Pressable>
              </View>

              {/* Profile cover. `profiles.cover_url` has existed since
                  supabase/profile_cover.sql. Now full-bleed to both screen edges
                  with a gradient scrim, matching the public profile screen — and
                  with a gradient fallback, because this previously rendered
                  NOTHING when no cover was set, which left the page looking
                  broken rather than simply uncovered. */}
              <View style={styles.coverWrap}>
                {profile?.cover_url ? (
                  <Image
                    source={{ uri: profile.cover_url }}
                    style={styles.coverImg}
                    resizeMode="cover"
                  />
                ) : (
                  /* cover fallback — the name and handle are painted over this,
                     so it has to invert with the text tokens on top of it */
                  <GradientFill from={colors.coverFrom} to={colors.coverTo} horizontal steps={12} style={FILL} />
                )}
                <View style={styles.coverScrim}>
                  <GradientFill
                    from={colors.bg}
                    to={colors.bg}
                    alphaFrom={0}
                    alphaTo={0.96}
                    steps={12}
                    style={FILL}
                  />
                </View>
              </View>

              {/* Portrait on the left, counters on the right — the reference's
                  header. The portrait still straddles the cover edge; only its
                  alignment changed, so the cover feature is untouched. */}
              <View style={styles.identityRow}>
                <Pressable onPress={() => setAvatarSheet(true)} hitSlop={8}>
                  <View style={styles.avatarGlow}>
                    <Avatar
                      url={profile?.avatar_url}
                      name={profile?.display_name || profile?.username || 'G'}
                      size={84}
                      ring
                      verified={!!profile?.verified}
                    />
                  </View>
                  <View style={styles.addBadge}>
                    <Icon name="add" size={13} color="#FFFFFF" />
                  </View>
                </Pressable>

                <View style={styles.statsRow}>
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{activePosts.length}</Text>
                    <Text style={styles.statLabel}>Posts</Text>
                  </View>
                  <Pressable style={styles.stat} onPress={() => setPeopleMode('followers')}>
                    <Text style={styles.statNumber}>{followers}</Text>
                    <Text style={styles.statLabel}>Followers</Text>
                  </Pressable>
                  <Pressable style={styles.stat} onPress={() => setPeopleMode('following')}>
                    <Text style={styles.statNumber}>{following}</Text>
                    <Text style={styles.statLabel}>Following</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.bioBlock}>
                <View style={styles.nameRow}>
                  <Text style={styles.displayName}>
                    {profile?.display_name || profile?.username || 'Gen Z user'}
                  </Text>
                  {profile?.verified && <VerifiedBadge size={17} style={styles.verified} />}
                  {!!profile?.pronouns && <Text style={styles.meta}>{profile.pronouns}</Text>}
                </View>

                {!!profile?.bio && <Text style={styles.bio}>{profile.bio}</Text>}
                {!!profile?.location && (
                  <View style={styles.metaRow}>
                    <Icon name="location" size={13} color={colors.cyan} />
                    <Text style={styles.metaLoc}>{profile.location}</Text>
                  </View>
                )}

                {/* Temporary mood — tap to set, change or clear. It clears itself. */}
                <Pressable
                  style={[moodStyles.chip, !mood && moodStyles.chipEmpty]}
                  onPress={() => setMoodOpen(true)}
                >
                  {mood ? (
                    <>
                      <Text style={moodStyles.emoji}>{mood.emoji}</Text>
                      <Text style={moodStyles.label} numberOfLines={1}>
                        {mood.label}
                      </Text>
                      <Text style={moodStyles.time}>{shortTimeLeft(mood.expiresAt)}</Text>
                    </>
                  ) : (
                    <>
                      <Text style={moodStyles.emoji}>✨</Text>
                      <Text style={moodStyles.placeholder}>Set a status</Text>
                    </>
                  )}
                </Pressable>

                <Text style={styles.joinDate}>
                  Joined{' '}
                  {new Date(profile?.created_at ?? Date.now()).toLocaleDateString([], {
                    month: 'long',
                    year: 'numeric',
                  })}
                </Text>
              </View>

              {/* Real engagement, not an invented score: the average of
                  likes + 2×comments across this profile's own live drops.
                  Hidden when there are no drops, because 0.0 would be a lie
                  dressed as a metric. */}
              {activePosts.length > 0 && (
                <View style={styles.engageOuter}>
                  <NeonGradientFill radius={999} sheen={false} />
                  <View style={styles.engageInner}>
                    <Icon name="ribbon-outline" size={15} color={colors.cyan} />
                    <Text style={styles.engageValue}>{engagementScore}</Text>
                    <Text style={styles.engageLabel}>Engagement Score</Text>
                    <Text style={styles.engageMeta}>{totalLikes} likes</Text>
                  </View>
                </View>
              )}

              {/* Highlights. These are REAL destinations inside this app — the
                  reference's Travel/Music/Friends labels are invented categories
                  and this app has no highlights store, so the rail is built from
                  what a tap can actually open. */}
              <View style={styles.highlights}>
                <Pressable style={styles.highlight} onPress={() => setTab('active')}>
                  <View style={styles.highlightRing}>
                    <Icon name="grid-outline" size={19} color={colors.text} />
                  </View>
                  <Text style={styles.highlightLabel}>Drops</Text>
                </Pressable>
                <Pressable style={styles.highlight} onPress={() => setTab('videos')}>
                  <View style={styles.highlightRing}>
                    <Icon name="videocam-outline" size={19} color={colors.text} />
                  </View>
                  <Text style={styles.highlightLabel}>Videos</Text>
                </Pressable>
                <Pressable style={styles.highlight} onPress={() => setTab('saved')}>
                  <View style={styles.highlightRing}>
                    <Icon name="bookmark-outline" size={19} color={colors.text} />
                  </View>
                  <Text style={styles.highlightLabel}>Saved</Text>
                </Pressable>
                <Pressable style={styles.highlight} onPress={openViewers}>
                  <View style={styles.highlightRing}>
                    <Icon name="eye-outline" size={19} color={colors.text} />
                  </View>
                  <Text style={styles.highlightLabel}>Viewers</Text>
                </Pressable>
              </View>

              {/* Wide neon primary + a square secondary, as in the reference:
                  one obvious action, with sharing still one tap away. */}
              <View style={styles.btnRow}>
                <NeonButton
                  title="Edit Profile"
                  icon="create-outline"
                  onPress={() => setEditing(true)}
                  style={styles.editBtn}
                />
                <Pressable
                  style={styles.shareSquare}
                  onPress={() => setShareOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Share profile"
                  hitSlop={6}
                >
                  <Icon name="share-social-outline" size={19} color={colors.text} />
                </Pressable>
              </View>

              <View style={styles.anonRow}>
                <Pressable style={styles.anonRowBtn} onPress={() => setAnonSettingsOpen(true)}>
                  <Icon name="eye-off-outline" size={14} color={colors.accent} />
                  <Text style={styles.anonRowText}>Anonymous messages</Text>
                </Pressable>
                <Pressable style={styles.anonRowBtn} onPress={shareAnonLink}>
                  <Icon name="share-social-outline" size={14} color={colors.accent} />
                  <Text style={styles.anonRowText}>Share link</Text>
                </Pressable>
              </View>

              {achievements.length > 0 && (
                <View style={styles.achievements}>
                  {achievements.map((a) => (
                    <View key={a.label} style={styles.achievement}>
                      <Icon name={a.icon} size={15} color={a.color} />
                      <Text style={styles.achievementLabel}>{a.label}</Text>
                    </View>
                  ))}
                </View>
              )}

              {activePosts.length > 0 && (
                <View style={styles.dropsSection}>
                  <View style={styles.sectionTitleRow}>
                    <Icon name="flame" size={16} color={colors.accent} />
                    <Text style={styles.dropsTitle}>Active Drops</Text>
                  </View>
                  <FlatList
                    data={activePosts}
                    horizontal
                    keyExtractor={(p) => p.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item, index: i }) => (
                      <Pressable
                        style={styles.dropCard}
                        onPress={() => setViewer({ list: activePosts, index: i })}
                        onLongPress={() => confirmDelete(item)}
                        delayLongPress={450}
                      >
                        {item.cover_url || (item.media_type === 'image' && item.media_url) ? (
                          <Image
                            source={{ uri: item.cover_url ?? item.media_url! }}
                            style={styles.dropMedia}
                            resizeMode="cover"
                          />
                        ) : item.media_type === 'video' ? (
                          <View style={[styles.dropMedia, styles.dropVideoPh]}>
                            <View style={styles.statRow}>
                              <Icon name="play" size={11} color={colors.logoWhite} />
                              <Text style={styles.dropVideoPhText}>{item.views_count}</Text>
                            </View>
                          </View>
                        ) : (
                          <View style={[styles.dropMedia, styles.dropTextBg, item.text_bg ? { backgroundColor: item.text_bg } : null]}>
                            <Text style={[styles.dropText, item.text_color ? { color: item.text_color } : null]} numberOfLines={3}>{item.content}</Text>
                          </View>
                        )}
                        {item.media_type === 'video' && (
                          <View style={styles.cardPlayBadge}>
                            <Icon name="play" size={16} color={colors.logoWhite} />
                          </View>
                        )}
                        <View style={styles.dropInfo}>
                          <View style={styles.statRow}>
                            <Icon name="flame" size={12} color={colors.accent} />
                            <Text style={styles.dropTime}>{hoursLeft(item.expires_at)}</Text>
                          </View>
                          <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${progressOf(item.created_at, item.expires_at)}%` }]} />
                          </View>
                        </View>
                      </Pressable>
                    )}
                  />
                </View>
              )}

              {/* Icon tabs with a magenta underline, as in the reference. All four
                  existing tabs are kept — dropping Reposts or Saved would be a
                  feature removal dressed up as a redesign. */}
              <View style={styles.tabs}>
                {(
                  [
                    ['active', 'grid-outline', 'Posts'],
                    ['videos', 'videocam-outline', 'Videos'],
                    ['reposts', 'repeat', 'Reposts'],
                    ['saved', 'bookmark-outline', 'Saved'],
                  ] as [Tab, any, string][]
                ).map(([t, icon, label]) => {
                  const on = tab === t;
                  return (
                    <Pressable
                      key={t}
                      style={styles.tab}
                      onPress={() => setTab(t)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={label}
                    >
                      <Icon name={icon} size={21} color={on ? colors.text : colors.textFaint} />
                      {on && <View style={styles.tabUnderline} />}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          }
          renderItem={({ item, index: i }) => (
            <Pressable
              style={styles.tile}
              onPress={() => setViewer({ list: grid, index: i })}
              onLongPress={() => confirmDelete(item)}
              delayLongPress={450}
            >
              {item.cover_url || (item.media_type === 'image' && item.media_url) ? (
                <Image source={{ uri: item.cover_url ?? item.media_url! }} style={styles.tileImage} resizeMode="cover" />
              ) : item.media_type === 'video' ? (
                <View style={[styles.tileImage, styles.tileVideoPh]}>
                  <View style={styles.statRow}>
                    <Icon name="play" size={11} color={colors.logoWhite} />
                    <Text style={styles.tileVideoPhText}>{item.views_count}</Text>
                  </View>
                </View>
              ) : (
                <View style={[styles.tileImage, styles.tileTextBg, item.text_bg ? { backgroundColor: item.text_bg } : null]}>
                  <Text style={[styles.tileText, item.text_color ? { color: item.text_color } : null]} numberOfLines={3}>{item.content}</Text>
                </View>
              )}
              {item.media_type === 'video' && (
                <View style={styles.tileBadge}>
                  <Icon name="play" size={10} color={colors.logoWhite} />
                  <Text style={styles.tileBadgeText}>{item.views_count}</Text>
                </View>
              )}
              {!!item.drop_id && (
                <View style={styles.tileDrop}>
                  <Icon name="cube" size={13} color={colors.accent} />
                </View>
              )}
              {'profile' in item && item.profile && tab === 'reposts' && (
                <View style={styles.tileRepost}>
                  <Icon name="repeat" size={11} color={colors.cyan} />
                  <Text style={styles.tileRepostText} numberOfLines={1}>@{item.profile.username}</Text>
                </View>
              )}
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>Nothing active right now — post something before it vanishes.</Text>}
        />
      )}

      <EditProfileModal
        visible={editing}
        profile={profile}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          load();
        }}
      />

      <ShareProfileModal visible={shareOpen} profile={profile} onClose={() => setShareOpen(false)} onShare={shareProfile} />

      <AnonymousSettingsModal visible={anonSettingsOpen} onClose={() => setAnonSettingsOpen(false)} />
      <MoodStatusModal
        visible={moodOpen}
        onClose={() => setMoodOpen(false)}
        current={mood}
        onChanged={loadMood}
      />

      {anonCardOpen && profile && (
        <AnonymousCardModal
          visible
          username={profile.username}
          kind="link"
          onClose={() => setAnonCardOpen(false)}
          onPostToFeed={(uri) => onPostToFeed?.(uri)}
        />
      )}

      {viewer && (
        <View style={styles.viewerWrap}>
          <PostViewer posts={viewer.list as any} index={viewer.index} onClose={() => setViewer(null)} />
        </View>
      )}

      {/* avatar chooser */}
      <Modal visible={avatarSheet} transparent animationType="slide" onRequestClose={() => setAvatarSheet(false)}>
        <Pressable style={styles.avatarSheetOverlay} onPress={() => setAvatarSheet(false)}>
          <Pressable style={styles.avatarSheet} onPress={() => {}}>
            <Text style={styles.avatarSheetTitle}>Your profile</Text>
            <Pressable
              style={styles.avatarSheetItem}
              onPress={() => {
                setAvatarSheet(false);
                setAvatarFull(true);
              }}
            >
              <Icon name="person-outline" size={19} color={colors.cyan} />
              <Text style={styles.avatarSheetItemText}>Check profile pic</Text>
            </Pressable>
            <Pressable
              style={styles.avatarSheetItem}
              onPress={() => {
                setAvatarSheet(false);
                if (myId) onOpenDropsFeed?.(myId);
              }}
            >
              <Icon name="flame" size={18} color={colors.accent} />
              <Text style={styles.avatarSheetItemText}>Check active drops</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* fullscreen profile pic */}
      <Modal visible={avatarFull} transparent animationType="fade" onRequestClose={() => setAvatarFull(false)}>
        <Pressable style={styles.avatarFullOverlay} onPress={() => setAvatarFull(false)}>
          {profile?.avatar_url && !profile.avatar_url.startsWith('preset:') ? (
            <Image source={{ uri: profile.avatar_url }} style={styles.avatarFullImg} resizeMode="contain" />
          ) : (
            <Avatar url={profile?.avatar_url} name={profile?.display_name || profile?.username || 'G'} size={240} ring />
          )}
          <Text style={styles.avatarFullHint}>Tap anywhere to close</Text>
        </Pressable>
      </Modal>
    </View>
  );
}

function hoursLeft(expiresAt: string): string {
  const h = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 3600000));
  return `${h}h left`;
}

function progressOf(createdAt: string, expiresAt: string): number {
  const total = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
  const elapsed = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.min(100, (elapsed / total) * 100));
}

function useAchievements(profile: Profile | null, posts: Post[], totalLikes: number) {
  if (!profile) return [];
  const out: { icon: IconName; color: string; label: string }[] = [];
  if (profile.streak_count >= 3) out.push({ icon: 'flame', color: colors.accent, label: `${profile.streak_count} Day Streak` });
  if (posts.some((p) => p.media_type === 'video')) out.push({ icon: 'videocam', color: colors.cyan, label: 'Creator' });
  const comments = posts.reduce((s, p) => s + (p.comments_count ?? 0), 0);
  if (comments >= 5) out.push({ icon: 'chatbubbles', color: colors.violet, label: 'Conversation Starter' });
  if (posts.some((p) => p.drop_id)) out.push({ icon: 'rocket', color: colors.accent, label: 'First Drop' });
  if (totalLikes >= 25) out.push({ icon: 'star', color: colors.accent, label: 'Rising Creator' });
  return out;
}

function EditProfileModal({ visible, profile, onClose, onSaved }: any) {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [region, setRegion] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [localAvatar, setLocalAvatar] = useState<string | null | undefined>(undefined);
  const [avatarPicker, setAvatarPicker] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);

  const sheetPad = useSheetPad(36);

  useEffect(() => {
    if (visible && profile) {
      setDisplayName(profile.display_name ?? '');
      setBio(profile.bio ?? '');
      setLocation(profile.location ?? '');
      setRegion(profile.region ?? '');
      setPronouns(profile.pronouns ?? '');
      setLocalAvatar(undefined);
      setCoverUrl(profile.cover_url ?? null);
    }
  }, [visible, profile]);

  const pickCover = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo library permission is needed');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setCoverBusy(true);
    try {
      // Deliberately NOT under a post path: genz_purge_expired() sweeps media
      // belonging to expired posts, and a profile cover must never be swept.
      // `covers/` mirrors how `avatars/` is left alone.
      const url = await uploadMedia(
        `covers/${user.id}/cover-${Date.now()}.jpg`,
        asset.uri,
        asset.mimeType ?? 'image/jpeg'
      );
      setCoverUrl(url);
    } catch (e: any) {
      Alert.alert('Cover upload failed', friendlyError(e, 'Could not upload your cover photo. Please try again.'));
    } finally {
      setCoverBusy(false);
    }
  };

  const save = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        location: location.trim() || null,
        region: region.trim() || null,
        pronouns: pronouns.trim() || null,
        cover_url: coverUrl,
      })
      .eq('id', user.id);
    onSaved();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalSheet, { paddingBottom: sheetPad }]}>
          <Text style={styles.modalTitle}>Edit profile</Text>
          <Pressable style={styles.modalAvatarRow} onPress={() => setAvatarPicker(true)}>
            <Avatar
              url={localAvatar !== undefined ? localAvatar : profile?.avatar_url}
              name={displayName || profile?.username || 'G'}
              size={84}
              ring
            />
            <Text style={styles.modalAvatarCta}>Change avatar</Text>
          </Pressable>
          <Pressable
            style={styles.modalCoverRow}
            onPress={() => void pickCover()}
            disabled={coverBusy}
            accessibilityRole="button"
            accessibilityLabel="Change cover photo"
          >
            {coverUrl ? (
              <Image source={{ uri: coverUrl }} style={styles.modalCoverPreview} resizeMode="cover" />
            ) : (
              <View style={[styles.modalCoverPreview, styles.modalCoverEmpty]}>
                <Icon name="image-outline" size={18} color={colors.textMuted} />
              </View>
            )}
            <Text style={styles.modalAvatarCta}>
              {coverBusy ? 'Uploading…' : 'Change cover photo'}
            </Text>
          </Pressable>
          <TextInput style={styles.modalInput} placeholder="Display name" placeholderTextColor={colors.textFaint} value={displayName} onChangeText={setDisplayName} />
          <TextInput style={[styles.modalInput, styles.modalBio]} placeholder="Bio" placeholderTextColor={colors.textFaint} multiline value={bio} onChangeText={setBio} />
          <TextInput style={styles.modalInput} placeholder="Location (optional)" placeholderTextColor={colors.textFaint} value={location} onChangeText={setLocation} />
          <TextInput style={styles.modalInput} placeholder="Region for discovery (e.g. Nigeria) — never exact" placeholderTextColor={colors.textFaint} value={region} onChangeText={setRegion} />
          <TextInput style={styles.modalInput} placeholder="Pronouns (e.g. he/him)" placeholderTextColor={colors.textFaint} value={pronouns} onChangeText={setPronouns} />
          <AvatarPickerModal
            visible={avatarPicker}
            current={profile?.avatar_url}
            name={displayName || profile?.username || 'G'}
            onClose={() => setAvatarPicker(false)}
            onSaved={(value) => setLocalAvatar(value)}
          />
          <Button title="Save" onPress={save} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ShareProfileModal({ visible, profile, onClose, onShare }: any) {
  const username = profile?.username ?? 'unknown';
  const link = `genz://profile/@${username}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(link)}`;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Share your profile</Text>
          <View style={styles.qrBox}>
            <Image source={{ uri: qrUrl }} style={styles.qr} />
          </View>
          <Text style={styles.qrHandle}>@{username}</Text>
          <Text style={styles.qrLink}>{link}</Text>
          <Button title="Share profile" onPress={onShare} style={{ marginTop: 16 }} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// Mood chip styling sits in its own sheet so this feature cannot disturb the
// existing profile styles.
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
  chipEmpty: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
  },
  emoji: { fontSize: 14 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  time: { color: colors.accent, fontSize: 11, fontWeight: '700' },
  placeholder: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingTop: TOP_INSET + 8,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 14,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 10,
  },
  topSpacer: {
    width: 36,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsIcon: {
    color: colors.textMuted,
    fontSize: 16,
  },
  viewBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  viewBadgeText: {
    color: colors.bg,
    fontSize: 9.5,
    fontWeight: '800',
  },
  avatarRing: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  avatar: {
    width: 92,
    height: 92,
    borderRadius: 46,
  },
  avatarPlaceholder: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 36,
    fontWeight: '800',
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  titleName: { color: colors.text, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  // portrait left, counters right — the reference's header row
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    marginTop: -42,
  },
  addBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  bioBlock: {
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    marginTop: 10,
  },
  // the engagement panel: gradient rim (SVG) with a solid inset so the border is
  // a true ramp rather than one flat colour
  engageOuter: {
    alignSelf: 'stretch',
    marginHorizontal: 16,
    marginTop: 14,
    height: 44,
    borderRadius: 999,
    overflow: 'hidden',
  },
  engageInner: {
    flex: 1,
    margin: 1.6,
    borderRadius: 999,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 8,
  },
  engageValue: { color: colors.text, fontSize: 15, fontWeight: '800' },
  engageLabel: { color: colors.text, fontSize: 12.5, fontWeight: '700', flex: 1 },
  engageMeta: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600' },
  highlights: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-around',
    marginTop: 16,
    paddingHorizontal: 10,
  },
  highlight: { alignItems: 'center', width: 66 },
  highlightRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.6,
    borderColor: colors.violet,
  },
  highlightLabel: { color: colors.textMuted, fontSize: 10.5, marginTop: 5, fontWeight: '600' },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 6,
  },
  displayName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  verified: {
    marginLeft: 6,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
  },
  metaLoc: {
    color: colors.textMuted,
    fontSize: 12,
  },
  username: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  bio: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
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
    flex: 1,
    justifyContent: 'space-evenly',
    marginLeft: 10,
  },
  stat: {
    alignItems: 'center',
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
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    width: '100%',
    gap: 10,
    paddingHorizontal: 4,
  },
  halfBtn: {
    width: '48%',
    marginHorizontal: '1%',
  },
  editBtn: { flex: 1 },
  shareSquare: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  anonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    width: '100%',
  },
  anonRowBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(229,43,255,0.35)',
    backgroundColor: 'rgba(229,43,255,0.08)',
    borderRadius: 999,
    paddingVertical: 8,
  },
  anonRowText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  achievements: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 14,
  },
  achievement: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    margin: 3,
    gap: 6,
  },
  achievementLabel: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 5,
  },
  dropsSection: {
    width: '100%',
    marginTop: 18,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  dropsTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dropCard: {
    width: 130,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginRight: 10,
  },
  dropMedia: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  dropVideoPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A1220',
  },
  dropVideoPhText: {
    // sits on dropVideoPh / tileVideoPh, which stay dark in both themes
    color: colors.onMediaMuted,
    fontSize: 22,
    fontWeight: '800',
  },
  tileVideoPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A1220',
  },
  cardPlayBadge: {
    position: 'absolute',
    top: '38%',
    alignSelf: 'center',
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
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
  avatarSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  avatarSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 18,
    paddingBottom: 34,
    gap: 8,
  },
  avatarSheetTitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  avatarSheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  avatarSheetItemText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  avatarFullOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(2,4,10,0.95)',
    padding: 24,
  },
  avatarFullImg: {
    width: '100%',
    height: '70%',
    borderRadius: radius.lg,
  },
  avatarFullHint: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 18,
  },
  tileVideoPhText: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: '800',
  },
  dropTextBg: {
    justifyContent: 'center',
    padding: 8,
  },
  dropText: {
    color: colors.text,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  dropInfo: {
    padding: 8,
  },
  dropTime: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  tabs: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    marginTop: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  // the reference's active indicator: a short magenta bar under the icon
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    height: 2.5,
    width: '52%',
    borderRadius: 2,
    backgroundColor: colors.accent,
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
  tileBadgeText: {
    color: colors.logoWhite,
    fontSize: 10,
    fontWeight: '700',
  },
  tileDrop: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: colors.accentSoft,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  tileRepost: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tileRepostText: {
    color: colors.cyan,
    fontSize: 9,
    fontWeight: '600',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingTop: 24,
    paddingHorizontal: 30,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 22,
    paddingBottom: 36,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  // Cover banner — matched to the public profile screen so your own page and the
  // page other people see are the SAME page.
  //
  // marginHorizontal negates the FlatList contentContainer's 16px padding, which
  // is what makes the banner run edge to edge instead of stopping short like a
  // floating card.
  coverWrap: {
    width: '100%',
    height: 150,
    marginHorizontal: -16,
    marginBottom: 0,
    backgroundColor: colors.surfaceInput,
    overflow: 'hidden',
  },
  coverImg: {
    width: '100%',
    height: '100%',
  },
  // Bottom-anchored scrim (bottom 72% only). Without it a BRIGHT cover swallows
  // the white name and chips underneath it.
  coverScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '72%',
  },
  // Straddle the cover edge — the detail that makes it read as designed.
  avatarOverlap: {
    marginTop: -48,
  },
  // A neon halo around the portrait. Built from a border + shadow rather than a
  // gradient ring because Avatar already owns its own circular clip; wrapping it
  // keeps the halo outside that clip where it belongs.
  avatarGlow: {
    padding: 3,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'rgba(139,92,246,0.65)',
    backgroundColor: 'rgba(10,16,36,0.9)',
    shadowColor: '#EC4899',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  modalCoverRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  modalCoverPreview: {
    width: '100%',
    height: 96,
    borderRadius: 12,
    backgroundColor: colors.surfaceInput,
  },
  modalCoverEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  modalAvatarRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  modalAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  modalAvatarPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalAvatarLetter: {
    color: colors.accent,
    fontSize: 32,
    fontWeight: '800',
  },
  modalAvatarCta: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  modalInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  modalBio: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalCancel: {
    alignItems: 'center',
    marginTop: 12,
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  qrBox: {
    alignItems: 'center',
    marginBottom: 10,
  },
  qr: {
    width: 220,
    height: 220,
    borderRadius: radius.md,
    backgroundColor: colors.logoWhite,
  },
  qrHandle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  qrLink: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
});
