import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
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
import { TOP_INSET, useInsets } from '../utils/useInsets';
import DropCountdown from '../components/DropCountdown';
import Icon, { IconName } from '../components/ui/Icon';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import FeedPost, { setFeedUserId } from '../components/FeedPost';
import CommentsModal from '../components/CommentsModal';
import ChainModal from '../components/ChainModal';
import SoundPage from '../components/SoundPage';
import ActivityScreen from './ActivityScreen';
import { notifyUser } from '../utils/notify';
import DropExperienceScreen from './DropExperienceScreen';
import PublicProfileScreen from './PublicProfileScreen';
import ProfilePeekModal from '../components/ProfilePeekModal';
import InviteSheet from '../components/InviteSheet';
import StoryViewer from '../components/StoryViewer';
import NeonRing from '../components/ui/NeonRing';
// `peek as cachePeek` — this file already has a local `peek` state at line 202
// for the profile-peek modal, and the unaliased import shadowed it.
import { cacheKey, filterLive, peek as cachePeek, put } from '../utils/fastCache';
import { useAndroidBack } from '../utils/useAndroidBack';
import {
  type Pulse,
  EMPTY_PULSE,
  engagementOf,
  loadPulse,
  velocityOf,
} from '../utils/ranking';

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
  following: boolean;
  verified?: boolean;
};

type FeedPostRow = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  content: string | null;
  audio: string | null;
  sound: string | null;
  sound_url: string | null;
  sound_start: number | null;
  sound_end: number | null;
  caption: string | null;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
  text_bg: string | null;
  text_color: string | null;
  likes_count: number;
  comments_count: number;
  views_count: number;
  created_at: string;
  expires_at: string;
  drop_id: string | null;
  parent_drop_id: string | null;
  profile: { username: string; avatar_url: string | null; is_private: boolean; region: string | null } | null;
  /** present only on items that reached the feed because an account you follow
   *  reposted them — names the account whose repost surfaced the drop */
  reposted_by?: { username: string; avatar_url: string | null; verified?: boolean } | null;
};

// Pulse, velocityOf() and engagementOf() now live in utils/ranking so that
// Discover ranks creators with the SAME definition of "hot" this feed uses.
// Re-exported here so any existing `import { Pulse } from FeedScreen` still works.
export type { Pulse } from '../utils/ranking';

export type FeedPostFull = FeedPostRow & {
  liked_by_me: boolean;
  following: boolean;
  follow_pending: boolean;
  saved_by_me: boolean;
  reposted_by_me: boolean;
  my_reaction: string | null;
  reactions_count: number;
  pulse: Pulse;
  responses_count: number;
  reasons: string[];
};

type FeedMode = 'following' | 'foryou' | 'live' | 'expiring' | 'around';
type LiveSection = 'blowing' | 'watching' | 'talked' | 'fresh' | 'creators';
type FeedPrefs = {
  content: ('video' | 'photo' | 'text' | 'chains')[];
  show: 'everyone' | 'following' | 'new';
  location: 'global' | 'country' | 'around';
  sort: 'recommended' | 'fresh';
};

const LIVE_SECTIONS: { key: LiveSection; label: string }[] = [
  { key: 'blowing', label: '🔥 Blowing Up' },
  { key: 'watching', label: "👀 Everyone's Watching" },
  { key: 'talked', label: '💬 Most Talked About' },
  { key: 'fresh', label: '⚡ Just Dropped' },
  { key: 'creators', label: '🎯 Rising Creators' },
];
const EXP_SECTIONS: { key: '6h' | '1h' | 'gone'; label: string }[] = [
  { key: '6h', label: '🔥 Under 6 hours' },
  { key: '1h', label: '🚨 Under 1 hour' },
  { key: 'gone', label: '💨 Almost gone' },
];
const AROUND_SCOPES: { key: 'region' | 'global'; label: string }[] = [
  { key: 'region', label: '📍 Region' },
  { key: 'global', label: '🌎 Global' },
];

const MODES: { key: FeedMode; label: string; icon: IconName }[] = [
  { key: 'following', label: 'Following', icon: 'people-outline' },
  { key: 'foryou', label: 'For You', icon: 'play-circle-outline' },
  { key: 'live', label: 'Live', icon: 'radio' },
  { key: 'expiring', label: 'Expiring', icon: 'hourglass-outline' },
  { key: 'around', label: 'Around You', icon: 'location-outline' },
];

const PAGE_SIZE = 50;
const H = 3600 * 1000;
// rising thresholds moved to utils/ranking (MIN_VIEWS_RISING / MIN_ENGAGEMENT_RISING)

