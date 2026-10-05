import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../supabase/client';
import { colors, radius, spacing, type } from '../../theme';
import Avatar from '../Avatar';
import VerifiedBadge from '../ui/VerifiedBadge';
import { TOP_INSET } from '../../utils/useInsets';
import { friendlyError } from '../../utils/friendlyError';

// ------------------------------------------------------------------
// ForwardPicker — §4 "forward". Full-screen picker that lists every
// conversation the signed-in user belongs to so a message can be
// forwarded into one of them.
//
// Data is loaded in three explicit, typed round-trips (no PostgREST
// embeds are guessed):
//   1. conversation_participants  → the user's conversation ids
//   2. conversations              → id, type, name, avatar_url
//   3. conversation_participants  → the *other* member of each chat
//   4. profiles                   → id, username, avatar_url, verified
// ------------------------------------------------------------------

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (conversationId: string) => void;
};

type ConversationRow = {
  id: string;
  type: string | null;
  name: string | null;
  avatar_url: string | null;
};

type ParticipantRow = {
  conversation_id: string;
  user_id: string;
};

type ProfileRow = {
  id: string;
  username: string | null;
  avatar_url: string | null;
  verified: boolean | null;
};

type PickerRow = {
  id: string;
  name: string;
  avatarUrl: string | null;
  verified: boolean;
  isGroup: boolean;
};

export default function ForwardPicker({ visible, onClose, onPick }: Props) {
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid: string | undefined = auth?.user?.id;
        if (!uid) {
          if (!cancelled) setRows([]);
          return;
        }

        // 1. conversations this user is part of
        const { data: myParts } = await supabase
          .from('conversation_participants')
          .select('conversation_id')
          .eq('user_id', uid);

        const ids = Array.from(
          new Set(
            ((myParts ?? []) as { conversation_id: string }[])
              .map((p) => p.conversation_id)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          )
        );

        if (ids.length === 0) {
          if (!cancelled) setRows([]);
          return;
        }

        // 2. conversation rows
        const { data: convData } = await supabase
          .from('conversations')
          .select('id, type, name, avatar_url')
          .in('id', ids);

        const convs = (convData ?? []) as ConversationRow[];

        // 3. the other participants (for direct chats)
        const { data: allParts } = await supabase
          .from('conversation_participants')
          .select('conversation_id, user_id')
          .in('conversation_id', ids);

        const otherIdsByConv = new Map<string, string[]>();
        ((allParts ?? []) as ParticipantRow[]).forEach((p) => {
          if (!p?.conversation_id || !p?.user_id) return;
          if (p.user_id === uid) return;
          const list = otherIdsByConv.get(p.conversation_id) ?? [];
          list.push(p.user_id);
          otherIdsByConv.set(p.conversation_id, list);
        });

        const otherIds = Array.from(new Set(Array.from(otherIdsByConv.values()).flat()));

        // 4. profiles for those other participants
        const profilesById = new Map<string, ProfileRow>();
        if (otherIds.length > 0) {
          const { data: profData } = await supabase
            .from('profiles')
            .select('id, username, avatar_url, verified')
            .in('id', otherIds);
          ((profData ?? []) as ProfileRow[]).forEach((p) => {
            if (p?.id) profilesById.set(p.id, p);
          });
        }

        const next: PickerRow[] = convs.map((conv) => {
          const isGroup = conv.type === 'group';
          const otherId = (otherIdsByConv.get(conv.id) ?? [])[0];
          const other = otherId ? profilesById.get(otherId) : undefined;

          if (isGroup) {
            return {
              id: conv.id,
              name: conv.name?.trim() || 'Group',
              avatarUrl: conv.avatar_url ?? null,
              verified: false,
              isGroup: true,
            };
          }

          return {
            id: conv.id,
            name: other?.username?.trim() || 'Chat',
            avatarUrl: other?.avatar_url ?? conv.avatar_url ?? null,
            verified: other?.verified === true,
            isGroup: false,
          };
        });

        next.sort((a, b) => a.name.localeCompare(b.name));

        if (!cancelled) setRows(next);
      } catch (e) {
        if (!cancelled) {
          setRows([]);
          setError(friendlyError(e, 'Could not load conversations.'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, query]);

  const renderRow = ({ item }: { item: PickerRow }) => (
    <Pressable
      onPress={() => onPick(item.id)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Forward to ${item.name}${item.verified ? ', verified' : ''}${
        item.isGroup ? ', group' : ''
      }`}
    >
      <Avatar url={item.avatarUrl} name={item.name} size={46} />
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text style={styles.rowName} numberOfLines={1}>
            {item.name}
          </Text>
          {item.verified && <VerifiedBadge size={13} />}
        </View>
        {item.isGroup && <Text style={styles.groupHint}>Group</Text>}
      </View>
    </Pressable>
  );

  const empty = query.trim().length > 0 ? 'No matches.' : 'No conversations yet.';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Forward to</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close forward picker"
          >
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search conversations"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            accessibilityLabel="Search conversations"
          />
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.emptyText}>{empty}</Text>
              </View>
            }
            contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : undefined}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: TOP_INSET + spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...type.title,
    color: colors.text,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  rowBody: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  groupHint: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 3,
  },
  center: {
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flexGrow: 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
  },
});
