// ============================================================
// SavesScreen — "My Saves" (§18)
//
// The personal messaging vault: every message the user saved from
// any conversation, in one place, newest save first.
//
// Deliberately dependency-light: two sequential queries instead of a
// PostgREST embed, because the embed name for saved_messages →
// messages is not guaranteed by the migration set and a failed embed
// returns an error rather than partial data.
//
// Visual language is borrowed from MessageBubble: tail-less surfaces,
// a 2px kind rail as a plain View, generous spacing, no harsh borders.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, spacing, type } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import Icon, { type IconName } from '../components/ui/Icon';
import { friendlyError } from '../utils/friendlyError';

// ------------------------------------------------------------
// Row shapes — the exact columns this screen reads.
// ------------------------------------------------------------

/** public.saved_messages — user_id, message_id, note, created_at */
interface SavedRow {
  user_id: string;
  message_id: string;
  note: string | null;
  created_at: string | null;
}

/** public.messages — the subset My Saves renders */
interface MessageRow {
  id: string;
  sender_id: string | null;
  content: string | null;
  media_url: string | null;
  msg_type: string | null;
  created_at: string | null;
  deleted_at: string | null;
}

/** public.profiles — sender label only */
interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * The render model. Everything the card needs, already resolved, so
 * renderItem never has to reach back into a lookup table.
 */
interface SavedItem {
  messageId: string;
  kind: SaveKind;
  preview: string;
  mediaUrl: string | null;
  senderLabel: string | null;
  senderId: string | null;
  savedAt: string;
  messageAt: string | null;
}

type SaveKind = 'text' | 'photo' | 'video' | 'voice' | 'file' | 'link' | 'other';

type FilterKey = 'all' | 'photo' | 'video' | 'voice' | 'file' | 'link';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'photo', label: 'Photos' },
  { key: 'video', label: 'Videos' },
  { key: 'voice', label: 'Voice' },
  { key: 'file', label: 'Files' },
  { key: 'link', label: 'Links' },
];

const KIND_ICON: Record<SaveKind, IconName> = {
  text: 'chatbubble-ellipses-outline',
  photo: 'image-outline',
  video: 'videocam-outline',
  voice: 'mic-outline',
  file: 'document-outline',
  link: 'link-outline',
  other: 'help-circle-outline',
};

const KIND_LABEL: Record<SaveKind, string> = {
  text: 'Message',
  photo: 'Photo',
  video: 'Video',
  voice: 'Voice message',
  file: 'File',
  link: 'Link',
  other: 'Saved message',
};

const LINK_RE = /(https?:\/\/[^\s]+)/i;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** "just now" · "5m ago" · "3h ago" · "2d ago" · "4 Mar" */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 45_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function kindOf(msg: MessageRow | undefined): SaveKind {
  if (!msg) return 'other';
  if (msg.deleted_at) return 'other';
  const t = (msg.msg_type ?? 'text').toLowerCase();
  if (t === 'image' || t === 'gif' || t === 'sticker' || t === 'moment') return 'photo';
  if (t === 'video' || t === 'video_message') return 'video';
  if (t === 'voice' || t === 'audio') return 'voice';
  if (t === 'file') return 'file';
  if (msg.content && LINK_RE.test(msg.content)) return 'link';
  if (!msg.content) return 'other';
  return 'text';
}

function previewOf(msg: MessageRow | undefined, kind: SaveKind): string {
  if (!msg) return 'Not available';
  if (msg.deleted_at) return 'Message deleted';
  switch (kind) {
    case 'photo':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'voice':
      return 'Voice message';
    case 'file':
      return 'File';
    case 'link':
      return (msg.content ?? 'Link').trim();
    case 'text':
      return (msg.content ?? '').trim();
    default:
      return 'Message';
  }
}

function isMedia(kind: SaveKind): boolean {
  return kind === 'photo' || kind === 'video';
}

// ------------------------------------------------------------
// Screen
// ------------------------------------------------------------

