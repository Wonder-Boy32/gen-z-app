import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useInsets } from '../../utils/useInsets';
import { supabase } from '../../supabase/client';
import { colors, radius, shadows } from '../../theme';
import Icon from '../ui/Icon';

export type PickedSound = {
  id: string;
  name: string;
  artist: string | null;
  url: string | null;
  start: number; // seconds
  end: number; // seconds
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (s: PickedSound) => void;
  /** reopen in trim mode for this sound */
  initial?: PickedSound | null;
};

type Track = {
  id: string;
  name: string;
  artist: string;
  url: string | null;
  artwork: string | null;
  /** used to sort newest-first, so "latest" is literally the top of the list */
  releaseDate?: string | null;
  genre?: string | null;
  /** position in today's Nigerian list (1 = the sound to use) */
  rank?: number;
};

const ITUNES_SEARCH = 'https://itunes.apple.com/search';

// ------------------------------------------------------------
// Chart feed
//
// The feed itself has always been alive and current (it was returning same-day
// releases as far back as 2026-09-25). The problem was never freshness — it
// was WHICH charts were asked for and what happened to their order. See
// CHART_SOURCES below.
//
// Each entry also carries its preview audio inline at
// `link[].attributes.title === 'Preview'` — a 30s .m4a:
//
//   {"im:duration":{"label":"30000"},
//    "attributes":{"title":"Preview","rel":"enclosure","type":"audio/x-m4a",
//                  "href":"https://audio-ssl.itunes.apple.com/.../x.plus.aac.p.m4a"}}
//
// The previous version set `url: null` and then tried to recover previews from
// /lookup using `id.label` — a full https URL — as the id. That never matched,
// the failure was swallowed by an empty catch, every trending track ended up
// with url = null, and so `sound_url` was saved as null. FeedPost then saw
// `forceMute={!!post.sound_url}` === false and left the video's ORIGINAL audio
// playing. That is the "sound won't replace the original" bug.
// ------------------------------------------------------------
// NIGERIA ONLY.
//
// This used to ask six storefronts (us, gb, ng, za, fr, in) for 50 tracks each
// and then sort the 300-row pile by RELEASE DATE. Two things were wrong with
// that, and together they are why the trending list did not look like Nigeria:
//
//   * the chart position — the only real signal that a sound is being used —
//     was thrown away, so the newest import outranked the #1 record in Lagos;
//   * five of the six storefronts had nothing to do with this app.
//
// What ships instead: the Nigerian storefront, two charts, and the positions
// fused instead of discarded. A record inside Nigeria's top 50 today is what
// "actively used" means for this feed — these are the songs under the dance
// challenges here, not a copy of the US chart.
//
// Verified live on 2026-11-06 against /ng/rss/topsongs/limit=10/json: Asake &
// Wizkid #4, Tems, Fireboy DML, Greatman Takit & Nathaniel Bassey, FOLA — the
// storefront really does return the local scene. Still carries its 30s preview
// inline at `link[].attributes.title === 'Preview'`.
const STOREFRONT = 'ng';
const CHART_LIMIT = 50;

/**
 * Two Nigerian AUDIO charts, fused. Both were checked live on 2026-11-06 and
 * both return 30s `.m4a` previews inline:
 *
 *   topsongs              — the country chart (Asake, Tems, Fireboy, FOLA…)
 *   topsongs genre=1203   — "Top Songs in African", same storefront (Rema,
 *                           Davido, Wizkid, Darkoo, P-Square, Tems "Damages"…)
 *
 * The second one is the useful half for this feature: it is the local genre
 * chart, so the evergreen Afrobeats records that Nigerian creators actually
 * cut videos to are in it even when they are not in today's national top 10.
 *
 * `topmusicvideos` was tried and deliberately dropped: in the NG storefront it
 * still lists R. Kelly (2000) and Taylor Swift (2014) — an abandoned chart —
 * and its "Preview" is a `.m4v` VIDEO file, not audio. Feeding that to the
 * audio player would have downloaded a 1080p clip to play three seconds of
 * sound.
 *
 * Weights: the national chart leads, the genre chart boosts. A record on both
 * collects both contributions, which is exactly the "everyone is using this"
 * signal we cannot get from either chart alone.
 */
