import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, spacing } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Icon from '../components/ui/Icon';

/**
 * Message requests (spec §32) — the anti-spam gate.
 *
 * Rows come from public.conversation_requests where to_user = me and
 * state = 'pending', newest first. Sender details are resolved with a second
 * explicit profiles query (never a guessed PostgREST embed name). Every
 * decision writes state + decided_at and always carries .eq('id', rowId) so the
 * UPDATE has a WHERE clause; the row disappears optimistically and comes back
 * if the write is rejected.
 */

// Column names taken verbatim from supabase/messaging_v2.sql ->
// create table public.conversation_requests
// (id, conversation_id, from_user, to_user, state, created_at, decided_at).
type RequestState = 'pending' | 'accepted' | 'deleted' | 'blocked';

type RequestRow = {
  id: string;
  conversation_id: string;
  from_user: string;
  to_user: string;
  state: RequestState;
  created_at: string;
  decided_at: string | null;
};

type SenderProfile = {
  id: string;
  username: string;
  avatar_url: string | null;
  verified: boolean;
};

type Decision = 'accepted' | 'deleted' | 'blocked';

const REQUEST_COLUMNS = 'id, conversation_id, from_user, to_user, state, created_at, decided_at';

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

/** Narrow untyped Supabase rows into RequestRow[]. */
function hydrateRequests(raw: unknown): RequestRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is RequestRow => {
    if (!entry || typeof entry !== 'object') return false;
    const rec = entry as Record<string, unknown>;
    return typeof rec.id === 'string' && typeof rec.from_user === 'string';
  });
}

function hydrateSenders(raw: unknown): SenderProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .filter((rec) => typeof rec.id === 'string')
    .map((rec) => ({
      id: rec.id as string,
      username: typeof rec.username === 'string' ? rec.username : 'unknown',
      avatar_url: typeof rec.avatar_url === 'string' ? rec.avatar_url : null,
      verified: rec.verified === true,
    }));
}

export default function RequestsScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [senders, setSenders] = useState<Record<string, SenderProfile>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setRows([]);
      setSenders({});
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const { data, error: readErr } = await supabase
      .from('conversation_requests')
      .select(REQUEST_COLUMNS)
      .eq('to_user', user.id)
      .eq('state', 'pending')
      .order('created_at', { ascending: false })
      .limit(100);

    if (readErr) {
      setError(errorText(readErr, 'Could not load your message requests.'));
    } else {
      setError(null);
    }

    const list = hydrateRequests(data);
    setRows(list);

    // Sender profiles: a second explicit query, keyed by id.
    const senderIds = Array.from(new Set(list.map((r) => r.from_user)));
    if (senderIds.length > 0) {
      const { data: profData, error: profErr } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, verified')
        .in('id', senderIds);

      if (profErr) {
        setError(errorText(profErr, 'Could not load the people who messaged you.'));
      }
      const map: Record<string, SenderProfile> = {};
      for (const p of hydrateSenders(profData)) map[p.id] = p;
      setSenders(map);
    } else {
      setSenders({});
    }

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Optimistic decision: drop the row straight away, write state + decided_at
   * with a mandatory WHERE on the primary key, and put the row back if the
   * write is rejected.
   */
  const decide = useCallback(async (row: RequestRow, next: Decision) => {
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    setError(null);

    const { error: writeErr } = await supabase
      .from('conversation_requests')
      .update({ state: next, decided_at: new Date().toISOString() })
      .eq('id', row.id);

    if (writeErr) {
      setRows((prev) => {
        if (prev.some((r) => r.id === row.id)) return prev;
        return [...prev, row].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      });
      setError(errorText(writeErr, 'That request could not be updated. Try again.'));
    }
  }, []);

  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable
          onPress={onBack}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="chevron-back" size={20} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Requests</Text>
        <View style={styles.headerSpacer} />
      </View>
      <Text style={styles.subtitle}>
        People you don't follow yet have to ask before they can fill your chats.
      </Text>
    </View>
  );

  const pendingCount = rows.length;
  const listHeader = useMemo(() => {
    if (pendingCount === 0) return null;
    return (
      <Text style={styles.listHeading}>
        {pendingCount === 1 ? '1 person is waiting' : `${pendingCount} people are waiting`}
      </Text>
    );
  }, [pendingCount]);

  return (
    <View style={styles.container}>
      {header}

      {error ? (
        <View style={styles.errorBar} accessibilityRole="alert">
          <Icon name="alert-circle-outline" size={15} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => setError(null)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
          >
            <Icon name="close" size={16} color={colors.danger} />
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          ListHeaderComponent={listHeader}
          renderItem={({ item }) => {
            const sender = senders[item.from_user];
            const name = sender?.username ?? 'unknown';
            return (
              <View style={styles.card}>
                <View style={styles.cardTop}>
                  <Avatar
                    url={sender?.avatar_url}
                    name={name}
                    size={46}
                    ring
                    verified={!!sender?.verified}
                  />
                  <View style={styles.info}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>
                        {name}
                      </Text>
                      {!!sender?.verified && (
                        <VerifiedBadge size={12} glow={false} style={styles.verifiedInline} />
                      )}
                    </View>
                    <Text style={styles.handle} numberOfLines={1}>
                      @{name}
                    </Text>
                    <View style={styles.metaRow}>
                      <Icon name="time-outline" size={11} color={colors.textFaint} />
                      <Text style={styles.metaText}>{timeAgo(item.created_at)}</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.actions}>
                  <Pressable
                    style={[styles.action, styles.accept]}
                    onPress={() => decide(item, 'accepted')}
                    accessibilityRole="button"
                    accessibilityLabel={`Accept message request from ${name}`}
                  >
                    <Icon name="checkmark" size={15} color={colors.bg} />
                    <Text style={styles.acceptText}>Accept</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.action, styles.delete]}
                    onPress={() => decide(item, 'deleted')}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete message request from ${name}`}
                  >
                    <Icon name="trash-outline" size={15} color={colors.textMuted} />
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.action, styles.block]}
                    onPress={() => decide(item, 'blocked')}
                    accessibilityRole="button"
                    accessibilityLabel={`Block ${name}`}
                  >
                    <Icon name="ban-outline" size={15} color={colors.danger} />
                    <Text style={styles.blockText}>Block</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <View style={styles.emptyIcon}>
                <Icon name="mail-unread-outline" size={26} color={colors.textFaint} />
              </View>
              <Text style={styles.emptyTitle}>No message requests</Text>
              <Text style={styles.emptyBody}>
                When someone new messages you, it lands here first.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: TOP_INSET + 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 72,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 2,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  headerSpacer: {
    minWidth: 72,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.2,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surfaceAlt,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontSize: 13,
    fontWeight: '500',
  },
  loader: {
    marginTop: spacing.xl,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  listHeading: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  info: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  verifiedInline: {
    marginLeft: 5,
  },
  handle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  metaText: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  accept: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  acceptText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '800',
  },
  delete: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderStrong,
  },
  deleteText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  block: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.borderStrong,
  },
  blockText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
});
