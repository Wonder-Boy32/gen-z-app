// ============================================================
// SHARED SPACE (§16)
//
// Everything two people have ever exchanged, organised so nobody
// has to scroll through thousands of messages to find a photo.
//
// One screen, eight sections, one fetch strategy.
//
// ── DATA SOURCE NOTE (important) ─────────────────────────────
// The app still stores media in the LEGACY `messages.media_url`
// text column, so every section here matches on `msg_type`
// (values used by this screen: 'image', 'gif', 'video', 'voice',
// 'file', 'audio', 'location', 'text'). `contact` also exists as
// a kind but has no section of its own.
//
// `message_attachments` (supabase/messaging_v2.sql, STEP 5) is the
// intended home for media metadata — mime_type, byte_size,
// duration_ms, wave_peaks, thumb_path, blurhash — and it even
// ships a purpose-built index (`attachments_shared_space_idx`).
// It is NOT populated yet, so querying it today would return an
// empty screen. When the upload path starts writing rows there,
// the grid/list queries below should move onto it (and pick up
// real thumbnails + durations for free).
// ─────────────────────────────────────────────────────────────
//
// Pagination is KEYSET on `seq` descending (never `.range()`),
// which is the only shape that stays fast with the
// `messages_timeline_idx` (conversation_id, seq desc) index.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius, spacing, type } from '../../theme';
import { supabase } from '../../supabase/client';
import { TOP_INSET } from '../../utils/useInsets';
import { dayLabel, fmtBytes, fmtDuration, fmtTime } from './chatVisuals';
import { friendlyError } from '../../utils/friendlyError';

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

/** Keyset page size (rows per request, newest first). */
const PAGE_SIZE = 60;
/** Saves are a curated, small list — one bounded read, no keyset walk. */
const SAVED_LIMIT = 100;
/** How many pages we may auto-walk while a section is still empty (Links). */
const MAX_AUTO_PAGES = 8;
const GRID_COLUMNS = 3;
/** 2px gutters keep the grid tight, per the design system. */
const GRID_GAP = 2;

/** Matches a bare http(s) URL inside message text. No /g flag: `exec`/`test` stay stateless. */
const URL_RE = /https?:\/\/[^\s<>()"']+/i;

/**
 * Columns the screen needs. `metadata` arrives in
 * supabase/messaging_v2.sql (STEP 2) and carries the optional
 * durationMs / byteSize / fileName that make the row subtitles
 * rich. Deployments older than that migration fall back to
 * LEGACY_COLUMNS instead of showing an empty screen.
 */
const PRIMARY_COLUMNS =
  'id, conversation_id, sender_id, msg_type, content, media_url, metadata, created_at, seq';
const LEGACY_COLUMNS = 'id, conversation_id, sender_id, msg_type, content, media_url, created_at, seq';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

type SectionKey = 'photos' | 'videos' | 'voice' | 'files' | 'links' | 'locations' | 'saved' | 'audio';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: IoniconName;
  /** Used for the empty state: "No <noun> in this conversation yet." */
  noun: string;
  layout: 'grid' | 'list';
  /**
   * `msg_type` values matched server-side. Always an array so the
   * query chain never needs a conditional filter (one shape, one
   * index path). Empty for `saved`, which reads `saved_messages`.
   */
  msgTypes: string[];
}

const SECTIONS: SectionDef[] = [
  { key: 'photos', label: 'Photos', icon: 'images', noun: 'photos', layout: 'grid', msgTypes: ['image', 'gif'] },
  { key: 'videos', label: 'Videos', icon: 'videocam', noun: 'videos', layout: 'grid', msgTypes: ['video'] },
  { key: 'voice', label: 'Voice', icon: 'mic', noun: 'voice notes', layout: 'list', msgTypes: ['voice'] },
  { key: 'files', label: 'Files', icon: 'document-text', noun: 'files', layout: 'list', msgTypes: ['file'] },
  // Links are TEXT rows whose content contains a URL — the URL test is
  // applied client-side (see buildItems), so the server side is just 'text'.
  { key: 'links', label: 'Links', icon: 'link', noun: 'links', layout: 'list', msgTypes: ['text'] },
  { key: 'locations', label: 'Locations', icon: 'location', noun: 'locations', layout: 'list', msgTypes: ['location'] },
  // unused: the Saved section reads public.saved_messages (see fetchSavedRows)
  { key: 'saved', label: 'Saved', icon: 'bookmark', noun: 'saved messages', layout: 'list', msgTypes: [] },
  { key: 'audio', label: 'Audio', icon: 'musical-notes', noun: 'audio files', layout: 'grid', msgTypes: ['audio'] },
];