const CHART_SOURCES = [
  {
    key: 'ng',
    weight: 1,
    url: `https://itunes.apple.com/${STOREFRONT}/rss/topsongs/limit=${CHART_LIMIT}/json`,
  },
  {
    key: 'ng-african',
    weight: 0.85,
    url: `https://itunes.apple.com/${STOREFRONT}/rss/topsongs/limit=${CHART_LIMIT}/genre=1203/json`,
  },
] as const;

/**
 * Reciprocal-rank fusion: weight/rank from every chart a record appears on.
 *
 * #1 in the country chart = 1.0, so it leads. #1 in the genre chart = 0.85.
 * A record at #9 nationally and #6 in the genre chart scores 0.11 + 0.14 =
 * 0.25, which beats #5 on the genre chart alone (0.17) — being adopted in both
 * places is the thing being measured. Cheap, order-stable, and it never
 * invents a score for a record it did not see.
 */
const fuseScore = (hits: { rank: number; weight: number }[]) =>
  hits.reduce((sum, h) => sum + h.weight / h.rank, 0);

/**
 * What counts as "a Nigerian sound".
 *
 * The NG storefront chart is not purely local — today it carries a Thai drama
 * soundtrack and Adele — so "trending in Nigeria" alone lets global releases
 * onto a list that is meant to sound like Lagos. A record is kept when either:
 *
 *   - it is in the NG *African* chart (that chart is local by construction), or
 *   - its genre is one of the styles Nigerian creators actually cut videos to.
 *
 * Gospel/Christian are in the list on purpose: church music is one of the
 * biggest sound categories on Nigerian TikTok, and a record like "YOU ARE GOOD"
 * sits in the national top 10 without ever entering the genre chart.
 *
 * Compared lower-cased; Apple's own labels have mixed case across feeds.
 */
const LOCAL_GENRES = new Set(
  [
    'African',
    'Afrobeats',
    'Afro-Beat',
    'Afro-Pop',
    'Afro-fusion',
    'Afro-fusion',
    'Alté',
    'Alte',
    'Amapiano',
    'Gospel',
    'Christian',
    'R&B/Soul',
    'Hip-Hop/Rap',
    'Hip-Hop',
    'Rap',
    'Dancehall',
    'Reggae',
    'Worldwide',
    'World',
  ].map((g) => g.toLowerCase())
);

/** the chart key that proves a record is part of the local scene */
const LOCAL_CHART = 'ng-african';

/** the list is the same for every user, so one fetch per 10 minutes is enough */
const TREND_TTL_MS = 10 * 60 * 1000;
let trendCache: { at: number; tracks: Track[] } | null = null;

/** One shape for the raw RSS entry, so parsing is typed rather than `any`. */
type RssEntry = {
  'im:name'?: { label?: string };
  'im:artist'?: { label?: string };
  'im:image'?: { label?: string }[];
  'im:releaseDate'?: { label?: string };
  category?: { attributes?: { label?: string } };
  id?: { label?: string; attributes?: { 'im:id'?: string } };
  link?: { attributes?: { title?: string; href?: string } }[];
};

/** The 30s preview m4a, straight out of the feed — no second request needed. */
const previewUrlOf = (e: RssEntry): string | null =>
  e.link?.find((l) => l.attributes?.title === 'Preview')?.attributes?.href ?? null;

const bigger = (u: string | null) => u?.replace('100x100bb', '300x300bb') ?? null;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/** the same clock, with tenths — a trim point is worth being exact about */
const fmtPrecise = (s: number) => {
  const safe = Math.max(0, s);
  const m = Math.floor(safe / 60);
  const sec = safe % 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};

/** shortest window the handles will allow, in seconds */
const MIN_WINDOW = 0.5;

