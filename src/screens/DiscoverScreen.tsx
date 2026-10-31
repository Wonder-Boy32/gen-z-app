import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Icon, { IconName } from '../components/ui/Icon';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import {
  GradientFill,
  Glow,
  Press,
  CornerBrackets,
  PillBar,
  SectionHead,
  FILL,
} from '../components/ui/Futuristic';
import PostViewer from '../components/PostViewer';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import DropExperienceScreen from './DropExperienceScreen';
import PublicProfileScreen from './PublicProfileScreen';
import SearchResults from '../components/SearchResults';
import { fmtCount } from '../components/FeedPost';
import Avatar from '../components/Avatar';
import { useAndroidBack } from '../utils/useAndroidBack';
import { type Pulse, EMPTY_PULSE, loadPulse, velocityOf } from '../utils/ranking';

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
  created_at: string | null;
  profile: {
    username: string;
    avatar_url: string | null;
    verified?: boolean;
    // coarse community only — never a precise location
    region?: string | null;
  } | null;
};

type Props = {
  onOpenUser: (id: string) => void;
  onOpenAudio: (audio: string) => void;
  onOpenTag: (tag: string) => void;
  /** Show every live drop posted from one place. Parallel to onOpenTag. */
  onOpenLocation: (place: string) => void;
  onJoinDrop: () => void;
};

const engagement = (p: P) => p.likes_count + p.comments_count + p.views_count;

/**
 * A person, as people-discovery needs them.
 *
 * Derived from the profile already embedded in each post rather than from a
 * separate profiles query: the authors of the posts we already hold ARE the
 * candidate creators, and they already carry username, avatar, verified, region.
 */
type Person = {
  id: string;
  username: string;
  avatar_url: string | null;
  verified?: boolean;
  region?: string | null;
};

function personFrom(p: P): Person | null {
  if (!p.profile || !p.user_id) return null;
  return {
    id: p.user_id,
    username: p.profile.username,
    avatar_url: p.profile.avatar_url,
    verified: p.profile.verified,
    region: p.profile.region ?? null,
  };
}

type DiscCat = 'creators' | 'trending' | 'fresh' | 'campus' | 'drops';

// Four chips, on purpose. 'drops' is intentionally absent from the row: Drops are
// reached through SEARCH now rather than occupying a permanent section. A chip row
// of four is a journey; six was a menu.
//
// The first chip used to be "For You". It rendered NOTHING — show() is exclusive
// and no show('foryou') block was ever written — and it also duplicated the Home
// feed's own For You mode, which is the more advanced one: it ranks posts by real
// 30-minute velocity. Discover therefore does the job Home cannot: it ranks
// PEOPLE. Same scorer (utils/ranking), different subject, so the two surfaces
// cannot disagree about who is rising.
const DISC_CATS: { id: DiscCat; label: string }[] = [
  { id: 'creators', label: '✨ Creators' },
  { id: 'trending', label: '🔥 Trending' },
  { id: 'fresh', label: '⚡ Just Dropped' },
  { id: 'campus', label: '🎓 Campus' },
];

/**
 * The expiring identity, expressed as time left rather than a raw duration.
 * 🔥 under 6h, ⏳ otherwise, ⚡ inside the last hour.
 */
function timeLeft(expiresAt: string): { text: string; icon: IconName; urgent: boolean } {
  const h = (new Date(expiresAt).getTime() - Date.now()) / 3600000;
  if (!Number.isFinite(h) || h <= 0) {
    return { text: 'Ended', icon: 'alert-circle-outline', urgent: true };
  }
  if (h < 1) {
    return { text: `${Math.max(1, Math.round(h * 60))}m left`, icon: 'flash-outline', urgent: true };
  }
  if (h < 6) {
    return { text: `${Math.round(h)}h left`, icon: 'flame-outline', urgent: true };
  }
  return { text: `${Math.round(h)}h left`, icon: 'hourglass-outline', urgent: false };
}

