import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useInsets } from '../../utils/useInsets';
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
};

const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const RSS_TOP = 'https://itunes.apple.com/us/rss/topsongs/limit=25/json';

const bigger = (u: string | null) => u?.replace('100x100bb', '300x300bb') ?? null;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

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

  const [tab, setTab] = useState<'trending' | 'search'>('trending');
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
  const durRef = useRef(0);
  const setTrimStartBoth = useCallback((v: number) => {
    trimStartRef.current = v;
    setTrimStart(v);
  }, []);
  const setTrimEndBoth = useCallback((v: number) => {
    trimEndRef.current = v;
    setTrimEnd(v);
  }, []);

  // preview duration once the player loads
  useEffect(() => {
    if (status.duration > 0) {
      durationRef.current = status.duration;
      if (!selected && durRef.current !== status.duration) {
        durRef.current = status.duration;
      }
    }
  }, [status.duration, selected]);

  // ---------- data ----------
  useEffect(() => {
    if (!visible) return;
    setErr(null);
    setLoading(true);
    (async () => {
      try {
        const rss = await fetch(RSS_TOP);
        const feed = await rss.json();
        const entries = feed?.feed?.entry ?? [];
        const ids = entries.map((e: any) => e['id']?.label).filter(Boolean);
        const mapped: Track[] = entries.map((e: any, i: number) => ({
          id: e['id']?.label ?? String(i),
          name: e['im:name']?.label ?? 'Unknown',
          artist: e['im:artist']?.label ?? '',
          url: null,
          artwork: bigger(e['im:image']?.[2]?.label ?? e['im:image']?.[1]?.label ?? null),
        }));
        setTrending(mapped);
        if (ids.length) {
          try {
            const lk = await fetch(`${ITUNES_LOOKUP}?id=${ids.join(',')}&entity=song`);
            const j = await lk.json();
            const byId = new Map<string, any>((j.results ?? []).map((r: any) => [String(r.trackId), r]));
            setTrending((prev) =>
              prev.map((t) => {
                const r = byId.get(t.id);
                return r ? { ...t, url: r.previewUrl ?? null, artwork: bigger(r.artworkUrl100 ?? null) } : t;
              })
            );
          } catch {
            // names still usable without previews
          }
        }
      } catch {
        setErr("Couldn't load trending songs. Check your connection.");
      } finally {
        setLoading(false);
      }
    })();
  }, [visible]);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setErr(null);
    try {
      const res = await fetch(`${ITUNES_SEARCH}?term=${encodeURIComponent(q.trim())}&entity=song&limit=50`);
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
    setTrimEndBoth(30);
  };

  // if reopening to re-trim, apply saved window after the preview loads
  const [initialApplied, setInitialApplied] = useState(false);
  const applyInitial = (t: Track) => {
    if (initial && initial.id === t.id && !initialApplied) {
      setTrimStartBoth(initial.start);
      setTrimEndBoth(initial.end > initial.start ? initial.end : 30);
      setInitialApplied(true);
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

  const mkHandle = (which: 'start' | 'end') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => {
        const w = barWRef.current;
        if (!w) return;
        const f = Math.min(1, Math.max(0, g.moveX / w));
        const dur = durationRef.current || 30;
        if (which === 'start') {
          const max = trimEndRef.current - 2;
          setTrimStartBoth(Math.min(max, Math.max(0, f * dur)));
        } else {
          const min = trimStartRef.current + 2;
          setTrimEndBoth(Math.max(min, Math.min(dur, f * dur)));
        }
      },
    });

  const startPan = useRef(mkHandle('start')).current;
  const endPan = useRef(mkHandle('end')).current;

  const useIt = () => {
    if (!selected) return;
    onSelect({
      id: selected.id,
      name: selected.name,
      artist: selected.artist || null,
      url: selected.url,
      start: Math.round(trimStartRef.current),
      end: Math.round(trimEndRef.current),
    });
    setSelected(null);
    setPlayingUrl(null);
    onClose();
  };

  const shown = tab === 'trending' ? trending : results;

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
                {(['trending', 'search'] as const).map((t) => (
                  <Pressable
                    key={t}
                    style={[styles.segmentBtn, tab === t && styles.segmentBtnActive]}
                    onPress={() => setTab(t)}
                  >
                    <Icon name={t === 'trending' ? 'flame' : 'search'} size={13} color={tab === t ? colors.bg : colors.textMuted} />
                    <Text style={[styles.segmentText, tab === t && styles.segmentTextActive]}>
                      {t === 'trending' ? 'Trending' : 'Search'}
                    </Text>
                  </Pressable>
                ))}
              </View>

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
                  {tab === 'trending' ? 'No trending songs right now.' : 'Search for an artist or song to find music.'}
                </Text>
              ) : (
                <View style={styles.list}>
                  {shown.map((t) => (
                    <Pressable
                      key={t.id}
                      style={styles.row}
                      onPress={() => {
                        openTrim(t);
                        applyInitial(t);
                      }}
                    >
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
                      <View style={styles.previewBadge}>
                        <Icon name="cut-outline" size={12} color={colors.accent} />
                        <Text style={styles.previewBadgeText}>Trim</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
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
                style={styles.trackWrap}
                onLayout={(e) => {
                  barWRef.current = e.nativeEvent.layout.width;
                }}
              >
                <View style={styles.track} />
                <View
                  style={[
                    styles.trackSel,
                    {
                      left: (trimStart / (durationRef.current || 30)) * barWRef.current,
                      width: ((trimEnd - trimStart) / (durationRef.current || 30)) * barWRef.current,
                    },
                  ]}
                />
                <View
                  style={[styles.trimHandle, { left: (trimStart / (durationRef.current || 30)) * barWRef.current - 10 }]}
                  {...startPan.panHandlers}
                >
                  <View style={styles.handleDot} />
                </View>
                <View
                  style={[styles.trimHandle, { left: (trimEnd / (durationRef.current || 30)) * barWRef.current - 10 }]}
                  {...endPan.panHandlers}
                >
                  <View style={styles.handleDot} />
                </View>
              </View>

              <View style={styles.trimLabels}>
                <Text style={styles.trimLabel}>{fmt(trimStart)}</Text>
                <Text style={styles.trimLabel}>{fmt(trimEnd)}</Text>
              </View>
              <Text style={styles.trimHint}>
                Drag the handles to choose where the sound plays. Duration: {fmt(Math.max(0, trimEnd - trimStart))}
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