export default function FeedScreen({
  onJoinDrop,
  onCreateIntent,
  initialUserMode = null,
  initialAudioMode = null,
  initialHashtagMode = null,
  initialLocationMode = null,
  focused = true,
  openActivitySignal = 0,
  onOpenSearch,
  onOpenChat,
}: {
  onOpenSearch?: () => void;
  onOpenChat?: () => void;
  onJoinDrop?: () => void;
  onCreateIntent?: (intent: { sound?: string; replyTo?: string }) => void;
  initialUserMode?: string | null;
  initialAudioMode?: string | null;
  initialHashtagMode?: string | null;
  /** A place name. Mirrors hashtagMode: a filtered view of the live window. */
  initialLocationMode?: string | null;
  focused?: boolean;
  /** bumped by a system-notification tap to surface the Activity screen */
  openActivitySignal?: number;
}) {
  const { height } = useWindowDimensions();
  const insets = useInsets();
  // never let the top nav slide under the status bar — floor of 44px
  // covers devices that under-report the status-bar height
  const safeTop = Math.max(insets.top, TOP_INSET, 44);
  const [mode, setMode] = useState<FeedMode>('foryou');

  // Seed the list from the last session's first page.
  //
  // This is the single most important line for perceived speed: the FlatList
  // exists on the very first frame, so post #1's player mounts and starts
  // buffering immediately. Previously the list could not exist until the
  // network answered, so the fetch and the video buffer were two waits IN
  // SERIES — fetch, then buffer. Now they overlap.
  //
  // filterLive() matters: a Moment is only live for 7 days, so anything past
  // its expires_at is dropped rather than shown as stale.
  const [posts, setPosts] = useState<FeedPostFull[]>(() => {
    const cached = cachePeek<FeedPostFull[]>(cacheKey.feed('foryou'));
    return cached ? filterLive(cached) : [];
  });
  // No spinner when we already have something real to show.
  const [loading, setLoading] = useState(posts.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [commentPost, setCommentPost] = useState<FeedPostFull | null>(null);
  // a drop opened from the Activity screen (only needs id + owner for CommentsModal)
  const [activityPost, setActivityPost] = useState<{ id: string; user_id?: string } | null>(null);
  const [chainRoot, setChainRoot] = useState<FeedPostFull | null>(null);
  const [soundName, setSoundName] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<StoryUser[]>([]);
  const [activeDrop, setActiveDrop] = useState<Drop | null>(null);
  const [dropMode, setDropMode] = useState<string | null>(null);
  const [userMode, setUserMode] = useState<string | null>(initialUserMode);
  const [audioMode, setAudioMode] = useState<string | null>(initialAudioMode);
  const [hashtagMode, setHashtagMode] = useState<string | null>(initialHashtagMode);
  const [locationMode, setLocationMode] = useState<string | null>(initialLocationMode);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);
  const [peek, setPeek] = useState<{ id: string; username: string } | null>(null);
  const [myRegion, setMyRegion] = useState<string | null>(null);
  const [storyUsers, setStoryUsers] = useState<StoryUser[]>([]);
  const [storyAt, setStoryAt] = useState<number | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);

  // Android back control for the overlays this screen owns. All three are
  // conditional renders rather than <Modal>s, so RN's onRequestClose never saw
  // the press and it fell through to HomeScreen's tab handler instead of
  // closing the thing actually on screen. Innermost first, then decline.
  useAndroidBack(() => {
    if (publicProfile) {
      setPublicProfile(null);
      return true;
    }
    if (showDrop) {
      setShowDrop(false);
      return true;
    }
    if (notifOpen) {
      setNotifOpen(false);
      return true;
    }
    return false;
  });
  const [unreadCount, setUnreadCount] = useState(0);
  const [liveCount, setLiveCount] = useState(0);
  const [expiringCount, setExpiringCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [aroundFallback, setAroundFallback] = useState(false);
  const [followingCount, setFollowingCount] = useState(0);
  const [hasFollows, setHasFollows] = useState(false);
  const myIdRef = useRef<string | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  // ---- feed preferences (applied in load + rank, all real signals) ----
  const DEFAULT_PREFS: FeedPrefs = { content: [], show: 'everyone', location: 'global', sort: 'recommended' };
  const [feedPrefs, setFeedPrefs] = useState<FeedPrefs>(DEFAULT_PREFS);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // ---- sub-filter state: Live sections, Expiring categories, Around scope ----
  const [liveSection, setLiveSection] = useState<LiveSection>('blowing');
  const [expFilter, setExpFilter] = useState<'6h' | '1h' | 'gone'>('6h');
  const [aroundScope, setAroundScope] = useState<'region' | 'global'>('region');

  const loadUnread = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setUnreadCount(0);
      return;
    }
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false);
    setUnreadCount(count ?? 0);
  }, []);

  useEffect(() => {
    loadUnread();
  }, [loadUnread]);

  // a tap on a real notification asks the feed to surface Activity
  useEffect(() => {
    if (openActivitySignal > 0) setNotifOpen(true);
  }, [openActivitySignal]);

  // tapping a row inside Activity leaves Activity and opens that drop's comments
  const openPostFromActivity = useCallback(async (postId: string) => {
    const { data } = await supabase.from('posts').select('id, user_id').eq('id', postId).maybeSingle();
    const row = data as { id: string; user_id: string } | null;
    // the drop may already be gone (7-day expiry) - if so stay on Activity rather
    // than closing it and opening nothing
    if (!row) return;
    setNotifOpen(false);
    setActivityPost({ id: row.id, user_id: row.user_id });
  }, []);
  const watchRef = useRef<Map<string, { start: number; reported: boolean }>>(new Map());

  // banner entrance + live halo animations
  const bannerAnim = useRef(new Animated.Value(0)).current;
  const bannerSlide = useRef(new Animated.Value(-14)).current;
  const haloPulse = useRef(new Animated.Value(0)).current;
  // always-on pulse for the LIVE dot on the rail (FOMO, independent of the banner)
  const railDotPulse = useRef(new Animated.Value(0)).current;
  // stories row: fade out when scrolling past the first post (video stays clean)
  const storyFade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(storyFade, {
      toValue: activeIndex > 0 ? 0 : 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [activeIndex, storyFade]);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(railDotPulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(railDotPulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [railDotPulse]);

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

  // rank a page of drops with real signals (no fake numbers)
  const rankRows = useCallback(
    (
      rows: FeedPostRow[],
      m: FeedMode,
      pulseMap: Map<string, Pulse>,
      tagMap: Map<string, Set<string>>,
      notInterested: Set<string>,
      opts: { sort?: 'recommended' | 'fresh'; liveSection?: LiveSection; noCap?: boolean } = {}
    ) => {
      const now = Date.now();
      // velocityOf() / engagementOf() are imported from utils/ranking — see the
      // note there on why this app must have exactly one ranking formula.

      // Rising Creators: creator-level velocity (sum across their posts on this page)
      let creatorVelocity = new Map<string, number>();
      if (m === 'live' && opts.liveSection === 'creators') {
        const acc = new Map<string, number>();
        rows.forEach((r) => {
          const p = pulseMap.get(r.id) ?? EMPTY_PULSE;
          acc.set(r.user_id, (acc.get(r.user_id) ?? 0) + velocityOf(p));
        });
        creatorVelocity = acc;
      }

      const scored = rows.map((r) => {
        const pulse = pulseMap.get(r.id) ?? EMPTY_PULSE;
        const ageH = Math.max(0, (now - new Date(r.created_at).getTime()) / H);
        let score = 0;
        if (m === 'foryou') {
          if (opts.sort === 'fresh') {
            score = -ageH;
          } else {
            const freshness = 2 * Math.exp(-ageH / 14);
            const dampen = [...(tagMap.get(r.id) ?? [])].some((t) => notInterested.has(t)) ? 2.5 : 0;
            score = freshness + velocityOf(pulse) + engagementOf(r) - dampen;
          }
        } else if (m === 'live') {
          const freshness = 3 * Math.exp(-ageH / 6);
          const velocity = velocityOf(pulse);
          switch (opts.liveSection ?? 'blowing') {
            case 'watching':
              // 👀 Everyone's Watching — real watch velocity
              score = (pulse.views30 ?? 0) * 2 + freshness * 0.4 + Math.log1p(r.views_count) * 0.4;
              break;
            case 'talked':
              // 💬 Most Talked About — real conversation velocity
              score = (pulse.comments30 ?? 0) * 4 + Math.log1p(r.comments_count) * 2 + freshness * 0.3;
              break;
            case 'fresh':
              // ⚡ Just Dropped — newest first
              score = -ageH;
              break;
            case 'creators':
              // 🎯 Rising Creators — creator-level acceleration
              score = (creatorVelocity.get(r.user_id) ?? 0) * 2 + freshness;
              break;
            default:
              // 🔥 Blowing Up — engagement velocity
              score = velocity * 3 + freshness + Math.log1p(r.likes_count + r.comments_count + 1);
          }
        } else {
          score = now - new Date(r.created_at).getTime();
        }
        return { r, pulse, score };
      });

      scored.sort((a, b) =>
        m === 'expiring' ? new Date(a.r.expires_at).getTime() - new Date(b.r.expires_at).getTime() : b.score - a.score
      );

      // creator diversity — cap repeats per creator (your own posts never
      // capped). The cap adapts to the pool: with few active creators (e.g.
      // testing) it relaxes so the feed fills up; with many creators it keeps
      // variety. Filtered views (one user/sound/tag) skip the cap entirely.
      const perCreator = new Map<string, number>();
      const distinctCreators = new Set(scored.map((x) => x.r.user_id)).size;
      const cap = m === 'live'
        ? 2
        : opts.noCap
          ? Infinity
          : Math.max(3, Math.min(8, Math.ceil(40 / Math.max(1, distinctCreators))));
      const out: FeedPostFull[] = [];
      for (const { r, pulse } of scored) {
        const mine = r.user_id === myIdRef.current;
        const c = perCreator.get(r.user_id) ?? 0;
        if (!mine && c >= cap) continue;
        perCreator.set(r.user_id, c + 1);
        out.push(r as FeedPostFull);
        if (out.length >= PAGE_SIZE) break;
      }
      return out;
    },
    []
  );

  const loadSuggestions = useCallback(async (me: string | null) => {
    const [hid, mut, blk, fws] = await Promise.all([
      supabase.from('hidden_posts').select('post_id'),
      supabase.from('muted_users').select('muted_id'),
      supabase.from('blocks').select('blocked_id').eq('blocker_id', me ?? ''),
      supabase.from('follows').select('following_id').eq('follower_id', me ?? ''),
    ]);
    const hidden = new Set((hid.data ?? []).map((x) => x.post_id));
    const muted = new Set((mut.data ?? []).map((x) => x.muted_id));
    const blocked = new Set((blk.data ?? []).map((x) => x.blocked_id));
    const followed = new Set((fws.data ?? []).map((x) => x.following_id));
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, username, avatar_url, verified')
      .neq('id', me ?? '')
      .order('created_at', { ascending: false })
      .limit(12);
    setSuggestions(
      ((profs ?? []) as { id: string; username: string; avatar_url: string | null }[])
        .filter((u) => !hidden.has(u.id) && !muted.has(u.id) && !blocked.has(u.id))
        .map((u) => ({ ...u, following: followed.has(u.id) }))
    );
  }, []);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;
    setFeedUserId(user?.id ?? null);

    // exclusions: hidden drops, muted creators, blocked (both directions)
    const [hid, mut, blk, notInt] = await Promise.all([
      supabase.from('hidden_posts').select('post_id'),
      supabase.from('muted_users').select('muted_id'),
      supabase.from('blocks').select('blocked_id, blocker_id').or(`blocker_id.eq.${user?.id ?? '00000000-0000-0000-0000-000000000000'},blocked_id.eq.${user?.id ?? '00000000-0000-0000-0000-000000000000'}`),
      supabase.from('not_interested_tags').select('tag'),
    ]);
    const hidden = new Set((hid.data ?? []).map((x) => x.post_id));
    const muted = new Set((mut.data ?? []).map((x) => x.muted_id));
    // blocked = people *I* blocked + people who blocked *me* — never myself
    const blocked = new Set<string>();
    (blk.data ?? []).forEach((x: any) => {
      if (x.blocker_id === user?.id) blocked.add(x.blocked_id);
      if (x.blocked_id === user?.id) blocked.add(x.blocker_id);
    });
    const notInterested = new Set((notInt.data ?? []).map((x) => x.tag));

    let following = new Set<string>();
    let pendingFollows = new Set<string>();
    if (user) {
      // fetch BOTH statuses: accepted -> Following, pending -> Requested.
      // Previously only accepted was loaded, so private-account follows
      // showed "Follow" again after every reload.
      const { data: f } = await supabase
        .from('follows')
        .select('following_id, status')
        .eq('follower_id', user.id);
      (f ?? []).forEach((x: any) => {
        if (x.status === 'accepted') following.add(x.following_id);
        else if (x.status === 'pending') pendingFollows.add(x.following_id);
      });
    }

    let aroundRegion: string | null = null;
    let query = supabase
      .from('posts')
      .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified)')
      .is('parent_drop_id', null) // reply-with-drop posts live in comments, not the feed
      // expiry rule, enforced at the QUERY rather than trusted to the client.
      // Every mode below that filters by expires_at only ever asks for ACTIVE
      // drops (expires_at > now), so no mode can want an ended one here — but the
      // base modes (For You, Following) had no such filter at all, which is how an
      // ended drop could still be served. The DB purge job removes the row; this
      // stops it being served in the window before that job runs.
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(90);
    if (dropMode) query = query.eq('drop_id', dropMode);
    else if (userMode) query = query.eq('user_id', userMode);
    else if (audioMode) query = query.eq('audio', audioMode);
    else if (hashtagMode) {
      const { data: tagRows } = await supabase
        .from('post_hashtags')
        .select('post_id')
        .eq('tag', hashtagMode)
        .limit(120);
      const postIds = (tagRows ?? []).map((r) => r.post_id);
      if (!postIds.length) {
        setPosts([]);
        setLoading(false);
        return;
      }
      query = query.in('id', postIds);
    } else if (locationMode) {
      // Location mode: every live drop posted from one place.
      //
      // ilike with NO wildcards is case-insensitive equality, which is the point
      // — "Lagos, Nigeria" and "lagos, nigeria" are the same place and must not
      // be two feeds. Both sides are trimmed (create stores location.trim(), and
      // location_suggest returns the btrim'd value), so whitespace variants are
      // already collapsed. The value comes from a suggestion list of real stored
      // spellings, so it is never user-invented here.
      query = query.ilike('location', locationMode);
    } else if (mode === 'following') {
      if (!following.size) {
        setPosts([]);
        setHasFollows(false);
        setFollowingCount(0);
        setLoading(false);
        loadSuggestions(user?.id ?? null);
        return;
      }
      setHasFollows(true);
      query = query.in('user_id', [...following]);
      // real count of active drops from people you follow (header pill)
      const { count } = await supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .is('parent_drop_id', null)
        .in('user_id', [...following])
        .gt('expires_at', new Date().toISOString());
      setFollowingCount(count ?? 0);
    } else if (mode === 'expiring') {
      const nowIso = new Date().toISOString();
      const soon = new Date(Date.now() + 6 * H).toISOString();
      query = supabase
        .from('posts')
        .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified)')
        .is('parent_drop_id', null)
        .gte('expires_at', nowIso)
        .lte('expires_at', soon)
        .order('expires_at', { ascending: true })
        .limit(80);
    } else if (mode === 'around') {
      // broad region discovery — only the user-set region string, no location data
      if (user) {
        const { data: mep } = await supabase.from('profiles').select('region').eq('id', user.id).maybeSingle();
        aroundRegion = (mep as any)?.region ?? null;
      }
      setMyRegion(aroundRegion);
    } else if (feedPrefs.location !== 'global' && user) {
      // location preference applies to every tab (Country / Around me)
      const { data: mep } = await supabase.from('profiles').select('region').eq('id', user.id).maybeSingle();
      aroundRegion = (mep as any)?.region ?? null;
    }

    const { data, error } = await query;
    if (error) {
      console.warn('feed load error', error.message);
      return;
    }

    let rows = ((data ?? []) as FeedPostRow[]).filter(
      (p) => !hidden.has(p.id) && !muted.has(p.user_id) && !blocked.has(p.user_id)
    );

    // ---- reposts by accounts you follow ----------------------------------
    // Reposting used to be invisible to everyone but the reposter: the feed only
    // ever read YOUR repost rows, so a repost was effectively a private bookmark.
    // Merge in reposts made by accounts you follow so a repost actually surfaces
    // a drop. Runs before the preference filters below, so repost entries are
    // subject to the same hidden / muted / blocked / content-type / region rules
    // as organic rows, and before `ids` so their like / save / reposted-by-me
    // state is resolved along with everything else.
    //
    // Skipped on the scoped lookups (drop / user / sound / hashtag) and on the
    // specialised tabs, where a repost would only be noise.
    const repostEligible =
      !!user &&
      following.size > 0 &&
      (mode === 'foryou' || mode === 'following') &&
      !dropMode &&
      !userMode &&
      !audioMode &&
      !hashtagMode &&
      !locationMode;

    if (repostEligible) {
      const { data: rpRows } = await supabase
        .from('reposts')
        .select('post_id, user_id, created_at')
        .in('user_id', [...following])
        .order('created_at', { ascending: false })
        .limit(40);

      const reposts = (rpRows ?? []) as { post_id: string; user_id: string; created_at: string }[];
      const repostPostIds = [...new Set(reposts.map((r) => r.post_id))];

      if (repostPostIds.length) {
        // reposter identity is fetched explicitly rather than via an embedded
        // join, so this does not depend on an FK constraint's generated name
        const [{ data: rpPosts }, { data: rpProfiles }] = await Promise.all([
          supabase
            .from('posts')
            .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region, verified)')
            .in('id', repostPostIds)
            .is('parent_drop_id', null),
          supabase
            .from('profiles')
            .select('id, username, avatar_url, verified')
            .in('id', [...new Set(reposts.map((r) => r.user_id))]),
        ]);

        const postById: Record<string, FeedPostRow> = {};
        ((rpPosts ?? []) as FeedPostRow[]).forEach((p) => {
          postById[p.id] = p;
        });
        const reposterById: Record<string, { username: string; avatar_url: string | null; verified: boolean }> = {};
        ((rpProfiles ?? []) as any[]).forEach((u) => {
          reposterById[u.id] = u;
        });

        const seen = new Set(rows.map((p) => p.id));
        const repostAt: Record<string, number> = {};
        const fromRepost: FeedPostRow[] = [];

        // rpRows is already newest-first, so the first time a post is seen it is
        // attributed to its most recent reposter
        for (const r of reposts) {
          // already in the feed organically, or already attributed to a newer
          // reposter — either way the drop must not appear twice
          if (seen.has(r.post_id)) continue;
          // a repost entry must obey the same viewer filters as organic rows
          if (muted.has(r.user_id) || blocked.has(r.user_id)) continue;
          const p = postById[r.post_id];
          // absent = expired, removed, or hidden by its own RLS policy — which is
          // what enforces the expiry rule for reposts, for free
          if (!p) continue;
          if (hidden.has(p.id) || muted.has(p.user_id) || blocked.has(p.user_id)) continue;

          const who = reposterById[r.user_id];
          seen.add(r.post_id);
          repostAt[r.post_id] = new Date(r.created_at).getTime();
          fromRepost.push({
            ...p,
            reposted_by: who
              ? { username: who.username, avatar_url: who.avatar_url, verified: who.verified }
              : null,
          });
        }

        if (fromRepost.length) {
          // interleave by effective recency: repost time for repost entries, post
          // time for organic rows. Organic rows are already created_at-desc, so
          // their relative order is preserved; reposts land where they happened.
          const when = (p: FeedPostRow) => repostAt[p.id] ?? new Date(p.created_at).getTime();
          // keep the feed's existing ceiling so the pager does not grow
          rows = [...rows, ...fromRepost].sort((a, b) => when(b) - when(a)).slice(0, 90);
        }
      }
    }

    // feed preferences — content types (empty selection = show everything)
    if (feedPrefs.content.length) {
      const wantVideo = feedPrefs.content.includes('video');
      const wantPhoto = feedPrefs.content.includes('photo');
      const wantText = feedPrefs.content.includes('text');
      rows = rows.filter((p) => {
        const isVideo = p.media_type === 'video' && !!p.media_url;
        const isPhoto =
          p.media_type === 'image' || !!p.media_url || (Array.isArray(p.media_items) && p.media_items.length > 0);
        const isText = !p.media_url && !p.media_items && !!p.content;
        if (isVideo && !wantVideo) return false;
        if (isPhoto && !wantPhoto) return false;
        if (isText && !wantText) return false;
        return true;
      });
    }

    // feed preferences — who to show
    if (feedPrefs.show === 'following' && following.size) {
      rows = rows.filter((p) => following.has(p.user_id));
    } else if (feedPrefs.show === 'new') {
      rows = rows.filter((p) => !following.has(p.user_id));
    }

    // Around You scope + location preference: region-locked unless Global
    const regionLocked =
      (mode === 'around' && aroundScope === 'region') || (mode !== 'around' && feedPrefs.location !== 'global');
    if (regionLocked) {
      if (aroundRegion) {
        const local = rows.filter(
          (p) => (p.profile?.region ?? '').toLowerCase() === aroundRegion.toLowerCase()
        );
        if (local.length > 0) {
          rows = local;
          setAroundFallback(false);
        } else {
          setAroundFallback(true);
        }
      } else {
        setAroundFallback(true);
      }
    } else {
      setAroundFallback(false);
    }

    // Expiring categories — real countdown buckets
    if (mode === 'expiring') {
      const nowMs = Date.now();
      const cap = expFilter === '1h' ? H : expFilter === 'gone' ? 10 * 60000 : 6 * H;
      rows = rows.filter((p) => new Date(p.expires_at).getTime() - nowMs <= cap);
    }

    const ids = rows.map((p) => p.id);

    // real velocity counters (privacy-safe views)
    let pulseMap = new Map<string, Pulse>();
    let responsesMap = new Map<string, number>();
    let tagMap = new Map<string, Set<string>>();
    if (ids.length) {
      // The three counter reads now live in loadPulse() so Discover can rank
      // creators on the same numbers. Still ONE round trip: it runs alongside the
      // other two reads instead of after them.
      const [resp, tags, pulses] = await Promise.all([
        supabase.from('posts').select('id, parent_drop_id').in('parent_drop_id', ids).limit(500),
        supabase.from('post_hashtags').select('post_id, tag').in('post_id', ids).limit(2000),
        loadPulse(ids),
      ]);
      pulseMap = pulses;
      (resp.data ?? []).forEach((x: any) => responsesMap.set(x.parent_drop_id, (responsesMap.get(x.parent_drop_id) ?? 0) + 1));
      (tags.data ?? []).forEach((x: any) => {
        if (!tagMap.has(x.post_id)) tagMap.set(x.post_id, new Set());
        tagMap.get(x.post_id)!.add(x.tag);
      });
    }

    // interaction sets
    let liked = new Set<string>();
    let saved = new Set<string>();
    let reposted = new Set<string>();
    let myReaction = new Map<string, string>();
    let reactionCounts = new Map<string, number>();

    if (user && ids.length) {
      const [l, s, r, rp] = await Promise.all([
        supabase.from('likes').select('post_id').in('post_id', ids).eq('user_id', user.id),
        supabase.from('saved_posts').select('post_id').in('post_id', ids).eq('user_id', user.id),
        supabase.from('post_reactions').select('post_id, user_id, reaction').in('post_id', ids),
        supabase.from('reposts').select('post_id').in('post_id', ids).eq('user_id', user.id),
      ]);
      liked = new Set((l.data ?? []).map((x) => x.post_id));
      saved = new Set((s.data ?? []).map((x) => x.post_id));
      reposted = new Set((rp.data ?? []).map((x) => x.post_id));
      const counts = new Map<string, number>();
      (r.data ?? []).forEach((x: any) => {
        if (x.user_id === user.id) myReaction.set(x.post_id, x.reaction);
        counts.set(x.post_id, (counts.get(x.post_id) ?? 0) + 1);
      });
      reactionCounts = counts;
    }

    // "Why am I seeing this?" — real signals only
    const now = Date.now();
    const reasonRows = rows.map((p) => {
      const pulse = pulseMap.get(p.id);
      const reasons: string[] = [];
      if (p.reposted_by) reasons.push(`@${p.reposted_by.username} reposted this`);
      if (following.has(p.user_id)) reasons.push('You follow this creator');
      if (now - new Date(p.created_at).getTime() < 6 * H) reasons.push('This Drop is fresh — new Drops get a discovery boost');
      if (pulse?.rising) reasons.push('This Drop is rising quickly');
      if (pulse?.trending) reasons.push('This Drop is trending right now');
      if ((pulse?.views30 ?? 0) >= 10) reasons.push('People are watching it right now');
      return reasons;
    });

    const enriched: FeedPostFull[] = rows.map((p, i) => ({
      ...p,
      liked_by_me: liked.has(p.id),
      following: following.has(p.user_id),
      follow_pending: pendingFollows.has(p.user_id),
      saved_by_me: saved.has(p.id),
      reposted_by_me: reposted.has(p.id),
      my_reaction: myReaction.get(p.id) ?? null,
      reactions_count: reactionCounts.get(p.id) ?? 0,
      pulse: pulseMap.get(p.id) ?? EMPTY_PULSE,
      responses_count: responsesMap.get(p.id) ?? 0,
      reasons: reasonRows[i] ?? [],
    }));

    let ranked = rankRows(enriched, mode, pulseMap, tagMap, notInterested, {
      sort: feedPrefs.sort,
      liveSection,
      // filtered views (one user / sound / tag / drop) are "show me these" —
      // the creator-diversity cap would wrongly cut them down
        noCap: !!(userMode || audioMode || hashtagMode || locationMode || dropMode),
    });
    // For You: never repeat a post you've already watched this session
    // (fall back to repeats only when the fresh pool would be too thin)
    if (mode === 'foryou') {
      const fresh = ranked.filter((p) => !seenIds.current.has(p.id));
      if (fresh.length >= 3) ranked = fresh;
    }
    setPosts(ranked);

    // FEED CONTENT IS READY — render immediately. Stories, chip badges and
    // the active-drop banner stream in below without gating the UI, so the
    // feed feels instant after login instead of waiting on every query.
    setLoading(false);

    if (!userMode && !dropMode && !audioMode && !hashtagMode && !locationMode && mode === 'foryou') {
      const { data: storyData } = await supabase
        .from('posts')
        .select('user_id, profile:profiles!posts_user_id_fkey(id, username, avatar_url, verified)')
        .order('created_at', { ascending: false })
        .limit(40);
      const seen = new Set<string>();
      const users: StoryUser[] = [];
      (storyData ?? []).forEach((s: any) => {
        const p = s.profile;
        if (!p || p.id === user?.id || seen.has(p.id)) return;
        seen.add(p.id);
        users.push({
          id: p.id,
          username: p.username,
          avatar_url: p.avatar_url,
          following: following.has(p.id),
          verified: p.verified ?? false,
        });
      });
      setStoryUsers(users.slice(0, 12));
    }

    if (!ranked.length) loadSuggestions(user?.id ?? null);

    // chip badges: LIVE dot (final 10 min) + EXPIRING count (next 6 hours)
    // + active drop banner — all independent, fetched concurrently.
    const nowIso = new Date().toISOString();
    const liveIso = new Date(Date.now() + 10 * 60000).toISOString();
    const expIso = new Date(Date.now() + 6 * 3600000).toISOString();
    const [{ count: liveC }, { count: expC }, { count: activeC }, { data: dropData }] = await Promise.all([
      supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .is('parent_drop_id', null)
        .gt('expires_at', nowIso)
        .lte('expires_at', liveIso),
      supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .is('parent_drop_id', null)
        .gte('expires_at', nowIso)
        .lte('expires_at', expIso),
      supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .is('parent_drop_id', null)
        .gt('expires_at', nowIso),
      supabase
        .from('drops')
        .select('*')
        .in('status', ['live', 'voting'])
        .order('starts_at', { ascending: false })
        .limit(1),
    ]);
    setLiveCount(liveC ?? 0);
    setExpiringCount(expC ?? 0);
    setActiveCount(activeC ?? 0);
    setActiveDrop((dropData?.[0] as Drop) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dropMode, userMode, audioMode, hashtagMode, locationMode, feedPrefs, liveSection, expFilter, aroundScope, rankRows, loadSuggestions]);

  useEffect(() => {
    load();
  }, [load]);

  // watch-time reporting — real signals for ranking + rising
  const finalizeWatch = useCallback(async (postId: string) => {
    const me = myIdRef.current;
    const w = watchRef.current.get(postId);
    if (!me || !w || w.reported) return;
    const ms = Date.now() - w.start;
    watchRef.current.set(postId, { ...w, reported: true });
    if (ms < 800) return;
    try {
      await supabase
        .from('post_views')
        .update({ watch_ms: ms, completed: ms >= 4000 })
        .eq('post_id', postId)
        .eq('user_id', me);
    } catch {
      // non-fatal
    }
  }, []);

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
      const prevIdx = activeIndexRef.current;
      const item = viewableItems[0].item as FeedPostFull;
      // finalize previous watch
      if (prevIdx !== idx && posts[prevIdx]) finalizeWatch(posts[prevIdx].id);
      // remember every post you've actually watched (For You no-repeat)
      viewableItems.forEach((v) => {
        if (v.item && (v.item as FeedPostFull).id) seenIds.current.add((v.item as FeedPostFull).id);
      });
      setActiveIndex(idx);
      recordView(item);
      if (!watchRef.current.has(item.id)) {
        watchRef.current.set(item.id, { start: Date.now(), reported: false });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finalizeWatch, recordView, posts]
  );
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;

  // 51, not 80. The threshold is a percentage OF THE ITEM, and every item here is
  // exactly one viewport tall (pagingEnabled + snapToInterval={height} +
  // getItemLayout length={height}), so 51% of an item ≈ 51% of the screen and at
  // most ONE item can ever clear it. That guarantees a unique active item.
  //
  // At 80 the feed could dead-end: stop scrolling with the current item only 70%
  // on screen and NOTHING passes the bar, so onViewable never fires, activeIndex
  // never moves, and the previous video keeps its audio running over a video the
  // user is now looking at. That is the "I can still hear the last video" report.
  // 51 also hands over at the halfway point of a swipe instead of at 80% of it.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 51 }).current;
  const keyExtractor = (p: FeedPostFull) => p.id;

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
      notifyUser({ userId: post.user_id, actorId: me, type: 'like', postId: post.id });
    }
  };

  // keep Follow state in sync across EVERY post by the same creator
  // (and the suggestion cards) — no more stale "Follow" buttons
  const setCreatorFollow = useCallback((userId: string, following: boolean, pending: boolean) => {
    setPosts((prev) =>
      prev.map((p) => (p.user_id === userId ? { ...p, following, follow_pending: pending } : p))
    );
    setSuggestions((prev) => prev.map((s) => (s.id === userId ? { ...s, following } : s)));
    setStoryUsers((prev) => prev.map((s) => (s.id === userId ? { ...s, following } : s)));
  }, []);

  const toggleFollow = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me || me === post.user_id) return;
    if (post.following) {
      setCreatorFollow(post.user_id, false, false);
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else if (post.follow_pending) {
      setCreatorFollow(post.user_id, false, false);
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else {
      const privateAccount = post.profile?.is_private ?? false;
      setCreatorFollow(post.user_id, !privateAccount, privateAccount);
      const { error } = await supabase.from('follows').insert({
        follower_id: me,
        following_id: post.user_id,
        status: privateAccount ? 'pending' : 'accepted',
      });
      if (error) {
        // surface RLS/DB failures instead of silently reverting the UI
        console.warn('follow insert failed', error.code, error.message);
        load();
      }
      if (!privateAccount && !error) {
        notifyUser({ userId: post.user_id, actorId: me, type: 'follow' });
      }
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
    const wasReposted = post.reposted_by_me;
    const reposting = !wasReposted;

    // optimistic — restored below if the write actually fails
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, reposted_by_me: reposting } : p)));

    const { error } = reposting
      ? await supabase.from('reposts').insert({ post_id: post.id, user_id: me })
      : await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', me);

    // 23505 = a concurrent tap already inserted the row. The end state we wanted
    // is "reposted", which is what the database now holds, so this is not a
    // failure. Same idiom as recordView below.
    const benign = reposting && error?.code === '23505';
    if (error && !benign) {
      // never leave the icon claiming a repost that did not land — the RLS
      // policy in supabase/reposts_enforcement.sql can now reject one outright
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, reposted_by_me: wasReposted } : p)));
      console.warn('repost failed', error.message);
      return;
    }

    if (reposting) notifyUser({ userId: post.user_id, actorId: me, type: 'repost', postId: post.id });
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
      if (!post.my_reaction) {
        notifyUser({ userId: post.user_id, actorId: me, type: 'reaction', postId: post.id });
      }
    }
  };

  // Remember the head of the timeline for the next cold start.
  //
  // Only 6 posts: enough to fill the first screen and warm the first two
  // videos. Caching the whole timeline would bloat AsyncStorage and risk
  // showing stale content; this is a launch accelerator, not an offline mode.
  useEffect(() => {
    if (mode !== 'foryou' || !posts.length) return;
    void put(cacheKey.feed('foryou'), posts.slice(0, 6));
  }, [posts, mode]);

  const removePost = (id: string) => setPosts((prev) => prev.filter((p) => p.id !== id));

  // follow straight from the suggestion cards (empty-feed onboarding)
  const followUser = async (id: string) => {
    const me = myIdRef.current;
    if (!me || me === id) return;
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: me, following_id: id, status: 'accepted' });
    if (error) console.warn('follow (suggestion) insert failed', error.code, error.message);
    notifyUser({ userId: id, actorId: me, type: 'follow' });
    setSuggestions((prev) => prev.map((s) => (s.id === id ? { ...s, following: true } : s)));
    setCreatorFollow(id, true, false);
  };

  // personalization actions — all real, all persisted
  const personalize = async (post: FeedPostFull, action: 'hide' | 'mute' | 'block' | 'notinterested' | 'report' | 'delete') => {
    const me = myIdRef.current;
    if (!me) return;
    if (action === 'delete') {
      if (post.user_id !== me) return;
      Alert.alert('Delete drop?', 'This removes it everywhere — likes, comments and replies go too.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('posts').delete().eq('id', post.id).eq('user_id', me);
            removePost(post.id);
          },
        },
      ]);
      return;
    }
    if (action === 'report') {
      await supabase.from('reports').insert({ reporter_id: me, post_id: post.id, reason: 'reported from feed' });
      return;
    }
    if (action === 'hide') {
      await supabase.from('hidden_posts').insert({ user_id: me, post_id: post.id });
    } else if (action === 'mute') {
      await supabase.from('muted_users').insert({ user_id: me, muted_id: post.user_id });
    } else if (action === 'block') {
      await supabase.from('blocks').insert({ blocker_id: me, blocked_id: post.user_id });
    } else if (action === 'notinterested') {
      await supabase.from('hidden_posts').insert({ user_id: me, post_id: post.id });
      const { data: tags } = await supabase.from('post_hashtags').select('tag').eq('post_id', post.id);
      for (const t of tags ?? []) {
        await supabase
          .from('not_interested_tags')
          .upsert({ user_id: me, tag: t.tag }, { onConflict: 'user_id,tag' });
      }
    }
    setPosts((prev) => prev.filter((p) => p.id !== post.id));
  };

  const sharePost = (post: FeedPostFull) => {
    Share.share({
      message: `Check this out on Gen Z — @${post.profile?.username ?? 'someone'}: ${post.caption ?? post.content ?? ''}`,
    });
  };

  const storiesVisible = storyUsers.length > 0 && !dropMode && !userMode && !audioMode && !hashtagMode && !locationMode && mode === 'foryou';

  // real dropper's name for the VIEWING banner — resolve from posts, then fetch profile
  const [userModeProfile, setUserModeProfile] = useState<{ username: string } | null>(null);
  useEffect(() => {
    if (!userMode) {
      setUserModeProfile(null);
      return;
    }
    let on = true;
    supabase
      .from('profiles')
      .select('username')
      .eq('id', userMode)
      .maybeSingle()
      .then(
        ({ data }) => {
          if (on && data) setUserModeProfile(data as { username: string });
        },
        () => {}
      );
    return () => {
      on = false;
    };
  }, [userMode]);

  const userModeName =
    posts.find((p) => p.user_id === userMode)?.profile?.username ??
    userModeProfile?.username ??
    storyUsers.find((u) => u.id === userMode)?.username ??
    null;

  // layout: brand → subtitle → discovery rail → sub-filter rows (Live/Expiring/Around)
  const hasSubRows = mode === 'live' || mode === 'expiring' || mode === 'around';
  const railTop = safeTop + 64;
  const subTop = safeTop + 112;
  const feedTop = hasSubRows ? safeTop + 176 : safeTop + 118;
  const bannerTop = hasSubRows ? safeTop + 192 : safeTop + 134;
  const feedBottom = insets.bottom > 0 ? 60 + insets.bottom : 76;

  // keep-alive: when the tab is hidden (focused=false) no video stays active,
  // so playback pauses instead of playing in the background.
  //
  // The overlays folded in below open ON TOP of the feed while the feed is still
  // the focused tab, so `focused` stays true and the post underneath kept its
  // audio — open someone's profile and you still heard the video you came from.
  // `isActive` is what FeedPost uses to pause BOTH its video and its attached
  // sound player, so routing the overlays through effectiveIndex silences both
  // using the existing path — the same trick the swipe handling below relies on.
  const overlayOpen = !!publicProfile || !!peek || showDrop || prefsOpen || storyAt !== null;
  const effectiveIndex = focused && !overlayOpen ? activeIndex : -1;

  // Silence the outgoing video the instant a swipe begins.
  //
  // Viewability only reports AFTER the incoming item has crossed the threshold, so
  // on its own the outgoing video keeps its audio for the whole gesture — you hear
  // the old sound right through the swipe. Every short-video feed cuts the audio on
  // touch instead.
  //
  // This reuses the existing path rather than adding a second pause mechanism:
  // FeedPost already pauses BOTH its video and its attached sound player whenever
  // isActive goes false, so dropping isActive during the gesture is enough.
  const [swiping, setSwiping] = useState(false);
  const swipeSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const holdForSwipe = useCallback(() => {
    if (swipeSettleRef.current) {
      clearTimeout(swipeSettleRef.current);
      swipeSettleRef.current = null;
    }
    setSwiping(true);
  }, []);

  // A fling fires onScrollEndDrag and THEN onMomentumScrollBegin. Releasing on the
  // drag-end alone would resume the audio mid-fling and pause it again a moment
  // later — audible as a blip. So the release is deferred briefly and cancelled if
  // momentum takes over.
  const releaseAfterSwipe = useCallback(() => {
    if (swipeSettleRef.current) clearTimeout(swipeSettleRef.current);
    swipeSettleRef.current = setTimeout(() => {
      swipeSettleRef.current = null;
      setSwiping(false);
    }, 140);
  }, []);

  useEffect(
    () => () => {
      if (swipeSettleRef.current) clearTimeout(swipeSettleRef.current);
    },
    []
  );

  const renderItem = ({ item, index }: { item: FeedPostFull; index: number }) => (
        <FeedPost
          post={item}
          isActive={!swiping && index === effectiveIndex}
          preload={index === effectiveIndex + 1}
      height={height}
      contentTop={feedTop}
      contentBottom={feedBottom}
      onLike={() => toggleLike(item)}
      onFollow={() => toggleFollow(item)}
      onComment={() => setCommentPost(item)}
      onShare={() => sharePost(item)}
      onSave={() => toggleSave(item)}
      onRepost={() => toggleRepost(item)}
      onOpenProfile={() =>
        setPeek({ id: item.user_id, username: item.profile?.username ?? 'unknown' })
      }
      onReact={(r) => toggleReaction(item, r)}
      onMenuAction={(a) => personalize(item, a)}
      onOpenSound={() => item.audio && setSoundName(item.audio)}
      onOpenChain={() => setChainRoot(item)}
      onExpired={() => setPosts((prev) => prev.filter((p) => p.id !== item.id))}
      onReplyWithDrop={() => onCreateIntent?.({ replyTo: item.id })}
      // Tapping a #hashtag in a caption filters the feed to it — the same
      // hashtagMode a tag chip or a tag in search results opens. No remount:
      // hashtagMode is already in the query effect's deps, so setting it refetches.
      onPressTag={(tag) => {
        setLocationMode(null);
        setUserMode(null);
        setAudioMode(null);
        setHashtagMode(tag);
      }}
    />
  );

  const emptyCopy = {
    following: {
      title: hasFollows ? "✓ You're all caught up" : 'Follow creators to fill your feed',
      text: hasFollows
        ? 'Check back when your people drop something new.'
        : 'The drops of people you follow appear here for 7 days.',
    },
    foryou: {
      title: 'Nothing here yet',
      text: 'Be the first to drop a moment — anything you post lives for 7 days.',
    },
    live: {
      title: 'Nothing live right now',
      text: 'Drops that are popping off right now will appear here.',
    },
    expiring: {
      title: 'No Drops ending soon',
      text: 'Everything on Gen Z is fresh — check back in a few hours.',
    },
    around: {
      title: myRegion
        ? 'No Drops from your region yet'
        : 'Set your region to discover nearby Drops',
      text: myRegion
        ? 'Drops from people in your region appear here for 7 days.'
        : 'Edit your profile → Region (e.g. Nigeria) to unlock 📍 Around You. Only the region you choose is shown — never an exact location.',
    },
  }[mode];

  // Real screen, not a sheet: Activity takes over the feed the way the profile
  // page takes over for Settings.
  if (notifOpen) {
    return (
      <ActivityScreen
        onBack={() => {
          setNotifOpen(false);
          loadUnread();
        }}
        onChanged={loadUnread}
        onOpenPost={openPostFromActivity}
      />
    );
  }

  return (
    <View style={styles.container}>
      {/* top readability scrim — fades to transparent below the nav, no hard navy band */}
      <View style={[styles.topScrim, { height: feedTop + 6 }]} pointerEvents="none">
        {[0.45, 0.45, 0.43, 0.4, 0.36, 0.31, 0.25, 0.18, 0.12, 0.06, 0].map((o, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgba(6,10,22,${o})` }} />
        ))}
      </View>
      {/* Brand lockup, pinned top-LEFT as in the reference. It used to be
          centred, which left the whole left half of the header empty and made
          the search/message controls look detached. */}
      <View style={[styles.topBrand, { paddingTop: safeTop + 6 }]} pointerEvents="none">
        <LogoHeader compact transparent align="start" />
      </View>

      {/* One right-aligned cluster instead of free-floating circles: search,
          messages, then the bell. Each is a real destination — search opens
          Discover, messages opens Chats, the bell opens Activity — so the row
          matches the reference without becoming decoration. */}
      <View style={[styles.topActions, { top: safeTop + 6 }]}>
        {onOpenSearch && (
          <Pressable
            style={styles.iconBtn}
            onPress={onOpenSearch}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Search"
          >
            <Icon name="search-outline" size={21} color={colors.logoWhite} />
          </Pressable>
        )}
        {onOpenChat && (
          <Pressable
            style={styles.iconBtn}
            onPress={onOpenChat}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Messages"
          >
            <Icon name="paper-plane-outline" size={20} color={colors.logoWhite} />
          </Pressable>
        )}
        <Pressable
          style={styles.iconBtn}
          onPress={() => setNotifOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Activity"
        >
          <Icon name="notifications-outline" size={21} color={colors.logoWhite} />
          {unreadCount > 0 && (
            <View style={styles.bellBadge}>
              <Text style={styles.bellBadgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* subtitle — "what's happening right now?", tucked under the wordmark so
          it never runs beneath the control cluster */}
      <View style={[styles.subtitle, { top: safeTop + 46 }]} pointerEvents="none">
        <Text style={styles.subtitleText}>What's happening right now?</Text>
      </View>

      {/* compact discovery rail — text tabs, orange underline for active, edge fades */}
      <View style={[styles.railWrap, { top: railTop, height: 40 }]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.railScroll}
          contentContainerStyle={styles.railContent}
        >
          {MODES.map((m) => {
            const active = mode === m.key;
            return (
              <Pressable
                key={m.key}
                style={[styles.railItem, active && styles.railItemActive]}
                onPress={() => {
                  setMode(m.key);
                  setUserMode(null);
                  setAudioMode(null);
                  setHashtagMode(null);
                  setLocationMode(null);
                  setDropMode(null);
                }}
                hitSlop={4}
              >
                <View style={styles.railLabelRow}>
                  {m.key === 'live' && liveCount > 0 && (
                    <Animated.View
                      style={[styles.railLiveDot, { opacity: railDotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]}
                    />
                  )}
                  <Text style={[styles.railText, active && styles.railTextActive]}>
                    {m.key === 'around' && mode === 'around' ? (myRegion ?? 'Near You') : m.label}
                  </Text>
                  {m.key === 'expiring' && expiringCount > 0 && (
                    <View style={styles.railExpBadge}>
                      <Text style={styles.railExpBadgeText}>{expiringCount > 9 ? '9+' : expiringCount}</Text>
                    </View>
                  )}
                </View>
                {active && <View style={styles.railUnderline} />}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* filter / preferences entry */}
        {/* NOTE: no `top` here. This button is a child of railWrap, which is itself
            absolutely positioned at `railTop` — passing railTop again measured from
            railWrap's own top edge and pushed the button a second railTop down the
            screen, so it floated over the video instead of sitting in the rail. */}
        <Pressable style={styles.railFilterBtn} onPress={() => setPrefsOpen(true)} hitSlop={6}>
          <Icon name="options-outline" size={16} color={colors.logoWhite} style={styles.railFilterIcon} />
        </Pressable>

        {/* edge fades so it's obvious more tabs exist */}
        {/* Same double-offset bug as the filter button: child of railWrap, so top:0. */}
        <View style={[styles.fadeEdge, styles.fadeLeft]} pointerEvents="none">
          {[0.75, 0.5, 0.3, 0.15, 0.06].map((o, i) => (
            <View key={i} style={[styles.fadeStrip, { backgroundColor: `rgba(6,10,22,${o})` }]} />
          ))}
        </View>
        <View style={[styles.fadeEdge, styles.fadeRight]} pointerEvents="none">
          {[0.06, 0.15, 0.3, 0.5, 0.75].map((o, i) => (
            <View key={i} style={[styles.fadeStrip, { backgroundColor: `rgba(6,10,22,${o})` }]} />
          ))}
        </View>
      </View>

      {/* Following: real new-drops count header */}
      {mode === 'following' && followingCount > 0 && (
        <View style={[styles.followHeader, { top: safeTop + 106 }]} pointerEvents="none">
          <Text style={styles.followHeaderText}>
            🔥 {followingCount} new Drop{followingCount === 1 ? '' : 's'}
          </Text>
        </View>
      )}

      {/* Live / Expiring / Around sub-filter rows — real data, real ranking */}
      {hasSubRows && (
        <View style={[styles.subRow, { top: subTop }]}>
          {mode === 'live' && (
            <>
              <View style={styles.subTaglineRow}>
                <View style={styles.subLiveDotWrap}>
                  <View style={styles.subLiveDot} />
                </View>
                <Text style={styles.subTagline}>LIVE NOW · {liveCount || 0} Drops active right now</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subChips}>
                {LIVE_SECTIONS.map((s) => (
                  <Pressable
                    key={s.key}
                    style={[styles.subChip, liveSection === s.key && styles.subChipActive]}
                    onPress={() => setLiveSection(s.key)}
                  >
                    <Text style={[styles.subChipText, liveSection === s.key && styles.subChipTextActive]}>
                      {s.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
          {mode === 'expiring' && (
            <>
              <View style={styles.subTaglineRow}>
                <Icon name="hourglass-outline" size={13} color={colors.accent} />
                <Text style={styles.subTagline}>EXPIRING — WATCH IT NOW OR IT'S GONE</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subChips}>
                {EXP_SECTIONS.map((s) => (
                  <Pressable
                    key={s.key}
                    style={[styles.subChip, expFilter === s.key && styles.subChipActive]}
                    onPress={() => setExpFilter(s.key)}
                  >
                    <Text style={[styles.subChipText, expFilter === s.key && styles.subChipTextActive]}>
                      {s.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
          {mode === 'around' && (
            <>
              <View style={styles.subTaglineRow}>
                <Icon name="location" size={13} color={colors.accent} />
                <Text style={styles.subTagline}>
                  {myRegion ? `${myRegion} Pulse · ${activeCount || 0} Drops active on GEN Z` : 'Around You — set your region in your profile'}
                </Text>
              </View>
              <View style={styles.subChips}>
                {AROUND_SCOPES.map((s) => (
                  <Pressable
                    key={s.key}
                    style={[styles.subChip, aroundScope === s.key && styles.subChipActive]}
                    onPress={() => setAroundScope(s.key)}
                  >
                    <Text style={[styles.subChipText, aroundScope === s.key && styles.subChipTextActive]}>
                      {s.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      )}

      {/* Around You: fallback note when the region scope has nothing */}
      {mode === 'around' && aroundFallback && (
        <View style={[styles.aroundNote, { top: safeTop + 184 }]} pointerEvents="none">
          <Icon name="globe-outline" size={12} color={colors.textMuted} />
          <Text style={styles.aroundNoteText}>
            {myRegion
              ? `Nothing near ${myRegion} yet — showing global picks`
              : 'Set your region to see drops near you — showing global picks'}
          </Text>
        </View>
      )}

      {storiesVisible && (
        <Animated.View
          style={[styles.storiesWrap, { top: safeTop + 118, opacity: storyFade }]}
          pointerEvents={activeIndex > 0 ? 'none' : 'auto'}
        >
          <FlatList
            data={storyUsers}
            horizontal
            keyExtractor={(u) => u.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storiesContent}
            renderItem={({ item, index }) => (
              <Pressable style={styles.storyItem} onPress={() => setStoryAt(index)}>
                <NeonRing size={58} stroke={2.4} active={item.following}>
                  <Avatar url={item.avatar_url} name={item.username} size={48} verified={!!item.verified} />
                </NeonRing>
                <View style={styles.storyNameRow}>
                  <Text style={styles.storyName} numberOfLines={1}>
                    {item.username}
                  </Text>
                  {!!item.verified && <VerifiedBadge size={9} glow={false} />}
                </View>
              </Pressable>
            )}
          />
        </Animated.View>
      )}

      {activeDrop && (
        <Animated.View
            style={[
            styles.dropBanner,
            {
              top: storiesVisible ? safeTop + 196 : bannerTop,
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
              <View style={styles.dropBannerTitleRow}>
                <Icon
                  name={dropMode ? 'cube-outline' : 'megaphone-outline'}
                  size={13}
                  color={colors.accent}
                />
                <Text style={styles.dropBannerTitle}>{dropMode ? 'IN DROP' : 'GEN Z DROP'}</Text>
              </View>
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

      {(userMode || audioMode || hashtagMode || locationMode) && (
        <Pressable
          style={[styles.dropBanner, { top: bannerTop }]}
          onPress={() => {
            setUserMode(null);
            setAudioMode(null);
            setHashtagMode(null);
            setLocationMode(null);
          }}
        >
          <View style={styles.dropBannerInner}>
            <View style={styles.dropBannerTitleRow}>
              <Icon
                name={userMode ? 'person' : audioMode ? 'musical-note' : locationMode ? 'location' : 'pricetag'}
                size={13}
                color={colors.accent}
              />
              <Text style={styles.dropBannerTitle} numberOfLines={1}>
                VIEWING{' '}
                {userMode
                  ? `@${userModeName ?? 'user'}`
                  : audioMode
                  ? audioMode
                  : locationMode
                  ? locationMode
                  : `#${hashtagMode}`}
              </Text>
            </View>
            <Text style={styles.dropBannerPrompt} numberOfLines={1}>
              {userMode
                ? 'Their drops, last 7 days'
                : locationMode
                ? 'Drops from here, last 7 days'
                : 'Matching drops — last 7 days'}
            </Text>
            <Text style={styles.dropBannerAction}>← Back to general feed</Text>
          </View>
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
          contentContainerStyle={styles.feedContent}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={viewabilityConfig}
          // cut the audio on touch; see holdForSwipe above
          onScrollBeginDrag={holdForSwipe}
          onMomentumScrollBegin={holdForSwipe}
          onScrollEndDrag={releaseAfterSwipe}
          onMomentumScrollEnd={releaseAfterSwipe}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          windowSize={5}
          ListEmptyComponent={
            <View style={[styles.emptyBox, { paddingTop: feedTop + 30 }]}>
              {mode === 'following' && (
                <View style={styles.emptyIconWrap}>
                  <Icon name="people" size={26} color={colors.accent} />
                </View>
              )}
              <Text style={styles.emptyTitle}>{emptyCopy.title}</Text>
              <Text style={styles.emptyText}>{emptyCopy.text}</Text>
              {/* primary action — the empty state should lead somewhere.
                  onCreateIntent already opens the Create screen via HomeScreen */}
              <Button
                title="Create a Drop"
                onPress={() => onCreateIntent?.({})}
                style={styles.emptyCta}
              />
              {/* The feed is empty because there are not enough PEOPLE yet, which
                  posting alone cannot fix — inviting is the only thing that does.
                  It belongs here rather than buried in settings, because this is
                  the screen where the absence is felt. */}
              <Pressable style={styles.inviteCta} onPress={() => setInviteOpen(true)}>
                <Icon name="person-add-outline" size={16} color={colors.accent} />
                <Text style={styles.inviteCtaText}>Invite friends to Gen Z</Text>
              </Pressable>
              {suggestions.length > 0 && (
                <View style={styles.suggestWrap}>
                  <View style={styles.suggestTitleRow}>
                    <Icon name="flame" size={15} color={colors.accent} />
                    <Text style={styles.suggestTitle}>
                      {mode === 'following' ? 'People you might like' : 'Discover something new'}
                    </Text>
                  </View>
                  <FlatList
                    data={suggestions}
                    horizontal
                    keyExtractor={(s) => s.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => (
                      <Pressable
                        style={styles.suggestCard}
                        onPress={() => setPublicProfile({ id: item.id, username: item.username })}
                      >
                        {item.avatar_url ? (
                          <Image source={{ uri: item.avatar_url }} style={styles.suggestAvatar} />
                        ) : (
                          <View style={[styles.suggestAvatar, styles.suggestAvatarPlaceholder]}>
                            <Text style={styles.suggestLetter}>{item.username.charAt(0).toUpperCase()}</Text>
                          </View>
                        )}
                        <View style={styles.suggestNameRow}>
                          <Text style={styles.suggestName} numberOfLines={1}>
                            @{item.username}
                          </Text>
                          {!!(item as any).verified && <VerifiedBadge size={11} glow={false} />}
                        </View>
                        <Pressable
                          style={[styles.suggestBtn, item.following && styles.suggestBtnFollowing]}
                          onPress={() => {
                            if (!item.following) followUser(item.id);
                          }}
                          hitSlop={4}
                        >
                          <Icon
                            name={item.following ? 'checkmark' : 'add'}
                            size={12}
                            color={item.following ? colors.accent : colors.bg}
                          />
                          <Text
                            style={[styles.suggestBtnText, item.following && styles.suggestBtnTextFollowing]}
                          >
                            {item.following ? 'Following' : 'Follow'}
                          </Text>
                        </Pressable>
                      </Pressable>
                    )}
                  />
                </View>
              )}
            </View>
          }
        />
      )}

      <CommentsModal
        post={commentPost}
        onClose={() => setCommentPost(null)}
        onPosted={() => {
          setPosts((prev) =>
            prev.map((p) => (p.id === commentPost?.id ? { ...p, comments_count: p.comments_count + 1 } : p))
          );
          const me = myIdRef.current;
          if (commentPost && me) {
            notifyUser({ userId: commentPost.user_id, actorId: me, type: 'comment', postId: commentPost.id });
          }
        }}
        onReplyWithDrop={() => {
          if (commentPost) onCreateIntent?.({ replyTo: commentPost.id });
          setCommentPost(null);
        }}
      />

      {/* opened from Activity: a notification pointing at a drop's comments */}
      <CommentsModal
        post={activityPost}
        onClose={() => setActivityPost(null)}
        onPosted={() => {
          setPosts((prev) =>
            prev.map((p) => (p.id === activityPost?.id ? { ...p, comments_count: p.comments_count + 1 } : p))
          );
        }}
      />

      {/* Full-screen story viewer. Tapping an avatar in the rail opens that
          person's live drops full-bleed, with the rail's own order preserved so
          you can keep tapping through the people you were just looking at. */}
      <Modal
        visible={storyAt !== null}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setStoryAt(null)}
      >
        {storyAt !== null && (
          <StoryViewer
            users={storyUsers}
            startIndex={storyAt}
            onClose={() => setStoryAt(null)}
            onOpenProfile={(id) => {
              setStoryAt(null);
              const u = storyUsers.find((s) => s.id === id);
              if (u) setPeek({ id: u.id, username: u.username });
            }}
          />
        )}
      </Modal>

      {chainRoot && (
        <ChainModal
          root={chainRoot}
          onClose={() => setChainRoot(null)}
          onReplyWithDrop={() => {
            onCreateIntent?.({ replyTo: chainRoot.id });
            setChainRoot(null);
          }}
        />
      )}

      {soundName && (
        <SoundPage
          name={soundName}
          onClose={() => setSoundName(null)}
          onUseSound={() => {
            onCreateIntent?.({ sound: soundName });
            setSoundName(null);
          }}
        />
      )}

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

      <InviteSheet
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
        // A successful redemption is the one moment the feed could genuinely have
        // new content behind it, so re-read rather than assume nothing changed.
        onRedeemed={() => {
          void load();
        }}
      />

      {publicProfile && (
        <PublicProfileScreen
          userId={publicProfile.id}
          username={publicProfile.username}
          onClose={() => setPublicProfile(null)}
          onFollowChanged={setCreatorFollow}
        />
      )}

      <ProfilePeekModal
        user={peek}
        onClose={() => setPeek(null)}
        onFollowChanged={setCreatorFollow}
        onOpenFull={(id, username) => {
          setPeek(null);
          setPublicProfile({ id, username });
        }}
      />

      <FeedPrefsModal
        visible={prefsOpen}
        initial={feedPrefs}
        onClose={() => setPrefsOpen(false)}
        onApply={(p) => {
          setFeedPrefs(p);
          setPrefsOpen(false);
        }}
      />

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

function FeedPrefsModal({
  visible,
  initial,
  onClose,
  onApply,
}: {
  visible: boolean;
  initial: FeedPrefs;
  onClose: () => void;
  onApply: (p: FeedPrefs) => void;
}) {
  const [content, setContent] = useState<string[]>(initial.content);
  const [show, setShow] = useState<FeedPrefs['show']>(initial.show);
  const [location, setLocation] = useState<FeedPrefs['location']>(initial.location);
  const [sort, setSort] = useState<FeedPrefs['sort']>(initial.sort);

  // re-sync the draft every time the sheet opens
  useEffect(() => {
    if (visible) {
      setContent(initial.content);
      setShow(initial.show);
      setLocation(initial.location);
      setSort(initial.sort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toggleContent = (t: string) =>
    setContent((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const CONTENT_OPTS = [
    { key: 'video', label: 'Videos' },
    { key: 'photo', label: 'Photos' },
    { key: 'text', label: 'Text' },
    { key: 'chains', label: 'Drop Chains' },
  ];
  const SHOW_OPTS: { key: FeedPrefs['show']; label: string }[] = [
    { key: 'everyone', label: 'Everyone' },
    { key: 'following', label: 'People I follow' },
    { key: 'new', label: 'New creators' },
  ];
  const LOC_OPTS: { key: FeedPrefs['location']; label: string }[] = [
    { key: 'global', label: 'Global' },
    { key: 'country', label: 'Country' },
    { key: 'around', label: 'Around me' },
  ];
  const SORT_OPTS: { key: FeedPrefs['sort']; label: string }[] = [
    { key: 'recommended', label: 'Recommended' },
    { key: 'fresh', label: 'Freshest' },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.prefsOverlay} onPress={onClose}>
        <Pressable style={styles.prefsSheet} onPress={() => {}}>
          <View style={styles.prefsTitleRow}>
            <Icon name="options-outline" size={18} color={colors.accent} />
            <Text style={styles.prefsTitle}>Feed preferences</Text>
          </View>

          <Text style={styles.prefsSectionLabel}>Content</Text>
          <View style={styles.prefsChipRow}>
            {CONTENT_OPTS.map((o) => {
              const on = content.includes(o.key);
              return (
                <Pressable
                  key={o.key}
                  style={[styles.prefsChip, on && styles.prefsChipActive]}
                  onPress={() => toggleContent(o.key)}
                >
                  <Text style={[styles.prefsChipText, on && styles.prefsChipTextActive]}>
                    {on ? `☑ ${o.label}` : `☐ ${o.label}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.prefsSectionLabel}>Show me</Text>
          <View style={styles.prefsRow}>
            {SHOW_OPTS.map((o) => (
              <Pressable
                key={o.key}
                style={[styles.prefsRowBtn, show === o.key && styles.prefsRowActive]}
                onPress={() => setShow(o.key)}
              >
                <Text style={[styles.prefsRowText, show === o.key && styles.prefsRowTextActive]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.prefsSectionLabel}>Location</Text>
          <View style={styles.prefsRow}>
            {LOC_OPTS.map((o) => (
              <Pressable
                key={o.key}
                style={[styles.prefsRowBtn, location === o.key && styles.prefsRowActive]}
                onPress={() => setLocation(o.key)}
              >
                <Text style={[styles.prefsRowText, location === o.key && styles.prefsRowTextActive]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.prefsSectionLabel}>Sort</Text>
          <View style={styles.prefsRow}>
            {SORT_OPTS.map((o) => (
              <Pressable
                key={o.key}
                style={[styles.prefsRowBtn, sort === o.key && styles.prefsRowActive]}
                onPress={() => setSort(o.key)}
              >
                <Text style={[styles.prefsRowText, sort === o.key && styles.prefsRowTextActive]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.prefsBtnRow}>
            <Pressable
              style={styles.prefsReset}
              onPress={() => {
                setContent([]);
                setShow('everyone');
                setLocation('global');
                setSort('recommended');
              }}
            >
              <Text style={styles.prefsResetText}>Reset</Text>
            </Pressable>
            <Pressable
              style={styles.prefsDone}
              onPress={() => onApply({ content: content as FeedPrefs['content'], show, location, sort })}
            >
              <Text style={styles.prefsDoneText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9,
  },
  topBrand: {
    position: 'absolute',
    top: 0,
    left: 16,
    zIndex: 12,
    alignItems: 'flex-start',
  },
  topActions: {
    position: 'absolute',
    right: 12,
    zIndex: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subtitle: {
    position: 'absolute',
    left: 18,
    right: 150,
    zIndex: 12,
    alignItems: 'flex-start',
  },
  subtitleText: {
    color: colors.textMuted,
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  railWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 11,
  },
  railScroll: { flexGrow: 0 },
  railContent: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 22,
    paddingHorizontal: 20,
    paddingRight: 68,
  },
  railItem: {
    alignItems: 'center',
    paddingBottom: 2,
  },
  railItemActive: { opacity: 1 },
  railLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
  },
  railText: {
    color: 'rgba(214,222,238,0.62)',
    fontSize: 15,
    fontWeight: '700',
  },
  railTextActive: {
    color: colors.accent,
    textShadowColor: 'rgba(255,122,0,0.45)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  railUnderline: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
    alignSelf: 'stretch',
    marginTop: 3,
    ...shadows.glow,
  },
  railLiveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  railExpBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,122,0,0.18)',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  railExpBadgeText: { color: colors.accent, fontSize: 9.5, fontWeight: '800' },
  railFilterBtn: {
    position: 'absolute',
    right: 10,
    // 30px button centred in the 40px rail. `top` is deliberately relative to
    // railWrap — do NOT pass railTop here, that offset is already on the parent.
    top: 5,
    zIndex: 14,
    backgroundColor: 'rgba(13,20,38,0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 999,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railFilterIcon: {
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  fadeEdge: {
    position: 'absolute',
    height: 40,
    width: 20,
    zIndex: 13,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  fadeLeft: { left: 0 },
  fadeRight: { right: 44 },
  fadeStrip: { width: 4, height: '100%' },
  followHeader: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 10,
    backgroundColor: 'rgba(13,20,38,0.88)',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    ...shadows.glow,
  },
  followHeaderText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  subRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 16,
  },
  subTaglineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 7,
  },
  subLiveDotWrap: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,92,124,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.danger,
  },
  subTagline: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  subChips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 4,
  },
  subChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(13,20,38,0.8)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  subChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(255,122,0,0.16)',
  },
  subChipText: { color: 'rgba(214,222,238,0.62)', fontSize: 11.5, fontWeight: '700' },
  subChipTextActive: { color: colors.accent },
  prefsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(4,8,18,0.72)',
    justifyContent: 'flex-end',
  },
  prefsSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  prefsTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 18 },
  prefsTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  prefsSectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 8,
  },
  prefsChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  prefsChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  prefsChipActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(255,122,0,0.14)',
  },
  prefsChipText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  prefsChipTextActive: { color: colors.accent },
  prefsRow: { flexDirection: 'row', gap: 8 },
  prefsRowBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    paddingVertical: 10,
  },
  prefsRowActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(255,122,0,0.12)',
  },
  prefsRowText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  prefsRowTextActive: { color: colors.accent },
  prefsBtnRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  prefsReset: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: 12,
  },
  prefsResetText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  prefsDone: {
    flex: 2,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    paddingVertical: 12,
    ...shadows.glow,
  },
  prefsDoneText: { color: colors.bg, fontSize: 14, fontWeight: '800' },
  bellBtn: {
    position: 'absolute',
    right: 14,
    zIndex: 13,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    padding: 9,
  },
  iconBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
    borderRadius: 999,
  },
  bellBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  bellBadgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '800',
  },
  aroundNote: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(13,20,38,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  aroundNoteText: { color: colors.textMuted, fontSize: 11, fontWeight: '600', flex: 1 },
  storiesWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
  },
  storiesContent: { paddingHorizontal: 16 },
  storyItem: { alignItems: 'center', marginRight: 14, width: 64 },
  // The ring itself now lives in NeonRing (a gradient stroke), so only the
  // spacing of the rail item stays here.
  storyAvatar: { width: 48, height: 48, borderRadius: 24 },
  storyAvatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storyAvatarLetter: { color: colors.accent, fontSize: 20, fontWeight: '800' },
  storyNameRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5, justifyContent: 'center' },
  storyName: { color: colors.textMuted, fontSize: 10 },
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
  dropBannerInner: { paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
  liveHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.danger },
  liveText: {
    color: colors.danger,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginLeft: 5,
  },
  votingBadge: { backgroundColor: 'rgba(139,123,255,0.15)' },
  votingText: { color: colors.violet },
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
  joinPillText: { color: colors.bg, fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  bannerBack: { color: colors.cyan, fontSize: 12, fontWeight: '600' },
  dropBannerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dropBannerTitle: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1, textAlign: 'center' },
  dropBannerPrompt: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 3, textAlign: 'center' },
  dropBannerTime: { marginTop: 4 },
  dropBannerAction: { color: colors.cyan, fontSize: 12, marginTop: 4, fontWeight: '600', textAlign: 'center' },
  skeletonWrap: { flex: 1 },
  skeletonBlock: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    justifyContent: 'flex-end',
    padding: 20,
    paddingBottom: 40,
  },
  skeletonBar: { width: '55%', height: 16, borderRadius: 8, backgroundColor: colors.surfaceAlt },
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
    paddingBottom: 120,
    backgroundColor: colors.bg,
  },
  feedContent: { flexGrow: 1 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  emptyCta: { width: '100%', maxWidth: 280, marginTop: 22 },
  // Secondary to "Create a Drop": lighter, so posting stays the primary action
  // while inviting is still one tap away on the screen that needs it most.
  inviteCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  inviteCtaText: { color: colors.accent, fontSize: 13.5, fontWeight: '800' },
  suggestWrap: { marginTop: 24, width: '100%' },
  suggestTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  suggestTitle: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  suggestCard: {
    width: 110,
    marginRight: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  suggestAvatar: { width: 56, height: 56, borderRadius: 28 },
  suggestAvatarPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestLetter: { color: colors.accent, fontSize: 22, fontWeight: '800' },
  suggestNameRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, justifyContent: 'center' },
  suggestName: { color: colors.text, fontSize: 12, fontWeight: '600' },
  suggestBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  suggestBtnFollowing: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  suggestBtnText: { color: colors.bg, fontSize: 11, fontWeight: '800' },
  suggestBtnTextFollowing: { color: colors.accent },
  emptyIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    marginBottom: 10,
  },
});