export default function SavesScreen({ onBack }: { onBack: () => void }) {
  const [uid, setUid] = useState<string | null>(null);
  const [items, setItems] = useState<SavedItem[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<SavedItem | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'refresh') setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const { data: auth } = await supabase.auth.getUser();
      const me = auth?.user?.id ?? null;
      if (!me) {
        setUid(null);
        setItems([]);
        return;
      }
      setUid(me);

      // 1. the vault rows, newest save first
      const { data: savedRaw, error: savedErr } = await supabase
        .from('saved_messages')
        .select('user_id, message_id, note, created_at')
        .eq('user_id', me)
        .order('created_at', { ascending: false });

      if (savedErr) throw new Error(savedErr.message);

      const saved = (Array.isArray(savedRaw) ? savedRaw : []) as unknown as SavedRow[];
      const messageIds = saved
        .map((s) => s.message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      if (messageIds.length === 0) {
        setItems([]);
        return;
      }

      // 2. the referenced messages by id (no embed guesswork)
      const { data: msgRaw, error: msgErr } = await supabase
        .from('messages')
        .select('id, sender_id, content, media_url, msg_type, created_at, deleted_at')
        .in('id', messageIds);

      if (msgErr) throw new Error(msgErr.message);

      const messages = (Array.isArray(msgRaw) ? msgRaw : []) as unknown as MessageRow[];
      const byId = new Map<string, MessageRow>();
      for (const m of messages) {
        if (m && typeof m.id === 'string') byId.set(m.id, m);
      }

      // 3. sender labels (best effort — a missing profile is not an error)
      const senderIds = Array.from(
        new Set(
          messages
            .map((m) => m.sender_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== me)
        )
      );

      const names = new Map<string, string>();
      if (senderIds.length > 0) {
        const { data: peopleRaw } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', senderIds);

        const people = (Array.isArray(peopleRaw) ? peopleRaw : []) as unknown as ProfileRow[];
        for (const p of people) {
          if (!p || typeof p.id !== 'string') continue;
          const label = (p.display_name && p.display_name.trim()) || (p.username ? `@${p.username}` : '');
          if (label) names.set(p.id, label);
        }
      }

      // 4. resolve the render model
      const resolved: SavedItem[] = saved
        .filter((s): s is SavedRow => !!s && typeof s.message_id === 'string')
        .map((s) => {
          const msg = byId.get(s.message_id);
          const kind = kindOf(msg);
          const senderId = msg?.sender_id ?? null;
          return {
            messageId: s.message_id,
            kind,
            preview: previewOf(msg, kind),
            mediaUrl: msg?.media_url ?? null,
            senderId,
            senderLabel:
              senderId === null
                ? null
                : senderId === me
                  ? 'You'
                  : (names.get(senderId) ?? 'Member'),
            savedAt: s.created_at ?? '',
            messageAt: msg?.created_at ?? null,
          };
        });

      setItems(resolved);
    } catch (e: unknown) {
      // Never crash on a failed query — surface it and keep what we have.
      const message =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null && 'message' in e
            ? String((e as { message: unknown }).message)
            : 'Could not load your saves.';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load('initial');
  }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.kind === filter)),
    [items, filter]
  );

  const unsave = useCallback(
    async (item: SavedItem) => {
      if (!uid) return;
      const snapshot = items;
      // optimistic removal
      setItems((prev) => prev.filter((i) => i.messageId !== item.messageId));
      setViewer((v) => (v && v.messageId === item.messageId ? null : v));

      const { error: delErr } = await supabase
        .from('saved_messages')
        .delete()
        .eq('user_id', uid)
        .eq('message_id', item.messageId);

      if (delErr) {
        setItems(snapshot); // roll back
        setError(friendlyError(delErr, 'Could not unsave that message.'));
      }
    },
    [items, uid]
  );

  // ----------------------------------------------------------
  // Header
  // ----------------------------------------------------------
  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable
          onPress={onBack}
          style={styles.backBtn}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="chevron-back" size={22} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>

        <View style={styles.titleWrap}>
          <Text style={styles.title}>My Saves</Text>
          <Text style={styles.count}>
            {items.length === 1 ? '1 saved message' : `${items.length} saved messages`}
          </Text>
        </View>

        <View style={styles.headerSpacer} />
      </View>
    </View>
  );

  // ----------------------------------------------------------
  // Error bar (dismissible, never blocks the list)
  // ----------------------------------------------------------
  const errorBar = !!error && (
    <View style={styles.errorBar}>
      <Icon name="alert-circle-outline" size={16} color={colors.danger} />
      <Text style={styles.errorText} numberOfLines={2}>
        {error}
      </Text>
      <Pressable
        onPress={() => setError(null)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
      >
        <Icon name="close" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );

  // ----------------------------------------------------------
  // Filter chips
  // ----------------------------------------------------------
  const chips = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipsContent}
      style={styles.chipsScroll}
    >
      {FILTERS.map((f) => {
        const on = filter === f.key;
        const n = f.key === 'all' ? items.length : items.filter((i) => i.kind === f.key).length;
        return (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${f.label}, ${n} saved`}
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
            {n > 0 && <Text style={[styles.chipCount, on && styles.chipCountOn]}>{n}</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );

  // ----------------------------------------------------------
  // Empty state
  // ----------------------------------------------------------
  const empty = (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIcon}>
        <Icon name="bookmark-outline" size={30} color={colors.textFaint} />
      </View>
      <Text style={styles.emptyTitle}>Nothing saved yet</Text>
      <Text style={styles.emptyBody}>Long-press any message and choose Save.</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {header}
      {errorBar}
      {chips}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.messageId}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('refresh')}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          ListEmptyComponent={empty}
          renderItem={({ item }) => (
            <SavedCard item={item} onOpen={setViewer} onUnsave={unsave} />
          )}
        />
      )}

      {/* full-screen media viewer */}
      <Modal
        visible={!!viewer}
        transparent
        animationType="fade"
        onRequestClose={() => setViewer(null)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            onPress={() => setViewer(null)}
            style={styles.modalClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close media"
          >
            <Icon name="close" size={24} color={colors.text} />
          </Pressable>

          {!!viewer?.mediaUrl && (
            <Image
              source={{ uri: viewer.mediaUrl }}
              style={styles.modalImage}
              resizeMode="contain"
              accessibilityLabel={KIND_LABEL[viewer.kind]}
            />
          )}

          <View style={styles.modalFooter}>
            <Text style={styles.modalCaption} numberOfLines={1}>
              {viewer ? `${KIND_LABEL[viewer.kind]} · saved ${relativeTime(viewer.savedAt)}` : ''}
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ------------------------------------------------------------
// Card — tail-less surface with a 2px kind rail (MessageBubble language)
// ------------------------------------------------------------

function SavedCard({
  item,
  onOpen,
  onUnsave,
}: {
  item: SavedItem;
  onOpen: (item: SavedItem) => void;
  onUnsave: (item: SavedItem) => void;
}) {
  const openable = isMedia(item.kind) && !!item.mediaUrl;

  return (
    <View style={styles.cardRow}>
      <View style={styles.rail} />

      <Pressable
        onPress={() => (openable ? onOpen(item) : undefined)}
        disabled={!openable}
        style={styles.card}
        accessibilityRole="button"
        accessibilityLabel={`${KIND_LABEL[item.kind]}${item.senderLabel ? ` from ${item.senderLabel}` : ''}: ${
          item.preview
        }. Saved ${relativeTime(item.savedAt)}.`}
      >
        <View style={styles.cardTop}>
          <View style={styles.kindIcon}>
            <Icon name={KIND_ICON[item.kind]} size={16} color={colors.accent} />
          </View>

          <View style={styles.cardBody}>
            <Text style={styles.preview} numberOfLines={1}>
              {item.preview}
            </Text>

            <View style={styles.metaRow}>
              {!!item.senderLabel && (
                <Text style={styles.sender} numberOfLines={1}>
                  {item.senderLabel}
                </Text>
              )}
              {!!item.senderLabel && !!item.savedAt && <Text style={styles.dot}>·</Text>}
              <Text style={styles.savedAt}>{relativeTime(item.savedAt)}</Text>
            </View>
          </View>
        </View>

        {item.kind === 'photo' && !!item.mediaUrl && (
          <Image
            source={{ uri: item.mediaUrl }}
            style={styles.thumb}
            resizeMode="cover"
            accessibilityLabel="Saved photo preview"
          />
        )}
      </Pressable>

      <Pressable
        onPress={() => onUnsave(item)}
        hitSlop={8}
        style={styles.unsave}
        accessibilityRole="button"
        accessibilityLabel={`Unsave ${KIND_LABEL[item.kind]}`}
      >
        <Icon name="bookmark" size={17} color={colors.accent} />
      </Pressable>
    </View>
  );
}

// ------------------------------------------------------------
// Styles
// ------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // header ---------------------------------------------------
  header: {
    paddingTop: TOP_INSET + 12,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtn: {
    width: 84,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  titleWrap: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    ...type.title,
    color: colors.text,
  },
  count: {
    ...type.micro,
    color: colors.textMuted,
    marginTop: 2,
  },
  headerSpacer: {
    width: 84,
  },

  // error bar ------------------------------------------------
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorText: {
    ...type.caption,
    color: colors.textMuted,
    flex: 1,
  },

  // chips ----------------------------------------------------
  chipsScroll: {
    flexGrow: 0,
  },
  chipsContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentSoft,
  },
  chipText: {
    ...type.caption,
    color: colors.textMuted,
  },
  chipTextOn: {
    color: colors.accent,
    fontWeight: '700',
  },
  chipCount: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textFaint,
  },
  chipCountOn: {
    color: colors.accent,
  },

  loader: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xxl,
  },

  // card -----------------------------------------------------
  cardRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: spacing.md,
  },
  rail: {
    width: 2,
    borderRadius: 2,
    backgroundColor: colors.accent,
    opacity: 0.85,
    marginRight: spacing.md,
  },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  kindIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
  },
  preview: {
    ...type.body,
    color: colors.text,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
  },
  sender: {
    ...type.caption,
    color: colors.textMuted,
    flexShrink: 1,
  },
  dot: {
    color: colors.textFaint,
    fontSize: 12,
  },
  savedAt: {
    ...type.caption,
    color: colors.textFaint,
  },
  thumb: {
    width: '100%',
    height: 132,
    borderRadius: radius.md,
    marginTop: spacing.sm + 2,
    backgroundColor: colors.surfaceAlt,
  },
  unsave: {
    alignSelf: 'flex-start',
    marginLeft: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },

  // empty ----------------------------------------------------
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    marginTop: 78,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...type.heading,
    color: colors.text,
    marginTop: spacing.md,
  },
  emptyBody: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs + 2,
  },

  // modal ----------------------------------------------------
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalClose: {
    position: 'absolute',
    top: TOP_INSET + spacing.lg,
    right: spacing.lg,
    padding: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    zIndex: 2,
  },
  modalImage: {
    width: '100%',
    height: '80%',
  },
  modalFooter: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
  },
  modalCaption: {
    ...type.caption,
    color: colors.textMuted,
  },
});