const SECTION_BY_KEY = SECTIONS.reduce<Record<string, SectionDef>>((acc, def) => {
  acc[def.key] = def;
  return acc;
}, {});

const MSG_TYPE_LABEL: Record<string, string> = {
  text: 'Message',
  image: 'Photo',
  gif: 'GIF',
  video: 'Video',
  voice: 'Voice note',
  file: 'File',
  audio: 'Audio',
  location: 'Location',
  contact: 'Contact',
};

const MSG_TYPE_ICON: Record<string, IoniconName> = {
  text: 'chatbubble-ellipses-outline',
  image: 'image-outline',
  gif: 'image-outline',
  video: 'videocam-outline',
  voice: 'mic-outline',
  file: 'document-text-outline',
  audio: 'musical-notes-outline',
  location: 'location-outline',
  contact: 'person-outline',
};

// ------------------------------------------------------------
// Row shape + narrowing (untyped Supabase client ⇒ everything is
// `unknown` until we prove otherwise — no bare `any` anywhere).
// ------------------------------------------------------------

interface SharedRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  msg_type: string | null;
  content: string | null;
  media_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  seq: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toSharedRow(raw: unknown): SharedRow | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const createdAt = asString(raw.created_at);
  return {
    id,
    conversation_id: asString(raw.conversation_id) ?? '',
    sender_id: asString(raw.sender_id),
    msg_type: asString(raw.msg_type),
    content: asString(raw.content),
    media_url: asString(raw.media_url),
    metadata: isRecord(raw.metadata) ? raw.metadata : null,
    created_at: createdAt ?? new Date(0).toISOString(),
    seq: typeof raw.seq === 'number' ? raw.seq : null,
  };
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  if (!meta) return null;
  const value = meta[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function metaText(meta: Record<string, unknown> | null, key: string): string | null {
  if (!meta) return null;
  const value = meta[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Legacy rows sometimes carry the URL in `content` instead of `media_url`. */
function rowMediaUri(row: SharedRow): string | null {
  if (row.media_url && URL_RE.test(row.media_url)) return row.media_url;
  if (row.content && URL_RE.test(row.content)) return row.content;
  return null;
}

function domainOf(url: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].replace(/^www\./i, '') : url;
}

// ------------------------------------------------------------
// Render item
// ------------------------------------------------------------

interface SharedItem {
  row: SharedRow;
  key: string;
  title: string;
  subtitle: string;
  /** "Today · 4:31 PM" — shown in list rows and used in a11y labels. */
  caption: string;
  icon: IoniconName;
  /** Full-screen URI; null for rows that have no playable/visible media. */
  uri: string | null;
}

function buildItems(sectionKey: SectionKey, rows: SharedRow[], savedRows: SharedRow[]): SharedItem[] {
  const def = SECTION_BY_KEY[sectionKey];
  const source = def.key === 'saved' ? savedRows : rows;
  const items: SharedItem[] = [];

  for (const row of source) {
    const msgType = (row.msg_type ?? '').toLowerCase();
    if (def.msgTypes.length > 0 && !def.msgTypes.includes(msgType)) continue;

    const caption = `${dayLabel(row.created_at)} · ${fmtTime(row.created_at)}`;
    const uri = rowMediaUri(row);
    const text = (row.content ?? '').trim();

    if (def.key === 'links') {
      const match = URL_RE.exec(row.content ?? '');
      if (!match) continue;
      const url = match[0];
      const remainder = (row.content ?? '').replace(url, '').trim();
      items.push({
        row,
        key: row.id,
        title: domainOf(url),
        subtitle: remainder.length > 0 ? remainder : url,
        caption,
        icon: 'link',
        uri,
      });
      continue;
    }

    if (def.key === 'photos') {
      items.push({
        row,
        key: row.id,
        title: msgType === 'gif' ? 'GIF' : 'Photo',
        subtitle: caption,
        caption,
        icon: 'image-outline',
        uri,
      });
      continue;
    }

    if (def.key === 'videos') {
      const duration = metaNumber(row.metadata, 'durationMs');
      items.push({
        row,
        key: row.id,
        title: 'Video',
        subtitle: duration !== null ? fmtDuration(duration) : caption,
        caption,
        icon: 'videocam-outline',
        uri,
      });
      continue;
    }

    if (def.key === 'audio') {
      const duration = metaNumber(row.metadata, 'durationMs');
      const fileName = metaText(row.metadata, 'fileName');
      items.push({
        row,
        key: row.id,
        title: fileName ?? 'Audio',
        subtitle: duration !== null ? fmtDuration(duration) : caption,
        caption,
        icon: 'musical-notes-outline',
        uri,
      });
      continue;
    }

    if (def.key === 'voice') {
      const duration = metaNumber(row.metadata, 'durationMs');
      items.push({
        row,
        key: row.id,
        title: 'Voice note',
        subtitle: duration !== null ? `${fmtDuration(duration)} · voice message` : 'Voice message',
        caption,
        icon: 'mic-outline',
        uri,
      });
      continue;
    }

    if (def.key === 'files') {
      const fileName = metaText(row.metadata, 'fileName');
      const bytes = metaNumber(row.metadata, 'byteSize');
      items.push({
        row,
        key: row.id,
        title: fileName ?? text ?? 'File',
        subtitle: bytes !== null ? fmtBytes(bytes) : 'File',
        caption,
        icon: 'document-text-outline',
        uri,
      });
      continue;
    }

    if (def.key === 'locations') {
      items.push({
        row,
        key: row.id,
        title: 'Location',
        subtitle: text.length > 0 ? text : 'Shared location',
        caption,
        icon: 'location-outline',
        uri,
      });
      continue;
    }

    // Saved: any kind of message the user bookmarked.
    items.push({
      row,
      key: row.id,
      title: MSG_TYPE_LABEL[msgType] ?? 'Message',
      subtitle: text.length > 0 ? text : (uri ? 'Media' : MSG_TYPE_LABEL[msgType] ?? 'Message'),
      caption,
      icon: MSG_TYPE_ICON[msgType] ?? 'chatbubble-ellipses-outline',
      uri,
    });
  }

  return items;
}

// ------------------------------------------------------------
// Fetchers (module scope — pure I/O, no component state)
// ------------------------------------------------------------

interface PageResult {
  rows: SharedRow[];
  hasMore: boolean;
  error: string | null;
}

/**
 * One keyset page of `messages` for the given section.
 * Newest → oldest, `seq` descending, `lt('seq', beforeSeq)` for the
 * next page — never `.range()`.
 */
async function fetchMessagePage(params: {
  conversationId: string;
  def: SectionDef;
  beforeSeq: number | null;
  withMetadata: boolean;
}): Promise<PageResult> {
  const { conversationId, def, beforeSeq, withMetadata } = params;

  let query = supabase
    .from('messages')
    .select(withMetadata ? PRIMARY_COLUMNS : LEGACY_COLUMNS)
    .eq('conversation_id', conversationId)
    .in('msg_type', def.msgTypes);

  if (beforeSeq !== null) {
    query = query.lt('seq', beforeSeq);
  }

  const { data, error } = await query.order('seq', { ascending: false }).limit(PAGE_SIZE + 1);

  if (error) return { rows: [], hasMore: false, error: error.message };

  const list: unknown = data;
  const parsed = Array.isArray(list)
    ? list.map(toSharedRow).filter((row): row is SharedRow => row !== null)
    : [];

  const hasMore = parsed.length > PAGE_SIZE;
  return { rows: hasMore ? parsed.slice(0, PAGE_SIZE) : parsed, hasMore, error: null };
}

/**
 * The Saved section: `saved_messages` for the CURRENT user, joined to
 * its message. Saves are private to the saver (RLS: saves_select_own),
 * so this is one bounded read rather than a keyset walk.
 * Empty is a perfectly normal state — the caller renders an empty
 * state, never an error.
 */
async function fetchSavedRows(
  conversationId: string
): Promise<{ rows: SharedRow[]; error: string | null }> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  if (!userId) return { rows: [], error: null };

  const { data, error } = await supabase
    .from('saved_messages')
    .select(`created_at, message:messages(${PRIMARY_COLUMNS})`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(SAVED_LIMIT);

  if (error) return { rows: [], error: error.message };

  const list: unknown = data;
  if (!Array.isArray(list)) return { rows: [], error: null };

  const rows: SharedRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    // A to-one embed normally arrives as an object; tolerate an array.
    const embedded = entry.message;
    const candidate = Array.isArray(embedded) ? embedded[0] : embedded;
    const row = toSharedRow(candidate);
    // The conversation filter is applied here because `saved_messages`
    // is user-scoped, not conversation-scoped.
    if (row && row.conversation_id === conversationId) rows.push(row);
  }

  return { rows, error: null };
}

// ------------------------------------------------------------
// Screen
// ------------------------------------------------------------

interface SharedSpaceScreenProps {
  conversationId: string;
  onBack: () => void;
}

export default function SharedSpaceScreen({ conversationId, onBack }: SharedSpaceScreenProps) {
  const { width } = useWindowDimensions();
  const [section, setSection] = useState<SectionKey>('photos');
  const [rows, setRows] = useState<SharedRow[]>([]);
  const [savedRows, setSavedRows] = useState<SharedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<SharedItem | null>(null);

  const def = SECTION_BY_KEY[section];
  const isGrid = def.layout === 'grid';

  /** seq of the oldest loaded row — the keyset cursor. */
  const oldestSeqRef = useRef<number | null>(null);
  /** Flips to false if this deployment predates the `metadata` column. */
  const metadataOkRef = useRef(true);
  const inFlightRef = useRef(false);
  /** Stops the Links section from walking the whole history in one render. */
  const autoPagesRef = useRef(0);
  /** Invalidates responses from a section the user already left. */
  const requestIdRef = useRef(0);

  const tileSize = useMemo(
    () => Math.floor((width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS),
    [width]
  );

  const items = useMemo(() => buildItems(section, rows, savedRows), [section, rows, savedRows]);

  const loadHead = useCallback(
    async (sectionKey: SectionKey, mode: 'initial' | 'refresh') => {
      const nextDef = SECTION_BY_KEY[sectionKey];
      const requestId = ++requestIdRef.current;
      inFlightRef.current = true;
      oldestSeqRef.current = null;

      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        if (nextDef.key === 'saved') {
          const result = await fetchSavedRows(conversationId);
          if (requestId !== requestIdRef.current) return;
          setSavedRows(result.rows);
          setRows([]);
          setHasMore(false);
          if (result.error) setError(result.error);
          return;
        }

        let result = await fetchMessagePage({
          conversationId,
          def: nextDef,
          beforeSeq: null,
          withMetadata: metadataOkRef.current,
        });
        if (result.error && metadataOkRef.current) {
          metadataOkRef.current = false;
          result = await fetchMessagePage({
            conversationId,
            def: nextDef,
            beforeSeq: null,
            withMetadata: false,
          });
        }
        if (requestId !== requestIdRef.current) return;

        const oldestSeq = result.rows.length > 0 ? result.rows[result.rows.length - 1].seq : null;
        setRows(result.rows);
        setSavedRows([]);
        oldestSeqRef.current = oldestSeq;
        setHasMore(result.hasMore && oldestSeq !== null);
        if (result.error) setError(result.error);
      } catch (e) {
        if (requestId === requestIdRef.current) {
          setError(friendlyError(e, 'Could not load this section.'));
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
          inFlightRef.current = false;
        }
      }
    },
    [conversationId]
  );

  // First page whenever the conversation or the active section changes.
  useEffect(() => {
    autoPagesRef.current = 0;
    void loadHead(section, 'initial');
  }, [section, loadHead]);

  const loadMore = useCallback(async () => {
    const currentDef = SECTION_BY_KEY[section];
    const beforeSeq = oldestSeqRef.current;

    if (inFlightRef.current || loading || refreshing || loadingMore) return;
    if (currentDef.key === 'saved' || !hasMore || beforeSeq === null) return;

    const requestId = requestIdRef.current;
    inFlightRef.current = true;
    setLoadingMore(true);

    try {
      let result = await fetchMessagePage({
        conversationId,
        def: currentDef,
        beforeSeq,
        withMetadata: metadataOkRef.current,
      });
      if (result.error && metadataOkRef.current) {
        metadataOkRef.current = false;
        result = await fetchMessagePage({
          conversationId,
          def: currentDef,
          beforeSeq,
          withMetadata: false,
        });
      }
      if (requestId !== requestIdRef.current) return;
      if (result.error) {
        setError(result.error);
        setHasMore(false);
        return;
      }

      setRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...result.rows.filter((row) => !seen.has(row.id))];
      });

      const oldestSeq = result.rows.length > 0 ? result.rows[result.rows.length - 1].seq : null;
      oldestSeqRef.current = oldestSeq ?? beforeSeq;
      setHasMore(result.hasMore && oldestSeq !== null);
    } catch (e) {
      if (requestId === requestIdRef.current) {
        setError(friendlyError(e, 'Could not load more.'));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingMore(false);
        inFlightRef.current = false;
      }
    }
  }, [conversationId, section, hasMore, loading, refreshing, loadingMore]);

  // Links are filtered client-side, so a page of text messages can
  // legitimately contain zero links. Walk forward a few pages so the
  // section doesn't look empty while links exist further back.
  useEffect(() => {
    if (section !== 'links') return;
    if (loading || refreshing || loadingMore || !hasMore || items.length > 0) return;
    if (autoPagesRef.current >= MAX_AUTO_PAGES) return;
    autoPagesRef.current += 1;
    void loadMore();
  }, [section, loading, refreshing, loadingMore, hasMore, items.length, loadMore]);

  const handleRefresh = useCallback(() => {
    autoPagesRef.current = 0;
    void loadHead(section, 'refresh');
  }, [loadHead, section]);

  const handleEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const openViewer = useCallback((item: SharedItem) => {
    setViewer(item);
  }, []);

  const closeViewer = useCallback(() => {
    setViewer(null);
  }, []);

  const countText =
    loading && items.length === 0 ? '—' : `${items.length}${hasMore ? '+' : ''}`;

  const emptyText = `No ${def.noun} in this conversation yet.`;

  const renderTile = (item: SharedItem) => (
    <Pressable
      style={[styles.tile, { width: tileSize, height: tileSize }]}
      onPress={() => openViewer(item)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title}, ${item.caption}`}
    >
      {item.uri ? (
        <Image source={{ uri: item.uri }} style={styles.tileImage} resizeMode="cover" />
      ) : (
        <View style={styles.tileFallback}>
          <Ionicons name={item.icon} size={20} color={colors.textFaint} />
        </View>
      )}
      {item.row.msg_type === 'video' || item.row.msg_type === 'audio' ? (
        <View style={styles.tileBadge}>
          <Ionicons
            name={item.row.msg_type === 'video' ? 'play' : 'musical-notes'}
            size={11}
            color={colors.text}
          />
        </View>
      ) : null}
    </Pressable>
  );

  const renderRow = (item: SharedItem) => (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`${item.title}. ${item.subtitle}. ${item.caption}`}
    >
      <View style={styles.rowIcon}>
        <Ionicons name={item.icon} size={18} color={colors.accent} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={2}>
          {item.subtitle}
        </Text>
      </View>
      <Text style={styles.rowDate}>{item.caption}</Text>
    </View>
  );

  return (
    <View style={styles.screen}>
      {/* ── Header ─────────────────────────────────────────── */}
      <View style={[styles.header, { paddingTop: TOP_INSET + spacing.sm }]}>
        <Pressable
          onPress={onBack}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Shared Space
        </Text>
        <View
          style={styles.countPill}
          accessible
          accessibilityLabel={`${items.length} ${def.noun} loaded`}
        >
          <Text style={styles.countText}>{countText}</Text>
        </View>
      </View>

      {/* ── Segmented filter ───────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={styles.filterScroll}
      >
        {SECTIONS.map((option) => {
          const active = option.key === section;
          return (
            <Pressable
              key={option.key}
              onPress={() => setSection(option.key)}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityLabel={`Show ${option.label}`}
              accessibilityState={{ selected: active }}
            >
              <Ionicons
                name={option.icon}
                size={14}
                color={active ? colors.text : colors.textMuted}
              />
              <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Content ────────────────────────────────────────── */}
      <FlatList
        key={isGrid ? 'grid' : 'list'}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (isGrid ? renderTile(item) : renderRow(item))}
        numColumns={isGrid ? GRID_COLUMNS : 1}
        columnWrapperStyle={isGrid ? styles.gridRow : undefined}
        contentContainerStyle={isGrid ? styles.gridContent : styles.listContent}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.6}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : error ? (
            <View style={styles.stateBlock}>
              <Ionicons name="cloud-offline-outline" size={26} color={colors.textFaint} />
              <Text style={styles.stateText}>Couldn’t load this section.</Text>
              <Text style={styles.stateDetail}>{error}</Text>
              <Pressable
                onPress={handleRefresh}
                style={styles.retryButton}
                accessibilityRole="button"
                accessibilityLabel="Retry loading this section"
              >
                <Text style={styles.retryLabel}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.stateBlock}>
              <Ionicons name={def.icon} size={26} color={colors.textFaint} />
              <Text style={styles.stateText}>{emptyText}</Text>
            </View>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : items.length > 0 && !hasMore ? (
            <Text style={styles.footerText}>That’s everything here.</Text>
          ) : null
        }
      />

      {/* ── Full-screen viewer ─────────────────────────────── */}
      <Modal
        visible={viewer !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeViewer}
      >
        <View style={styles.viewerBackdrop}>
          {viewer && viewer.uri && viewer.row.msg_type !== 'audio' ? (
            <Image source={{ uri: viewer.uri }} style={styles.viewerImage} resizeMode="contain" />
          ) : (
            <View style={styles.viewerFallback}>
              <Ionicons name={viewer?.icon ?? 'image-outline'} size={44} color={colors.textMuted} />
              <Text style={styles.viewerFallbackText}>{viewer?.subtitle ?? ''}</Text>
            </View>
          )}
          <View style={styles.viewerCaption}>
            <Text style={styles.viewerTitle}>{viewer?.title ?? ''}</Text>
            <Text style={styles.viewerSubtitle}>{viewer?.caption ?? ''}</Text>
          </View>
          <Pressable
            onPress={closeViewer}
            style={styles.viewerClose}
            accessibilityRole="button"
            accessibilityLabel="Close viewer"
            hitSlop={12}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

// ------------------------------------------------------------
// Styles — dark theme only, tokens from src/theme.ts
// ------------------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  headerTitle: {
    ...type.title,
    color: colors.text,
    flex: 1,
  },
  countPill: {
    minWidth: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    ...type.caption,
    color: colors.accent,
  },

  filterScroll: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterRow: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderStrong,
  },
  chipLabel: {
    ...type.caption,
    color: colors.textMuted,
  },
  chipLabelActive: {
    color: colors.text,
  },

  gridContent: {
    padding: GRID_GAP,
    gap: GRID_GAP,
  },
  gridRow: {
    gap: GRID_GAP,
  },
  tile: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  tileImage: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.surfaceAlt,
  },
  tileFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBadge: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },

  listContent: {
    paddingBottom: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...type.heading,
    color: colors.text,
  },
  rowSubtitle: {
    ...type.body,
    color: colors.textMuted,
  },
  rowDate: {
    ...type.caption,
    color: colors.textFaint,
  },

  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    width: '100%',
  },
  stateText: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  stateDetail: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentGlow,
  },
  retryLabel: {
    ...type.caption,
    color: colors.accent,
  },
  footer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  footerText: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },

  viewerBackdrop: {
    flex: 1,
    backgroundColor: colors.bgDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
  viewerFallback: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  viewerFallbackText: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  viewerCaption: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xxl,
    alignItems: 'center',
    gap: spacing.xs,
  },
  viewerTitle: {
    ...type.heading,
    color: colors.text,
  },
  viewerSubtitle: {
    ...type.caption,
    color: colors.textMuted,
  },
  viewerClose: {
    position: 'absolute',
    top: TOP_INSET + spacing.md,
    right: spacing.lg,
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