export default function DiscoverScreen({ onOpenUser, onOpenAudio, onOpenTag, onOpenLocation, onJoinDrop }: Props) {
  const [posts, setPosts] = useState<P[]>([]);
  // 30-minute velocity for those posts, from utils/ranking — the same numbers the
  // Home feed ranks with. Creators are ordered by the SUM of this across their
  // posts, which is exactly how Home scores its Rising Creators section.
  const [pulseMap, setPulseMap] = useState<Map<string, Pulse>>(() => new Map());
  const [drops, setDrops] = useState<(Drop & { posts: number })[]>([]);
  const [creators, setCreators] = useState<{
    id: string;
    username: string;
    avatar_url: string | null;
    verified?: boolean;
    bio?: string | null;
    region?: string | null;
  }[]>([]);
  const [sounds, setSounds] = useState<{ audio: string; count: number }[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  // tapping a post opens the FULL home-feed-style pager (not a small card)
  const [viewer, setViewer] = useState<{ list: P[]; index: number } | null>(null);
  const [openDrop, setOpenDrop] = useState<Drop | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);

  // Android back control. This screen owns two full-screen overlays that are
  // plain conditional renders, NOT <Modal>s, so RN's onRequestClose never saw
  // the press: it fell through to HomeScreen (which popped to the Feed tab)
  // and the overlay stayed open behind the tab change. Innermost first, then
  // decline so the press continues outward.
  useAndroidBack(() => {
    if (publicProfile) {
      setPublicProfile(null);
      return true;
    }
    if (openDrop) {
      setOpenDrop(null);
      return true;
    }
    return false;
  });

  // ---- discovery controls ----
  const [cat, setCat] = useState<DiscCat>('creators');
  const [searchFocused, setSearchFocused] = useState(false);
  // session-only. DiscoverScreen stays mounted across tab switches, so this
  // survives normal use; it is deliberately not persisted anywhere.
  const [recent, setRecent] = useState<string[]>([]);
  const [myRegion, setMyRegion] = useState<string | null>(null);
  const { width: winW } = useWindowDimensions();

  // Grid geometry from the real window width. Percentage widths COLLAPSE inside a
  // flexWrap row on Android — that crushed the discovery tiles to min-content and
  // wrapped their labels one character per line.
  const GRID_GAP = 10;
  const gridW = Math.max(200, winW - 32); // content paddingHorizontal 16 * 2
  const halfW = Math.floor((gridW - GRID_GAP) / 2);

  /** [big] then [small small], repeating — deterministic rows, no wrap guesswork */
  const gridRows = (list: P[]): P[][] => {
    const rows: P[][] = [];
    for (let i = 0; i < list.length; i += 3) rows.push(list.slice(i, i + 3));
    return rows;
  };

  useEffect(() => {
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        if (!auth?.user) return;
        const { data } = await supabase
          .from('profiles')
          .select('region')
          .eq('id', auth.user.id)
          .maybeSingle();
        setMyRegion((data as { region?: string | null } | null)?.region ?? null);
      } catch {
        // the campus shelf just stays in its "set your campus" state
      }
    })();
  }, []);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const me = user?.id ?? null;

    const [{ data: postRows }, { data: dropRows }, { data: creatorRows }, { data: soundRows }, { data: tagRows }] =
      await Promise.all([
        supabase
          .from('posts')
          .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url, verified, region)')
          .is('parent_drop_id', null)
          // Never surface a drop past its expiry. The DB purge (expiry_v2.sql) should
          // already have removed these, but the purge runs on a 5-minute cron and
          // every shelf on this screen is derived from this ONE query — so without
          // this filter an expired drop keeps appearing in Trending, Just Dropped,
          // Campus and Creators until the job next fires (or forever, if the job
          // is not running).
          .gt('expires_at', new Date().toISOString())
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
          .select('id, username, avatar_url, created_at, verified, bio, region')
          .neq('id', me ?? '')
          .order('created_at', { ascending: false })
          .limit(8),
        supabase.from('posts').select('audio').not('audio', 'is', null).limit(500),
        // Live tags, biggest first. Reads hashtag_suggest() rather than the
        // hashtags table: that table is a cache which used to drift upward
        // permanently, whereas this function counts live posts directly — so the
        // count on the chip is the number of drops tapping it will actually show.
        supabase.rpc('hashtag_suggest', { p_prefix: '', p_limit: 8 }),
      ]);

    setPosts((postRows ?? []) as P[]);

    // Velocity for the posts we just loaded. Best-effort on purpose: if the
    // counter tables are unreachable, people discovery still works — it just
    // falls back to newest-first ordering instead of failing to render.
    try {
      setPulseMap(await loadPulse(((postRows ?? []) as P[]).map((p) => p.id)));
    } catch {
      setPulseMap(new Map());
    }

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

    // hashtag_suggest() names its count `post_count`; the chip list below was
    // written against `count`, so map rather than touch every consumer.
    setTags(
      ((tagRows ?? []) as { tag: string; post_count: number }[]).map((t) => ({
        tag: t.tag,
        count: t.post_count,
      }))
    );
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

  // newest first — the "Just Dropped" shelf, taken from the same pool so it costs
  // no extra query and no extra latency
  const justDropped = useMemo(
    () =>
      [...posts]
        .sort((a, b) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0))
        .slice(0, 8),
    [posts]
  );

  // Campus shelf, matched on the coarse region only. When we don't know the
  // user's campus we show a prompt rather than guessing or asking for location.
  const campusPosts = useMemo(
    () => (myRegion ? posts.filter((p) => p.profile?.region === myRegion).slice(0, 6) : []),
    [posts, myRegion]
  );
  const campusCreators = useMemo(
    () => (myRegion ? creators.filter((c) => (c.region ?? null) === myRegion).slice(0, 8) : []),
    [creators, myRegion]
  );

  // ---- people discovery (the Creators chip) --------------------------------
  // Ranked by the SUM of velocityOf() across a creator's posts — the same maths
  // Home already uses for its Rising Creators, via the same imported scorer. No
  // new query: this is derived from the posts already in memory.
  const risingCreators = useMemo(() => {
    const acc = new Map<string, { person: Person; v: number }>();
    for (const p of posts) {
      const person = personFrom(p);
      if (!person) continue;
      const v = velocityOf(pulseMap.get(p.id) ?? EMPTY_PULSE);
      if (v <= 0) continue;
      const cur = acc.get(person.id);
      acc.set(person.id, { person, v: (cur?.v ?? 0) + v });
    }
    return [...acc.values()]
      .sort((a, b) => b.v - a.v)
      .slice(0, 10)
      .map((x) => x.person);
  }, [posts, pulseMap]);

  /** Distinct authors who posted from your campus — one card per person. */
  const campusPeople = useMemo(() => {
    if (!myRegion) return [] as Person[];
    const seen = new Set<string>();
    const out: Person[] = [];
    for (const p of posts) {
      const person = personFrom(p);
      if (!person || seen.has(person.id)) continue;
      if ((person.region ?? '') !== myRegion) continue;
      seen.add(person.id);
      out.push(person);
    }
    return out.slice(0, 10);
  }, [posts, myRegion]);

  /** record a term in this session's recent list (dedup, newest first, cap 6) */
  const rememberSearch = (q: string) => {
    const term = q.trim();
    if (!term) return;
    setRecent((r) => [term, ...r.filter((x) => x.toLowerCase() !== term.toLowerCase())].slice(0, 6));
  };

  /**
   * EXCLUSIVE: one chip, one experience. Each category owns its own shelf.
   *
   * The gate must stay exclusive. An earlier version read
   * `cat === 'foryou' || cat === c`, which returned true for EVERY category while
   * "For You" was selected, stacking Trending + Drops + Campus + People + Sounds +
   * Tags on one screen. Removing the `cat === 'foryou' ||` half fixed that but
   * left the For You chip rendering nothing at all, because no show('foryou')
   * block existed to replace it. That is why this chip now has real content of
   * its own (see show('creators') below) instead of relying on a fallthrough.
   */
  const show = (c: DiscCat) => cat === c;

  const nothingAtAll = !posts.length && !drops.length && !creators.length;

  // Open the tapped post in the full-screen pager (home-feed style). The
  // video's first bytes are warmed ahead so the first frame comes faster.
  const openViewer = (list: P[], index: number) => {
    const p = list[index];
    if (p?.media_type === 'video' && p.media_url) {
      try {
        fetch(p.media_url, { headers: { Range: 'bytes=0-1048575' } }).catch(() => {});
      } catch {
        // ignore — warming is best-effort
      }
    }
    setViewer({ list, index });
  };

  const renderCard = (p: P, list: P[]) => {
    const idx = list.findIndex((x) => x.id === p.id);
    const left = timeLeft(p.expires_at);
    return (
      <Press style={styles.videoCard} onPress={() => openViewer(list, idx)} shrink={0.98}>
        <CardMedia post={p} />

        {/* time-left badge — the expiring identity, never the raw number */}
        <View style={[styles.tlBadge, left.urgent && styles.tlBadgeUrgent]}>
          <Icon name={left.icon} size={11} color={left.urgent ? colors.danger : colors.accent} />
          <Text style={[styles.tlText, left.urgent && styles.tlTextUrgent]}>{left.text}</Text>
        </View>

        <View style={styles.cardOverlay}>
          <View style={styles.cardUserRow}>
            <Avatar url={p.profile?.avatar_url ?? null} name={p.profile?.username ?? '?'} size={22} ring />
            <Text style={styles.cardUser} numberOfLines={1}>
              @{p.profile?.username ?? 'unknown'}
            </Text>
            {!!p.profile?.verified && <VerifiedBadge size={10} glow={false} />}
          </View>
          {!!p.caption?.trim() && (
            <Text style={styles.cardCaption} numberOfLines={2}>
              {p.caption.trim()}
            </Text>
          )}
          <View style={styles.statRow}>
            <Icon name="heart" size={11} color={colors.logoWhite} />
            <Text style={styles.cardLikes}>{fmtCount(p.likes_count)}</Text>
            <Text style={styles.cardDot}>·</Text>
            <Icon name="play" size={10} color={colors.textMuted} />
            <Text style={styles.cardLikes}>{fmtCount(p.views_count)}</Text>
          </View>
        </View>
      </Press>
    );
  };

  /**
   * Person card, shared by all three people shelves.
   *
   * Deliberately NOT a navigate-to-Feed action: Discover already owns a public
   * profile overlay, so tapping a face keeps the user here instead of yanking them
   * to another tab mid-browse.
   */
  const renderPerson = (c: Person, note?: string) => (
    <Press
      key={c.id}
      style={styles.person}
      onPress={() => setPublicProfile({ id: c.id, username: c.username })}
      shrink={0.97}
    >
      <Avatar url={c.avatar_url} name={c.username} size={54} ring verified={!!c.verified} />
      <View style={styles.personNameRow}>
        <Text style={styles.personName} numberOfLines={1}>
          @{c.username}
        </Text>
        {!!c.verified && <VerifiedBadge size={11} glow={false} />}
      </View>
      <Text style={styles.personBio} numberOfLines={2}>
        {note || c.region || 'New on Gen Z'}
      </Text>
      <View style={styles.personFollow}>
        <Text style={styles.personFollowText}>Follow</Text>
      </View>
    </Press>
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
      {searchFocused ? (
        /* ---------- focused search ---------- */
        <View style={styles.dcSearchOverlay}>
          <View style={styles.dcSearchBar}>
            <Icon name="search" size={16} color={colors.accent} />
            <TextInput
              style={styles.dcSearchInput}
              placeholder="Search people, moments, Drops..."
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={() => rememberSearch(searchQuery)}
              returnKeyType="search"
            />
            {!!searchQuery && (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
                <Icon name="close-circle" size={16} color={colors.textMuted} />
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                setSearchFocused(false);
                setSearchQuery('');
              }}
              hitSlop={8}
            >
              <Text style={styles.dcCancel}>Cancel</Text>
            </Pressable>
          </View>

          {searchQuery.trim() ? (
            <SearchResults
              query={searchQuery.trim()}
              onPickQuery={(q) => {
                setSearchQuery(q);
                rememberSearch(q);
              }}
              onOpenUser={onOpenUser}
              onOpenAudio={onOpenAudio}
              onOpenTag={onOpenTag}
              onOpenLocation={onOpenLocation}
              onJoinDrop={onJoinDrop}
            />
          ) : (
            <View style={styles.dcSearchIdle}>
              {recent.length > 0 && (
                <>
                  <Text style={styles.dcMiniLabel}>RECENT</Text>
                  <View style={styles.dcChipWrap}>
                    {recent.map((r) => (
                      <Pressable
                        key={r}
                        style={styles.dcChip}
                        onPress={() => {
                          setSearchQuery(r);
                          rememberSearch(r);
                        }}
                      >
                        <Icon name="time-outline" size={12} color={colors.textMuted} />
                        <Text style={styles.dcChipText}>{r}</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}
              <Text style={styles.dcMiniLabel}>SEARCH FOR</Text>
              <View style={styles.dcChipWrap}>
                {['people', 'drops', 'campus', 'trending'].map((s) => (
                  <Pressable
                    key={s}
                    style={styles.dcChip}
                    onPress={() => {
                      setSearchQuery(s);
                      rememberSearch(s);
                    }}
                  >
                    <Icon name="search-outline" size={12} color={colors.accent} />
                    <Text style={styles.dcChipText}>{s}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.dcSearchHint}>
                Nothing found? Try a person, a Drop or a topic.
              </Text>
            </View>
          )}
        </View>
      ) : (
        <>
        {/* ---------- persistent brand header ---------- */}
        <View style={styles.dcHeader}>
          <Image source={require('../../assets/icon-navy.png')} style={styles.dcMark} />
          <Text style={styles.dcBrand}>GEN Z</Text>
          <View style={styles.dcBadge}>
            <View style={styles.dcBadgeDot} />
            <Text style={styles.dcBadgeText}>EXPLORE</Text>
          </View>
        </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ---------- page identity ---------- */}
        <Text style={styles.dcWord}>DISCOVER</Text>
        <Text style={styles.dcTitle}>Find your next moment.</Text>

        {/* ---------- search entry point ---------- */}
        <Press style={styles.dcSearch} onPress={() => setSearchFocused(true)} shrink={0.99}>
          {/* tokens, not literals — dcSearchText reads colors.textMuted and
              goes dark in White mode, so this panel must lighten with it */}
          <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={10} horizontal style={FILL} />
          <Glow color={colors.accent} size={140} strength={0.1} style={styles.dcSearchGlow} />
          <Icon name="search" size={17} color={colors.accent} />
          <Text style={styles.dcSearchText}>Search people, moments, Drops...</Text>
          <View style={styles.dcSearchGo}>
            <Icon name="arrow-forward" size={13} color={colors.bg} />
          </View>
        </Press>

        {/* ---------- categories ---------- */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.dcCats}
        >
          <PillBar options={DISC_CATS} value={cat} onChange={setCat} />
        </ScrollView>
        {/* ---------- TRENDING NOW ---------- */}
        {show('trending') && (
          <>
            <SectionHead icon="flame" title="Trending Now" sub="What everyone is checking out." />
            {trendingVideos.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                {trendingVideos.map((p) => (
                  <View key={p.id}>{renderCard(p, trendingVideos)}</View>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.empty}>Nothing trending yet — post something.</Text>
            )}
          </>
        )}

        {/* The "Active Drops" shelf was removed here. It was gated on
            show('drops'), and `cat` only ever takes the four values in DISC_CATS —
            so it could never render. Drops are reached through SEARCH now.
            Recoverable from git history if the shelf is ever wanted back. */}

        {/* ---------- AROUND CAMPUS ---------- */}
        {show('campus') && (
          <>
            <SectionHead
              icon="school"
              title="Around Campus"
              sub="See what's happening around your campus."
              tint={colors.violet}
            />
            {myRegion ? (
              campusPosts.length || campusCreators.length ? (
                <>
                  {campusCreators.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                      {campusCreators.map((c) => (
                        <Press
                          key={c.id}
                          style={styles.person}
                          onPress={() => setPublicProfile({ id: c.id, username: c.username })}
                          shrink={0.97}
                        >
                          <Avatar url={c.avatar_url} name={c.username} size={54} ring verified={!!c.verified} />
                          <Text style={styles.personName} numberOfLines={1}>
                            @{c.username}
                          </Text>
                          <Text style={styles.personBio} numberOfLines={2}>
                            {c.bio?.trim() || 'New on Gen Z'}
                          </Text>
                          <View style={styles.personFollow}>
                            <Text style={styles.personFollowText}>Follow</Text>
                          </View>
                        </Press>
                      ))}
                    </ScrollView>
                  )}
                  {gridRows(campusPosts).map((row, ri) => (
                    <View key={`c${ri}`} style={styles.dcRowGroup}>
                      <Press
                        style={[styles.tile, { width: gridW, height: 230 }]}
                        onPress={() => openViewer(campusPosts, ri * 3)}
                        shrink={0.98}
                      >
                        <CardMedia post={row[0]} />
                        <View style={styles.tileOverlay}>
                          <Icon name={timeLeft(row[0].expires_at).icon} size={10} color={colors.accent} />
                          <Text style={styles.tileTime}>{timeLeft(row[0].expires_at).text}</Text>
                        </View>
                      </Press>
                      {row.length > 1 && (
                        <View style={styles.dcHalfRow}>
                          {row.slice(1).map((p, ci) => (
                            <Press
                              key={p.id}
                              style={[styles.tile, { width: halfW, height: 168 }]}
                              onPress={() => openViewer(campusPosts, ri * 3 + ci + 1)}
                              shrink={0.98}
                            >
                              <CardMedia post={p} />
                              <View style={styles.tileOverlay}>
                                <Icon name={timeLeft(p.expires_at).icon} size={10} color={colors.accent} />
                                <Text style={styles.tileTime}>{timeLeft(p.expires_at).text}</Text>
                              </View>
                            </Press>
                          ))}
                        </View>
                      )}
                    </View>
                  ))}
                </>
              ) : (
                <Text style={styles.empty}>Quiet around {myRegion} right now.</Text>
              )
            ) : (
              <View style={styles.dcPrompt}>
                <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={12} style={FILL} />
                <CornerBrackets color="rgba(139,123,255,0.35)" size={16} inset={10} />
                <Text style={styles.dcPromptTitle}>Choose your campus</Text>
                <Text style={styles.dcPromptText}>
                  Add a campus to your profile and moments from people around you show up here. We
                  only ever use campus level — never your exact location.
                </Text>
              </View>
            )}
          </>
        )}

        {/* ---------- CREATORS (the default chip) ----------
            People, not posts. Home's For You already ranks POSTS with real
            30-minute velocity, so repeating that here would be a weaker copy. This
            is the surface Home genuinely lacks: who is worth watching, ranked with
            the SAME imported scorer so the two screens cannot disagree.

            Capped at three shelves on purpose. This screen previously stacked six
            sections at once, and that is the problem this composition replaces. */}
        {show('creators') && (
          <>
            {risingCreators.length > 0 && (
              <>
                <SectionHead
                  icon="flame"
                  title="Rising right now"
                  sub="Moving fastest over the last 30 minutes."
                  tint={colors.accent}
                />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                  {risingCreators.map((c) => renderPerson(c, 'Rising now'))}
                </ScrollView>
              </>
            )}

            {campusPeople.length > 0 && (
              <>
                <SectionHead
                  icon="location-outline"
                  title={`Posting from ${myRegion}`}
                  sub="Campus level only — never your exact location."
                  tint={colors.cyan}
                />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                  {campusPeople.map((c) => renderPerson(c))}
                </ScrollView>
              </>
            )}

            {creators.length > 0 && (
              <>
                <SectionHead
                  icon="people"
                  title="New on Gen Z"
                  sub="Fresh faces to follow."
                  tint={colors.cyan}
                />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                  {creators.map((c) => renderPerson(c, c.bio?.trim() || undefined))}
                </ScrollView>
              </>
            )}

            {/* Never blank. The old For You chip rendered an empty page whenever it
                was selected; this one always says something and points somewhere. */}
            {!risingCreators.length && !campusPeople.length && !creators.length && (
              <Text style={styles.empty}>
                No one to suggest yet — try searching for someone by name.
              </Text>
            )}
          </>
        )}

        {/* ---------- JUST DROPPED ---------- */}
        {show('fresh') && (
          <>
            <SectionHead
              icon="flash-outline"
              title="Just Dropped"
              sub="Fresh moments from the Gen Z community."
              tint={colors.accent}
            />
            {justDropped.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dcRow}>
                {justDropped.map((p, i) => (
                  <Press
                    key={p.id}
                    style={styles.freshCard}
                    onPress={() => openViewer(justDropped, i)}
                    shrink={0.98}
                  >
                    <View style={styles.freshMedia}>
                      <CardMedia post={p} />
                      <View style={styles.freshNew}>
                        <Text style={styles.freshNewText}>NEW</Text>
                      </View>
                    </View>
                    <Text style={styles.freshUser} numberOfLines={1}>
                      @{p.profile?.username ?? 'unknown'}
                    </Text>
                    <View style={styles.statRow}>
                      <Icon name={timeLeft(p.expires_at).icon} size={11} color={colors.accent} />
                      <Text style={styles.freshTime}>{timeLeft(p.expires_at).text}</Text>
                    </View>
                  </Press>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.empty}>Nothing has dropped yet.</Text>
            )}
          </>
        )}

        {/* ---------- DISCOVERY GRID (mixed tile sizes) ---------- */}
        {show('trending') && watching.length > 0 && (
          <>
            <SectionHead icon="eye" title="Everyone Is Watching" sub="The biggest moments on Gen Z." />
            {gridRows(watching).map((row, ri) => (
              <View key={`w${ri}`} style={styles.dcRowGroup}>
                <Press
                  style={[styles.tile, { width: gridW, height: 230 }]}
                  onPress={() => openViewer(watching, ri * 3)}
                  shrink={0.98}
                >
                  <CardMedia post={row[0]} />
                  <View style={styles.tileOverlay}>
                    <View style={styles.statRow}>
                      <Icon name="heart" size={10} color={colors.logoWhite} />
                      <Text style={styles.tileLikes}>{fmtCount(row[0].likes_count)}</Text>
                    </View>
                    <View style={styles.statRow}>
                      <Icon name={timeLeft(row[0].expires_at).icon} size={10} color={colors.accent} />
                      <Text style={styles.tileTime}>{timeLeft(row[0].expires_at).text}</Text>
                    </View>
                  </View>
                </Press>
                {row.length > 1 && (
                  <View style={styles.dcHalfRow}>
                    {row.slice(1).map((p, ci) => (
                      <Press
                        key={p.id}
                        style={[styles.tile, { width: halfW, height: 168 }]}
                        onPress={() => openViewer(watching, ri * 3 + ci + 1)}
                        shrink={0.98}
                      >
                        <CardMedia post={p} />
                        <View style={styles.tileOverlay}>
                          <View style={styles.statRow}>
                            <Icon name="heart" size={10} color={colors.logoWhite} />
                            <Text style={styles.tileLikes}>{fmtCount(p.likes_count)}</Text>
                          </View>
                          <View style={styles.statRow}>
                            <Icon name={timeLeft(p.expires_at).icon} size={10} color={colors.accent} />
                            <Text style={styles.tileTime}>{timeLeft(p.expires_at).text}</Text>
                          </View>
                        </View>
                      </Press>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </>
        )}

        {/* ---------- SOUNDS + TAGS: intentionally NOT on Discover ----------
            These two sections used to sit permanently under For You as
            "Trending Sounds" and "Trending Tags".

            They are now reached through SEARCH, which already renders them —
            components/SearchResults.tsx has Hashtags (line 350), Sounds (line
            371) and People (line 256). Nothing is lost; complexity moved one
            step deeper, which is the whole point of this redesign.

            Discover is: search -> For You | Trending | Just Dropped | Campus
            -> the chosen experience becomes the focus.
        ------------------------------------------------------------------- */}

        {/* ---------- EMPTY STATE ---------- */}
        {nothingAtAll && (
          <View style={styles.dcEmpty}>
            <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={14} style={FILL} />
            <Glow color={colors.accent} size={220} strength={0.14} style={styles.dcEmptyGlow} />
            <CornerBrackets color="rgba(193,59,255,0.4)" size={20} inset={12} />
            {/* An empty feed should read as "you're early", not "this app is
                broken". Same pixels, completely different feeling. */}
            <Text style={styles.dcEmptyTitle}>You&apos;re early. 👀</Text>
            <Text style={styles.dcEmptyText}>
              The next Moment could start here.
            </Text>
            <Press style={styles.dcEmptyBtn} onPress={onJoinDrop}>
              <GradientFill from={colors.accent} to={colors.accentStrong} steps={10} horizontal style={FILL} />
              <Icon name="add" size={16} color={colors.bg} />
              <Text style={styles.dcEmptyBtnText}>CREATE A MOMENT →</Text>
            </Press>
          </View>
        )}
      </ScrollView>
        </>
      )}

      {viewer && (
        <View style={styles.viewerWrap}>
          <PostViewer
            posts={viewer.list as any}
            index={viewer.index}
            onClose={() => setViewer(null)}
          />
        </View>
      )}

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
        <View style={styles.videoPhRow}>
          <Icon name="play" size={11} color={colors.logoWhite} />
          <Text style={styles.videoPhText}>{post.views_count}</Text>
        </View>
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

const styles = StyleSheet.create({
  // ---- discover (redesigned) ----
  dcWord: { color: colors.accent, fontSize: 11.5, fontWeight: '800', letterSpacing: 3 },
  dcTitle: {
    color: colors.text,
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.5,
    lineHeight: 31,
    marginTop: 4,
  },
  dcBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.35)',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  dcBadgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  dcBadgeText: { color: colors.accent, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.3 },

  // search entry point
  dcSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.22)',
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginTop: 16,
    overflow: 'hidden',
    ...shadows.md,
  },
  dcSearchGlow: { position: 'absolute', top: -60, right: -50 },
  dcSearchText: { flex: 1, color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  dcSearchGo: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  dcCats: { gap: 8, paddingVertical: 16, paddingRight: 6 },

  // section spacing
  dcRow: { gap: 12, paddingTop: 14, paddingRight: 6 },

  // discovery grid — widths are passed in from the measured window, never
  // percentages, because percentages collapse inside a wrapping row on Android
  dcRowGroup: { gap: 10, marginTop: 14 },
  dcHalfRow: { flexDirection: 'row', gap: 10 },
  tile: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'flex-end',
  },
  tileOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 9,
    paddingVertical: 7,
    backgroundColor: 'rgba(4,8,18,0.62)',
  },
  tileLikes: { color: colors.logoWhite, fontSize: 10.5, fontWeight: '700' },
  tileTime: { color: colors.accent, fontSize: 10, fontWeight: '800' },

  // people
  person: {
    width: 146,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 13,
    alignItems: 'center',
    ...shadows.sm,
  },
  personNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 9 },
  personName: { color: colors.text, fontSize: 12.5, fontWeight: '800', marginTop: 9, maxWidth: 118 },
  personBio: {
    color: colors.textFaint,
    fontSize: 10.5,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 14,
    minHeight: 28,
  },
  personFollow: {
    marginTop: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  personFollowText: { color: colors.accent, fontSize: 11.5, fontWeight: '800' },

  // campus prompt
  dcPrompt: {
    marginTop: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(139,123,255,0.28)',
    backgroundColor: colors.surface,
    padding: 16,
    overflow: 'hidden',
  },
  dcPromptTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  dcPromptText: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 6 },

  // empty state
  dcEmpty: {
    marginTop: 20,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.25)',
    backgroundColor: colors.surface,
    padding: 26,
    alignItems: 'center',
    overflow: 'hidden',
    ...shadows.md,
  },
  dcEmptyGlow: { position: 'absolute', top: -70, right: -60 },
  dcEmptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 6 },
  dcEmptyText: {
    color: colors.textMuted,
    fontSize: 12.5,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
  },
  dcEmptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    paddingVertical: 12,
    marginTop: 18,
    overflow: 'hidden',
  },
  dcEmptyBtnText: { color: colors.bg, fontSize: 12.5, fontWeight: '900', letterSpacing: 1.1 },

  // focused search
  dcSearchOverlay: { flex: 1, paddingTop: TOP_INSET + 10, paddingHorizontal: 16 },
  dcSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  dcSearchInput: { flex: 1, color: colors.text, fontSize: 14.5, padding: 0 },
  dcCancel: { color: colors.accent, fontSize: 13, fontWeight: '800' },
  dcSearchIdle: { paddingTop: 18 },
  dcMiniLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 9,
    marginTop: 6,
  },
  dcChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  dcChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dcChipText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  dcSearchHint: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 14,
  },

  // trending card additions
  tlBadge: {
    position: 'absolute',
    top: 9,
    left: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(4,8,18,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.35)',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tlBadgeUrgent: { borderColor: 'rgba(255,92,124,0.5)' },
  tlText: { color: colors.accent, fontSize: 10, fontWeight: '800' },
  tlTextUrgent: { color: colors.danger },
  cardCaption: { color: colors.text, fontSize: 11.5, lineHeight: 15, marginTop: 5 },
  cardDot: { color: colors.textFaint, fontSize: 11, marginHorizontal: 3 },

  // drops
  dropLive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,92,124,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,92,124,0.45)',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  dropLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
  dropLiveText: { color: colors.danger, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  dropFoot: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  dropViewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    paddingVertical: 9,
  },
  dropViewText: { color: colors.bg, fontSize: 11.5, fontWeight: '900', letterSpacing: 1 },

  // just dropped
  freshCard: {
    width: 132,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    ...shadows.sm,
  },
  freshMedia: { width: '100%', height: 132, overflow: 'hidden' },
  freshNew: {
    position: 'absolute',
    top: 7,
    left: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  freshNewText: { color: colors.bg, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  freshUser: { color: colors.text, fontSize: 11.5, fontWeight: '800', paddingHorizontal: 10, marginTop: 9 },
  freshTime: { color: colors.accent, fontSize: 10, fontWeight: '800', marginBottom: 10, marginLeft: 2 },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  viewerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 60,
    backgroundColor: '#000',
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
    // horizontal padding was missing entirely, which is why every section and
    // card sat flush against the screen edges
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 40,
  },

  // persistent brand header — the GEN Z lockup, matching the other screens
  dcHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 16,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 12,
  },
  dcMark: { width: 30, height: 30, borderRadius: 9 },
  dcBrand: { flex: 1, color: colors.accent, fontSize: 15, fontWeight: '800', letterSpacing: 2.6 },
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
  videoPhRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  // this label sits on videoPh, which stays dark in both themes, so it must not
  // read colors.textMuted — that goes near-black in White mode and vanishes
  videoPhText: { color: colors.onMediaMuted, fontSize: 20, fontWeight: '800' },
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
  cardUserRow: { flexDirection: "row", alignItems: "center", marginTop: 3 },
  cardUser: {
    color: colors.logoWhite,
    fontSize: 11,
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
  creatorNameRow: { flexDirection: "row", alignItems: "center", marginTop: 6, justifyContent: "center" },
  creatorName: {
    color: colors.text,
    fontSize: 12,
    maxWidth: 84,
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
