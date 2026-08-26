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
import { useInsets } from '../utils/useInsets';
import DropCountdown from '../components/DropCountdown';
import FeedPost, { setFeedUserId } from '../components/FeedPost';
import CommentsModal from '../components/CommentsModal';
import ChainModal from '../components/ChainModal';
import SoundPage from '../components/SoundPage';
import DropExperienceScreen from './DropExperienceScreen';
import PublicProfileScreen from './PublicProfileScreen';
import ProfilePeekModal from '../components/ProfilePeekModal';

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
};

export type Pulse = {
  views30: number;
  likes30: number;
  comments30: number;
  rising: boolean;
  trending: boolean;
};

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

const MODES: { key: FeedMode; label: string }[] = [
  { key: 'following', label: 'Following' },
  { key: 'foryou', label: 'For You' },
  { key: 'live', label: 'Live' },
  { key: 'expiring', label: '⏳ Expiring' },
  { key: 'around', label: '📍 Around You' },
];

const PAGE_SIZE = 50;
const H = 3600 * 1000;
const MIN_VIEWS_RISING = 20;
const MIN_ENGAGEMENT_RISING = 2;

export default function FeedScreen({
  onJoinDrop,
  onCreateIntent,
  initialUserMode = null,
  initialAudioMode = null,
  initialHashtagMode = null,
}: {
  onJoinDrop?: () => void;
  onCreateIntent?: (intent: { sound?: string; replyTo?: string }) => void;
  initialUserMode?: string | null;
  initialAudioMode?: string | null;
  initialHashtagMode?: string | null;
}) {
  const { height } = useWindowDimensions();
  const insets = useInsets();
  const [mode, setMode] = useState<FeedMode>('foryou');
  const [posts, setPosts] = useState<FeedPostFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [commentPost, setCommentPost] = useState<FeedPostFull | null>(null);
  const [chainRoot, setChainRoot] = useState<FeedPostFull | null>(null);
  const [soundName, setSoundName] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<StoryUser[]>([]);
  const [activeDrop, setActiveDrop] = useState<Drop | null>(null);
  const [dropMode, setDropMode] = useState<string | null>(null);
  const [userMode, setUserMode] = useState<string | null>(initialUserMode);
  const [audioMode, setAudioMode] = useState<string | null>(initialAudioMode);
  const [hashtagMode, setHashtagMode] = useState<string | null>(initialHashtagMode);
  const [showDrop, setShowDrop] = useState(false);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);
  const [peek, setPeek] = useState<{ id: string; username: string } | null>(null);
  const [myRegion, setMyRegion] = useState<string | null>(null);
  const [storyUsers, setStoryUsers] = useState<StoryUser[]>([]);
  const myIdRef = useRef<string | null>(null);
  const watchRef = useRef<Map<string, { start: number; reported: boolean }>>(new Map());

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

  // rank a page of drops with real signals (no fake numbers)
  const rankRows = useCallback(
    (rows: FeedPostRow[], m: FeedMode, pulseMap: Map<string, Pulse>, tagMap: Map<string, Set<string>>, notInterested: Set<string>) => {
      const now = Date.now();
      const velocityOf = (p: Pulse) => p.views30 * 0.7 + p.likes30 * 2.2 + p.comments30 * 3.2;
      const engagementOf = (r: FeedPostRow) =>
        Math.log1p(r.likes_count) * 1.1 + Math.log1p(r.comments_count) * 1.6 + r.views_count * 0.03;

      const scored = rows.map((r) => {
        const pulse = pulseMap.get(r.id) ?? { views30: 0, likes30: 0, comments30: 0, rising: false, trending: false };
        const ageH = Math.max(0, (now - new Date(r.created_at).getTime()) / H);
        let score = 0;
        if (m === 'foryou') {
          const freshness = 2 * Math.exp(-ageH / 14);
          const dampen = [...(tagMap.get(r.id) ?? [])].some((t) => notInterested.has(t)) ? 2.5 : 0;
          score = freshness + velocityOf(pulse) + engagementOf(r) - dampen;
        } else if (m === 'live') {
          const freshness = 3 * Math.exp(-ageH / 6);
          score = velocityOf(pulse) * 3 + freshness + Math.log1p(r.likes_count + r.comments_count + 1);
        } else {
          score = now - new Date(r.created_at).getTime();
        }
        return { r, pulse, score };
      });

      scored.sort((a, b) =>
        m === 'expiring' ? new Date(a.r.expires_at).getTime() - new Date(b.r.expires_at).getTime() : b.score - a.score
      );

      // creator diversity — cap repeats per creator
      const perCreator = new Map<string, number>();
      const cap = m === 'live' ? 2 : 3;
      const out: FeedPostFull[] = [];
      for (const { r, pulse } of scored) {
        const c = perCreator.get(r.user_id) ?? 0;
        if (c >= cap) continue;
        perCreator.set(r.user_id, c + 1);
        out.push(r as FeedPostFull);
        if (out.length >= PAGE_SIZE) break;
      }
      return out;
    },
    []
  );

  const loadSuggestions = useCallback(async (me: string | null) => {
    const [hid, mut, blk] = await Promise.all([
      supabase.from('hidden_posts').select('post_id'),
      supabase.from('muted_users').select('muted_id'),
      supabase.from('blocks').select('blocked_id').eq('blocker_id', me ?? ''),
    ]);
    const hidden = new Set((hid.data ?? []).map((x) => x.post_id));
    const muted = new Set((mut.data ?? []).map((x) => x.muted_id));
    const blocked = new Set((blk.data ?? []).map((x) => x.blocked_id));
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .neq('id', me ?? '')
      .order('created_at', { ascending: false })
      .limit(12);
    setSuggestions(
      ((profs ?? []) as { id: string; username: string; avatar_url: string | null }[]).filter(
        (u) => !hidden.has(u.id) && !muted.has(u.id) && !blocked.has(u.id)
      )
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
    const blocked = new Set((blk.data ?? []).map((x) => x.blocked_id ?? x.blocker_id));
    const notInterested = new Set((notInt.data ?? []).map((x) => x.tag));

    let following = new Set<string>();
    if (user) {
      const { data: f } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', user.id)
        .eq('status', 'accepted');
      following = new Set((f ?? []).map((x) => x.following_id));
    }

    let aroundRegion: string | null = null;
    let query = supabase
      .from('posts')
      .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region)')
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
    } else if (mode === 'following') {
      if (!following.size) {
        setPosts([]);
        setLoading(false);
        loadSuggestions(user?.id ?? null);
        return;
      }
      query = query.in('user_id', [...following]);
    } else if (mode === 'expiring') {
      const nowIso = new Date().toISOString();
      const soon = new Date(Date.now() + 3 * H).toISOString();
      query = supabase
        .from('posts')
        .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, is_private, region)')
        .gte('expires_at', nowIso)
        .lte('expires_at', soon)
        .order('expires_at', { ascending: true })
        .limit(60);
    } else if (mode === 'around') {
      // broad region discovery — only the user-set region string, no location data
      if (user) {
        const { data: mep } = await supabase.from('profiles').select('region').eq('id', user.id).maybeSingle();
        aroundRegion = (mep as any)?.region ?? null;
      }
      setMyRegion(aroundRegion);
      if (!aroundRegion) {
        setPosts([]);
        setLoading(false);
        return;
      }
    }

    const { data, error } = await query;
    if (error) {
      console.warn('feed load error', error.message);
      return;
    }

    let rows = ((data ?? []) as FeedPostRow[]).filter(
      (p) => !hidden.has(p.id) && !muted.has(p.user_id) && !blocked.has(p.user_id) && p.id !== user?.id
    );
    if (mode === 'around' && aroundRegion) {
      rows = rows.filter((p) => (p.profile?.region ?? '').toLowerCase() === aroundRegion.toLowerCase());
    }
    const ids = rows.map((p) => p.id);

    // real velocity counters (privacy-safe views)
    let pulseMap = new Map<string, Pulse>();
    let responsesMap = new Map<string, number>();
    let tagMap = new Map<string, Set<string>>();
    if (ids.length) {
      const since30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const [pv, lk, cm, resp, tags] = await Promise.all([
        supabase.from('post_view_counts').select('post_id').in('post_id', ids).gte('viewed_at', since30).limit(3000),
        supabase.from('like_counts').select('post_id').in('post_id', ids).gte('created_at', since30).limit(3000),
        supabase.from('comment_counts').select('post_id').in('post_id', ids).gte('created_at', since30).limit(3000),
        supabase.from('posts').select('id, parent_drop_id').in('parent_drop_id', ids).limit(500),
        supabase.from('post_hashtags').select('post_id, tag').in('post_id', ids).limit(2000),
      ]);
      const count = (arr: { post_id: string }[] | null) => {
        const m = new Map<string, number>();
        (arr ?? []).forEach((x) => m.set(x.post_id, (m.get(x.post_id) ?? 0) + 1));
        return m;
      };
      const views30 = count(pv.data);
      const likes30 = count(lk.data);
      const comments30 = count(cm.data);
      (resp.data ?? []).forEach((x: any) => responsesMap.set(x.parent_drop_id, (responsesMap.get(x.parent_drop_id) ?? 0) + 1));
      (tags.data ?? []).forEach((x: any) => {
        if (!tagMap.has(x.post_id)) tagMap.set(x.post_id, new Set());
        tagMap.get(x.post_id)!.add(x.tag);
      });
      // trending = top 5 by velocity in this page
      const velocityScores = [...new Set(ids)].map((id) => ({
        id,
        v: (views30.get(id) ?? 0) * 0.7 + (likes30.get(id) ?? 0) * 2.2 + (comments30.get(id) ?? 0) * 3.2,
      }));
      velocityScores.sort((a, b) => b.v - a.v);
      const trendingSet = new Set(velocityScores.slice(0, 5).map((x) => x.id));
      ids.forEach((id) => {
        const v30 = views30.get(id) ?? 0;
        const l30 = likes30.get(id) ?? 0;
        const c30 = comments30.get(id) ?? 0;
        pulseMap.set(id, {
          views30: v30,
          likes30: l30,
          comments30: c30,
          rising: v30 >= MIN_VIEWS_RISING && l30 + c30 >= MIN_ENGAGEMENT_RISING,
          trending: trendingSet.has(id),
        });
      });
    }

    // interaction sets
    let liked = new Set<string>();
    let saved = new Set<string>();
    let reposted = new Set<string>();
    let myReaction = new Map<string, string>();
    let reactionCounts = new Map<string, number>();
    let pending = new Set<string>();

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
      follow_pending: pending.has(p.user_id),
      saved_by_me: saved.has(p.id),
      reposted_by_me: reposted.has(p.id),
      my_reaction: myReaction.get(p.id) ?? null,
      reactions_count: reactionCounts.get(p.id) ?? 0,
      pulse: pulseMap.get(p.id) ?? { views30: 0, likes30: 0, comments30: 0, rising: false, trending: false },
      responses_count: responsesMap.get(p.id) ?? 0,
      reasons: reasonRows[i] ?? [],
    }));

    const ranked = rankRows(rows, mode, pulseMap, tagMap, notInterested);
    setPosts(ranked);

    if (!userMode && !dropMode && !audioMode && !hashtagMode && mode === 'foryou') {
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

    if (!posts.length) loadSuggestions(user?.id ?? null);

    const { data: dropData } = await supabase
      .from('drops')
      .select('*')
      .in('status', ['live', 'voting'])
      .order('starts_at', { ascending: false })
      .limit(1);
    setActiveDrop((dropData?.[0] as Drop) ?? null);

    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, dropMode, userMode, audioMode, hashtagMode, rankRows, loadSuggestions]);

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

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
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
    }
  };

  const toggleFollow = async (post: FeedPostFull) => {
    const me = myIdRef.current;
    if (!me || me === post.user_id) return;
    if (post.following) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, following: false } : p)));
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else if (post.follow_pending) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, follow_pending: false } : p)));
      const { error } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      if (error) load();
    } else {
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

  // personalization actions — all real, all persisted
  const personalize = async (post: FeedPostFull, action: 'hide' | 'mute' | 'block' | 'notinterested' | 'report') => {
    const me = myIdRef.current;
    if (!me) return;
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

  const storiesVisible = storyUsers.length > 0 && !dropMode && !userMode && !audioMode && !hashtagMode && mode === 'foryou';

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

  // keep the video inside the frame: below the mode chips, above the tab bar
  const feedTop = insets.top + 80;
  const feedBottom = insets.bottom > 0 ? 60 + insets.bottom : 76;

  const renderItem = ({ item, index }: { item: FeedPostFull; index: number }) => (
    <FeedPost
      post={item}
      isActive={index === activeIndex}
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
    />
  );

  const emptyCopy = {
    following: {
      title: 'Follow creators to fill your feed',
      text: 'The drops of people you follow appear here for 48 hours.',
    },
    foryou: {
      title: 'Your Feed is warming up… 🔥',
      text: 'Post your first Drop or check out the creators below.',
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
        ? 'Drops from people in your region appear here for 48 hours.'
        : 'Edit your profile → Region (e.g. Nigeria) to unlock 📍 Around You. Only the region you choose is shown — never an exact location.',
    },
  }[mode];

  return (
    <View style={styles.container}>
      <View style={[styles.topScrim, { height: insets.top + 108 }]} pointerEvents="none" />
      <View style={[styles.topBrand, { paddingTop: insets.top + 8 }]} pointerEvents="none">
        <LogoHeader compact transparent />
      </View>

      {/* primary feed modes */}
      <View style={[styles.modeBar, { top: insets.top + 46 }]}>
        {MODES.map((m) => (
          <Pressable
            key={m.key}
            style={[styles.modeChip, mode === m.key && styles.modeChipActive]}
            onPress={() => {
              setMode(m.key);
              setUserMode(null);
              setAudioMode(null);
              setHashtagMode(null);
              setDropMode(null);
            }}
          >
            <Text style={[styles.modeChipText, mode === m.key && styles.modeChipTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>

      {storiesVisible && (
        <View style={[styles.storiesWrap, { top: insets.top + 88 }]}>
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
              top: storiesVisible ? insets.top + 176 : insets.top + 100,
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
          style={[styles.dropBanner, { top: insets.top + 100 }]}
          onPress={() => {
            setUserMode(null);
            setAudioMode(null);
            setHashtagMode(null);
          }}
        >
          <View style={styles.dropBannerInner}>
            <Text style={styles.dropBannerTitle} numberOfLines={1}>
              ◉ VIEWING{' '}
              {userMode ? `@${userModeName ?? 'user'}` : audioMode ? `♪ ${audioMode}` : `#${hashtagMode}`}
            </Text>
            <Text style={styles.dropBannerPrompt} numberOfLines={1}>
              {userMode ? 'Their drops, last 48 hours' : 'Matching drops — last 48 hours'}
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
              <Text style={styles.emptyTitle}>{emptyCopy.title}</Text>
              <Text style={styles.emptyText}>{emptyCopy.text}</Text>
              {suggestions.length > 0 && (
                <View style={styles.suggestWrap}>
                  <Text style={styles.suggestTitle}>🔥 Discover something new</Text>
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
                        <Text style={styles.suggestName} numberOfLines={1}>
                          @{item.username}
                        </Text>
                        <View style={styles.suggestBtn}>
                          <Text style={styles.suggestBtnText}>View drops</Text>
                        </View>
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
        onPosted={() =>
          setPosts((prev) =>
            prev.map((p) => (p.id === commentPost?.id ? { ...p, comments_count: p.comments_count + 1 } : p))
          )
        }
        onReplyWithDrop={() => {
          if (commentPost) onCreateIntent?.({ replyTo: commentPost.id });
          setCommentPost(null);
        }}
      />

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

      {publicProfile && (
        <PublicProfileScreen
          userId={publicProfile.id}
          username={publicProfile.username}
          onClose={() => setPublicProfile(null)}
        />
      )}

      <ProfilePeekModal
        user={peek}
        onClose={() => setPeek(null)}
        onOpenFull={(id, username) => {
          setPeek(null);
          setPublicProfile({ id, username });
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9,
    backgroundColor: 'rgba(6,10,22,0.45)',
  },
  topBrand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 12,
    alignItems: 'center',
  },
  modeBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 11,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  modeChip: {
    backgroundColor: 'rgba(13,20,38,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  modeChipActive: {
    backgroundColor: 'rgba(255,122,0,0.22)',
    borderColor: colors.accent,
    ...shadows.glow,
  },
  modeChipText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '700' },
  modeChipTextActive: { color: colors.accent },
  storiesWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
  },
  storiesContent: { paddingHorizontal: 16 },
  storyItem: { alignItems: 'center', marginRight: 14, width: 64 },
  storyRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: colors.accent,
    padding: 2,
    ...shadows.glow,
  },
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
  storyName: { color: colors.textMuted, fontSize: 10, marginTop: 5 },
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
    backgroundColor: colors.bg,
  },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  suggestWrap: { marginTop: 24, width: '100%' },
  suggestTitle: { color: colors.accent, fontSize: 14, fontWeight: '800', marginBottom: 12 },
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
  suggestName: { color: colors.text, fontSize: 12, marginTop: 8, fontWeight: '600' },
  suggestBtn: {
    marginTop: 10,
    backgroundColor: 'rgba(255,122,0,0.16)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  suggestBtnText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
});