export default function SoundPickerModal({ visible, onClose, onSelect, initial }: Props) {
  const insets = useInsets();

  // Android: this Modal is its own window and does NOT resize for the IME, so the
  // sheet has to be lifted by the reported keyboard height itself. There was no
  // keyboard handling here at all, which is why the keypad simply covered the
  // search field. Exactly one mechanism per platform — iOS is left as it was.
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKbHeight(e?.endCoordinates?.height ?? 0)
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // with the IME open the nav bar sits behind it, so the full reported height is
  // the distance the sheet has to clear
  const padBottom = Platform.OS === 'android' && kbHeight > 0 ? kbHeight : 16 + insets.bottom;

  const [tab, setTab] = useState<'trending' | 'favorites' | 'search'>('trending');
  const [query, setQuery] = useState('');
  const [trending, setTrending] = useState<Track[]>([]);
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Track | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(30);

  const player = useAudioPlayer(playingUrl ?? null);
  const status = useAudioPlayerStatus(player);

  // refs so pan responders always read the latest values
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(30);
  const durationRef = useRef(30);
  const barWRef = useRef(0);
  // Where the trim bar starts on SCREEN, not inside its parent.
  //
  // The pan used to divide the finger's page X by the bar width, which silently
  // assumed the bar began at x=0. It does not — the sheet has 18px of padding —
  // so every trim point was shifted right by that margin, and the first ~1.5
  // seconds of a track could not be selected at all. That is the "I can't put
  // it exactly where I want" half of the bug.
  const barXRef = useRef(0);
  const trackRef = useRef<View | null>(null);
  const durRef = useRef(0);
  const setTrimStartBoth = useCallback((v: number) => {
    trimStartRef.current = v;
    setTrimStart(v);
  }, []);
  const setTrimEndBoth = useCallback((v: number) => {
    trimEndRef.current = v;
    setTrimEnd(v);
  }, []);

  // The track's real length, once the preview has measured it.
  //
  // Everything below used to assume 30s. A window that reaches past the real
  // end is not a cosmetic problem: the preview stops at the file end, and the
  // saved `sound_end` pointed past the audio, so on a post the loop could
  // never fire and the sound went silent while the video kept playing. Measure
  // once, then clamp what is already on screen to what actually exists.
  const [trackDur, setTrackDur] = useState(0);
  // true once the window came from somewhere other than this modal's default —
  // a saved re-trim, or the user dragging a handle.
  const touchedRef = useRef(false);

  useEffect(() => {
    const d = status.duration;
    if (!(d > 0)) return;
    durationRef.current = d;
    setTrackDur(d);
    if (!touchedRef.current) {
      // a fresh pick: the default window is the whole track
      setTrimStartBoth(0);
      setTrimEndBoth(d);
      return;
    }
    // an existing window: keep it, but not past the end of this file
    if (trimEndRef.current > d - 0.05) setTrimEndBoth(d);
    if (trimStartRef.current > Math.max(0, d - 0.5)) {
      setTrimStartBoth(Math.max(0, d - 0.5));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.duration]);

  // ---------- data ----------
  const loadTrending = useCallback(async (force = false) => {
    if (!force && trendCache && Date.now() - trendCache.at < TREND_TTL_MS) {
      setTrending(trendCache.tracks);
      setErr(null);
      setLoading(false);
      return;
    }
    setErr(null);
    setLoading(true);
    try {
      // allSettled, not all: one dead chart must not blank the list.
      const settled = await Promise.allSettled(
        CHART_SOURCES.map(async (src) => {
          const res = await fetch(src.url);
          const j = await res.json();
          const entries = (j?.feed?.entry ?? []) as RssEntry[];
          // The array order IS the chart position. It used to be indexed only
          // so entries had some id; now the number is the point.
          return entries.map((e, i) => ({
            e,
            rank: i + 1,
            weight: src.weight,
            chart: src.key,
          }));
        })
      );

      // Keep the chart POSITION, not just the track. A record that appears on
      // both charts collects both ranks.
      type Hit = { chart: string; rank: number; weight: number };
      const byId = new Map<string, { hits: Hit[]; track: Track }>();

      for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        for (const { e, rank, weight, chart } of r.value) {
          const url = previewUrlOf(e);
          // A track with no preview cannot be a sound. Dropping it here is the
          // guard against the original bug: it used to be selectable, saved
          // sound_url = null, and the post silently kept its own audio.
          if (!url) continue;

          const id = e.id?.attributes?.['im:id'] ?? e.id?.label ?? `${rank}-${url}`;
          const already = byId.get(id);
          if (already) {
            already.hits.push({ chart, rank, weight });
            continue;
          }
          byId.set(id, {
            hits: [{ chart, rank, weight }],
            track: {
              id,
              name: e['im:name']?.label ?? 'Unknown',
              artist: e['im:artist']?.label ?? '',
              // The preview comes straight out of the feed. No lookup request.
              url,
              artwork: bigger(e['im:image']?.[2]?.label ?? e['im:image']?.[1]?.label ?? null),
              releaseDate: e['im:releaseDate']?.label ?? null,
              genre: e.category?.attributes?.label ?? null,
            },
          });
        }
      }

      const ranked: Track[] = [...byId.values()]
        // Local only: proven by the African chart, or by a genre Nigerian
        // creators actually use. See LOCAL_GENRES for why imports are dropped.
        .filter(
          (v) =>
            v.hits.some((h) => h.chart === LOCAL_CHART) ||
            LOCAL_GENRES.has((v.track.genre ?? '').trim().toLowerCase())
        )
        .map((v) => ({ t: v.track, score: fuseScore(v.hits) }))
        // highest score first; ties broken by title so the order never flickers
        .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
        .map(({ t }, i) => ({ ...t, rank: i + 1 }));

      trendCache = { at: Date.now(), tracks: ranked };
      setTrending(ranked);
      if (ranked.length === 0) {
        setErr("Couldn't load trending songs. Check your connection.");
      }
    } catch {
      setErr("Couldn't load trending songs. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void loadTrending();
  }, [visible, loadTrending]);

  // ---------- favourites ----------
  const [favs, setFavs] = useState<Record<string, Track>>({});

  useEffect(() => {
    if (!visible) return;
    (async () => {
      const { data } = await supabase
        .from('sound_favorites')
        .select('sound_id, name, artist, artwork, url')
        .order('created_at', { ascending: false });

      const map: Record<string, Track> = {};
      for (const r of (data ?? []) as {
        sound_id: string;
        name: string;
        artist: string | null;
        artwork: string | null;
        url: string | null;
      }[]) {
        map[r.sound_id] = {
          id: r.sound_id,
          name: r.name,
          artist: r.artist ?? '',
          artwork: r.artwork,
          url: r.url,
        };
      }
      setFavs(map);
    })();
  }, [visible]);

  const toggleFav = useCallback(async (t: Track) => {
    const existing = favs[t.id];

    // Optimistic: the heart must respond instantly, network is secondary.
    setFavs((prev) => {
      const next = { ...prev };
      if (existing) delete next[t.id];
      else next[t.id] = t;
      return next;
    });

    if (existing) {
      await supabase.from('sound_favorites').delete().eq('sound_id', t.id);
      return;
    }

    const { data: u } = await supabase.auth.getUser();
    const uid = u.user?.id;
    if (!uid) return;

    await supabase.from('sound_favorites').insert({
      user_id: uid,
      sound_id: t.id,
      name: t.name,
      artist: t.artist || null,
      artwork: t.artwork,
      url: t.url,
    });
  }, [favs]);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setErr(null);
    try {
      // country=ng, because without it the search runs against the US
      // storefront: searching "Asake" returned US results and left the local
      // catalogue out entirely.
      const res = await fetch(
        `${ITUNES_SEARCH}?term=${encodeURIComponent(q.trim())}&entity=song&limit=50&country=${STOREFRONT}`
      );
      const j = await res.json();
      setResults(
        ((j.results ?? []) as any[]).map((r) => ({
          id: String(r.trackId),
          name: r.trackName ?? 'Unknown',
          artist: r.artistName ?? '',
          url: r.previewUrl ?? null,
          artwork: bigger(r.artworkUrl100 ?? null),
        }))
      );
    } catch {
      setErr('Search failed — try again.');
    } finally {
      setSearching(false);
    }
  };

  // ---------- trim ----------
  const openTrim = (t: Track) => {
    setSelected(t);
    setPlayingUrl(t.url);
    setTrimStartBoth(0);
    // 0 = "the whole track", resolved to the measured length a moment later.
    // Defaulting to a hard 30s cut the tail off every longer song.
    setTrimEndBoth(0);
    touchedRef.current = false;
  };

  // if reopening to re-trim, apply saved window after the preview loads
  const [initialApplied, setInitialApplied] = useState(false);
  const applyInitial = (t: Track) => {
    if (initial && initial.id === t.id && !initialApplied) {
      setTrimStartBoth(initial.start);
      setTrimEndBoth(initial.end > initial.start ? initial.end : 0);
      setInitialApplied(true);
      // the window came from the user's earlier trim — do not replace it with
      // the full track when the duration arrives
      touchedRef.current = true;
    }
  };

  useEffect(() => {
    if (!visible) {
      setPlayingUrl(null);
      setSelected(null);
      setInitialApplied(false);
    }
  }, [visible]);

  // pause preview at the trim end
  useEffect(() => {
    if (!status.playing || !selected) return;
    const t = status.currentTime;
    if (trimEnd > 0 && t >= trimEnd - 0.15) {
      player.pause();
      player.seekTo(trimStart);
    }
  }, [status.currentTime, status.playing, trimEnd, trimStart, selected, player]);

  const playTrim = () => {
    if (!selected?.url) return;
    if (status.playing) {
      player.pause();
    } else {
      player.seekTo(trimStart);
      player.play();
    }
  };

  // Audition the window you just set, from its start. Dragging used to be
  // silent, so "pick the exact moment" meant guess-and-close.
  const audition = () => {
    if (!selected?.url) return;
    player.seekTo(trimStartRef.current);
    player.play();
  };

  const mkHandle = (which: 'start' | 'end') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => {
        const w = barWRef.current;
        if (!w) return;
        touchedRef.current = true;
        // page X minus the bar's own page X — the finger is ON the bar
        const f = Math.min(1, Math.max(0, (g.moveX - barXRef.current) / w));
        const dur = durationRef.current || 30;
        // tenth-of-a-second snapping. Whole seconds were all this could
        // express before, so the exact beat you wanted was often one press
        // away on either side of where it saved.
        const at = Math.round(f * dur * 10) / 10;
        if (which === 'start') {
          const end = trimEndRef.current || dur;
          const max = Math.max(0, end - MIN_WINDOW);
          setTrimStartBoth(Math.min(max, Math.max(0, at)));
        } else {
          const min = trimStartRef.current + MIN_WINDOW;
          setTrimEndBoth(Math.max(min, Math.min(dur, at)));
        }
      },
      // Let go and hear it: the window you just framed plays from its start,
      // and stops itself at its end (the effect above), so the cue is confirmed
      // by ear instead of by arithmetic.
      onPanResponderRelease: () => audition(),
      onPanResponderTerminate: () => audition(),
    });

  const startPan = useRef(mkHandle('start')).current;
  const endPan = useRef(mkHandle('end')).current;

  const useIt = () => {
    if (!selected) return;
    const dur = durationRef.current || trimEndRef.current || 30;
    const end = trimEndRef.current > 0 ? Math.min(trimEndRef.current, dur) : dur;
    onSelect({
      id: selected.id,
      name: selected.name,
      artist: selected.artist || null,
      url: selected.url,
      // tenths, not whole seconds — this value is what the post loops on
      start: Math.round(Math.max(0, Math.min(trimStartRef.current, end - MIN_WINDOW)) * 10) / 10,
      end: Math.round(end * 10) / 10,
    });
    setSelected(null);
    setPlayingUrl(null);
    onClose();
  };

  // The window shown and saved. `trimEnd` is 0 until the file has been
  // measured (or when the user has not touched a handle yet), meaning "the
  // whole track" — not a 30s guess that cuts the tail off longer songs.
  const effEnd = trimEnd > 0 ? trimEnd : trackDur || 30;
  const durDen = durationRef.current || trackDur || 30;

  const shown =
    tab === 'trending' ? trending : tab === 'favorites' ? Object.values(favs) : results;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: padBottom }]}>
          <View style={styles.handle} />

          {!selected ? (
            <>
              <View style={styles.headerRow}>
                <View style={styles.titleRow}>
                  <Icon name="musical-notes" size={18} color={colors.cyan} />
                  <Text style={styles.title}>Add a Sound</Text>
                </View>
                <Pressable onPress={onClose} hitSlop={8}>
                  <Text style={styles.closeX}>✕</Text>
                </Pressable>
              </View>

              <View style={styles.segment}>
                {(['trending', 'favorites', 'search'] as const).map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.segmentBtn, tab === t && styles.segmentBtnActive]}
                    onPress={() => setTab(t)}
                  >
                    <Icon
                      name={t === 'trending' ? 'flame' : t === 'favorites' ? 'heart' : 'search'}
                      size={13}
                      color={tab === t ? colors.bg : colors.textMuted}
                    />
                    <Text style={[styles.segmentText, tab === t && styles.segmentTextActive]}>
                      {t === 'trending' ? 'Trending' : t === 'favorites' ? 'Saved' : 'Search'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {tab === 'trending' && (
                <View style={styles.trendHead}>
                  <View style={styles.trendHeadLeft}>
                    <Icon name="location" size={12} color={colors.accent} />
                    <Text style={styles.trendHeadText}>Trending in Nigeria</Text>
                    {trending.length > 0 && (
                      <Text style={styles.trendHeadSub}>· top {trending.length}</Text>
                    )}
                  </View>
                  <Pressable
                    onPress={() => void loadTrending(true)}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh trending sounds"
                  >
                    <Icon name="refresh" size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              )}

              {tab === 'search' && (
                <View style={styles.searchRow}>
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Artist or song name…"
                    placeholderTextColor={colors.textFaint}
                    value={query}
                    onChangeText={setQuery}
                    onSubmitEditing={() => search(query)}
                    returnKeyType="search"
                    autoCapitalize="none"
                  />
                  <Pressable style={styles.searchBtn} onPress={() => search(query)} disabled={searching}>
                    {searching ? <ActivityIndicator size="small" color={colors.bg} /> : <Icon name="search" size={16} color={colors.bg} />}
                  </Pressable>
                </View>
              )}

              {!!err && <Text style={styles.err}>{err}</Text>}

              {loading || searching ? (
                <ActivityIndicator color={colors.accent} style={styles.loader} />
              ) : shown.length === 0 ? (
                <Text style={styles.empty}>
                  {tab === 'trending'
                    ? 'No trending songs right now.'
                    : tab === 'favorites'
                      ? 'No saved sounds yet. Tap the heart on any sound to keep it here.'
                      : 'Search for an artist or song to find music.'}
                </Text>
              ) : (
                // ScrollView, not View. This was a plain View inside a sheet
                // capped at maxHeight 88%, so the list CLIPPED and could not be
                // scrolled at all — "i cant scroll through to check other
                // sounds". flexShrink lets it take the leftover height and
                // scroll inside it.
                <ScrollView
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator
                >
                  {shown.map((t) => (
                    <Pressable
                      key={t.id}
                      style={styles.row}
                      onPress={() => {
                        openTrim(t);
                        applyInitial(t);
                      }}
                    >
                      {tab === 'trending' && t.rank ? (
                        <Text style={styles.rowRank}>{t.rank}</Text>
                      ) : null}
                      {t.artwork ? (
                        <Image source={{ uri: t.artwork }} style={styles.artwork} />
                      ) : (
                        <View style={[styles.artwork, styles.artworkPh]}>
                          <Icon name="musical-note" size={16} color={colors.cyan} />
                        </View>
                      )}
                      <View style={styles.rowBody}>
                        <Text style={styles.songName} numberOfLines={1}>
                          {t.name}
                        </Text>
                        <Text style={styles.songArtist} numberOfLines={1}>
                          {t.artist}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => void toggleFav(t)}
                        hitSlop={10}
                        style={styles.favBtn}
                        accessibilityRole="button"
                        accessibilityLabel={
                          favs[t.id]
                            ? `Remove ${t.name} from saved sounds`
                            : `Save ${t.name} to saved sounds`
                        }
                      >
                        <Icon
                          name={favs[t.id] ? 'heart' : 'heart-outline'}
                          size={17}
                          color={favs[t.id] ? colors.accent : colors.textFaint}
                        />
                      </Pressable>

                      <View style={styles.previewBadge}>
                        <Icon name="cut-outline" size={12} color={colors.accent} />
                        <Text style={styles.previewBadgeText}>Trim</Text>
                      </View>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </>
          ) : (
            <>
              <View style={styles.headerRow}>
                <Pressable onPress={() => setSelected(null)} hitSlop={8} style={styles.backBtn}>
                  <Icon name="chevron-back" size={20} color={colors.text} />
                </Pressable>
                <Text style={styles.title} numberOfLines={1}>
                  {selected.name}
                </Text>
                <View style={{ width: 28 }} />
              </View>
              <Text style={styles.subTitle}>{selected.artist}</Text>

              {selected.artwork ? (
                <Image source={{ uri: selected.artwork }} style={styles.artworkBig} />
              ) : (
                <View style={[styles.artworkBig, styles.artworkPh]}>
                  <Icon name="musical-note" size={34} color={colors.cyan} />
                </View>
              )}

              <Pressable style={styles.playBtn} onPress={playTrim} disabled={!selected.url}>
                <Icon name={status.playing ? 'pause' : 'play'} size={22} color={colors.bg} />
                <Text style={styles.playBtnText}>{status.playing ? 'Pause preview' : 'Preview'}</Text>
              </Pressable>

              <View
                ref={trackRef}
                style={styles.trackWrap}
                onLayout={(e) => {
                  barWRef.current = e.nativeEvent.layout.width;
                  // measureInWindow, not layout.x: layout.x is relative to the
                  // parent, and the pan needs page coordinates.
                  trackRef.current?.measureInWindow?.((x, _y, w) => {
                    if (typeof x === 'number') barXRef.current = x;
                    if (typeof w === 'number' && w > 0) barWRef.current = w;
                  });
                }}
              >
                <View style={styles.track} />
                <View
                  style={[
                    styles.trackSel,
                    {
                      left: (trimStart / durDen) * barWRef.current,
                      width: (Math.max(0, effEnd - trimStart) / durDen) * barWRef.current,
                    },
                  ]}
                />
                <View
                  style={[styles.trimHandle, { left: (trimStart / durDen) * barWRef.current - 10 }]}
                  {...startPan.panHandlers}
                >
                  <View style={styles.handleDot} />
                </View>
                <View
                  style={[styles.trimHandle, { left: (effEnd / durDen) * barWRef.current - 10 }]}
                  {...endPan.panHandlers}
                >
                  <View style={styles.handleDot} />
                </View>
              </View>

              <View style={styles.trimLabels}>
                <Text style={styles.trimLabel}>starts {fmtPrecise(trimStart)}</Text>
                <Text style={styles.trimLabel}>ends {fmtPrecise(effEnd)}</Text>
              </View>
              <Text style={styles.trimHint}>
                Drag the handles to pick the exact moment. This window plays for{' '}
                {fmtPrecise(Math.max(0, effEnd - trimStart))}
                {trackDur > 0 ? ` of ${fmt(trackDur)}` : ''}, then loops for as long as your video runs.
              </Text>

              <Pressable style={styles.useBtn} onPress={useIt}>
                <Icon name="checkmark" size={18} color={colors.bg} />
                <Text style={styles.useBtnText}>Use this sound</Text>
              </Pressable>
            </>
          )}
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
    maxHeight: '88%',
    ...shadows.glow,
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
    marginBottom: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  subTitle: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginBottom: 12 },
  closeX: { color: colors.textMuted, fontSize: 16, fontWeight: '800' },
  backBtn: { width: 28 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: 12,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  segmentBtnActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: colors.bg },
  searchRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  searchInput: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  searchBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  err: { color: colors.danger, fontSize: 12, marginBottom: 8, textAlign: 'center' },
  loader: { paddingVertical: 36 },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 32 },
  // flexShrink so the results give way to the lifted sheet instead of pushing the
  // composer off screen on a short device
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { paddingBottom: 6 },
  favBtn: { paddingHorizontal: 2, paddingVertical: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  artwork: { width: 42, height: 42, borderRadius: 8, backgroundColor: '#0A1220' },
  artworkPh: { alignItems: 'center', justifyContent: 'center' },
  artworkBig: {
    width: 150,
    height: 150,
    borderRadius: radius.lg,
    alignSelf: 'center',
    backgroundColor: '#0A1220',
    marginBottom: 14,
  },
  // "Trending in Nigeria" strip: says which country the list is from, and that
  // it is a chart, so a #1 is believable rather than a lucky sort order.
  trendHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: -2,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  trendHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  trendHeadText: { color: colors.text, fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  trendHeadSub: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  rowRank: {
    width: 18,
    textAlign: 'center',
    color: colors.textFaint,
    fontSize: 13,
    fontWeight: '800',
  },
  rowBody: { flex: 1 },
  songName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  songArtist: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  previewBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  previewBadgeText: { color: colors.accent, fontSize: 10, fontWeight: '800' },
  playBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 12,
    marginBottom: 16,
  },
  playBtnText: { color: colors.bg, fontSize: 14, fontWeight: '800' },
  trackWrap: { height: 44, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  trackSel: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  trimHandle: {
    position: 'absolute',
    width: 20,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.logoWhite,
  },
  trimLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  trimLabel: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  trimHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 10 },
  useBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 14,
    marginTop: 14,
  },
  useBtnText: { color: colors.bg, fontSize: 15, fontWeight: '800' },
});
