// ============================================================
// ADD MEMBERS SHEET (§27)
//
// Bottom sheet that lists addable people, filters them from a
// TextInput, multi-selects with checkmarks and inserts one
// conversation_participants row per pick.
//
// ── EXACT COLUMNS / ROLE VALUES ──────────────────────────────
// supabase/messaging_v2.sql:386-401 declares
//   role text not null default 'member'
// with
//   participants_role_chk check (role in ('member','admin','owner'))
// so the LOWEST-privilege value the CHECK allows is 'member' —
// that is exactly what every insert below uses.
//
// ── DUPLICATES ───────────────────────────────────────────────
// conversation_participants' primary key is (conversation_id, user_id)
// (supabase/schema.sql:155-160), so re-adding an existing member raises
// Postgres SQLSTATE '23505'. That is swallowed as a no-op, not an error.
//
// ── LEGACY DATABASES ─────────────────────────────────────────
// If `role` does not exist yet (messaging_v2.sql not applied), the insert
// is retried without it — the column default ('member') then applies — and
// the sheet reports the degradation in an inline note.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import { colors, radius, spacing, type } from '../../theme';
import { supabase } from '../../supabase/client';
import { useSheetPad } from '../../utils/useSheetPad';
import Avatar from '../Avatar';
import VerifiedBadge from '../ui/VerifiedBadge';
import { friendlyError } from '../../utils/friendlyError';

/** The lowest-privilege role permitted by participants_role_chk. */
const DEFAULT_ROLE = 'member' as const;

const PROFILE_LIMIT = 300;
const SHEET_RESTING_PAD = 30;

interface AddMembersSheetProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  existingMemberIds: string[];
  onAdded: () => void;
}

interface CandidateRow {
  id: string;
  username: string;
  avatarUrl: string | null;
  verified: boolean;
}

interface SupabaseErrorParts {
  message: string;
  code: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asArray(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [];
}

function toCandidate(raw: unknown): CandidateRow | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    username: asString(raw.username) ?? 'Member',
    avatarUrl: asString(raw.avatar_url),
    verified: raw.verified === true,
  };
}

function errorMessage(e: unknown, fallback: string): string {
  if (isRecord(e) && typeof e.message === 'string' && e.message.length > 0) return e.message;
  if (e instanceof Error && e.message.length > 0) return e.message;
  return fallback;
}

function errorParts(e: unknown): SupabaseErrorParts {
  if (isRecord(e)) {
    return {
      message: typeof e.message === 'string' ? e.message : '',
      code: typeof e.code === 'string' ? e.code : '',
    };
  }
  return { message: e instanceof Error ? e.message : '', code: '' };
}

/** Duplicate participant row — the PK (conversation_id, user_id) is already there. */
function isDuplicate(e: unknown): boolean {
  const { code, message } = errorParts(e);
  return code === '23505' || /duplicate key|already exists/i.test(message);
}

/** The `role` column has not been migrated in on this deployment yet. */
function isMissingRoleColumn(e: unknown): boolean {
  const { code, message } = errorParts(e);
  if (code === '42703') return true;
  return /role/i.test(message) && /column|schema cache/i.test(message);
}

export default function AddMembersSheet({
  visible,
  onClose,
  conversationId,
  existingMemberIds,
  onAdded,
}: AddMembersSheetProps) {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const sheetPad = useSheetPad(SHEET_RESTING_PAD);

  // A stable, memoised exclusion set — the caller rebuilds its array every
  // render, so depending on the array identity would re-fetch on every keystroke.
  const excludedKey = useMemo(() => [...existingMemberIds].sort().join(','), [existingMemberIds]);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const excluded = new Set(excludedKey.length > 0 ? excludedKey.split(',') : []);

    const load = async () => {
      setLoading(true);
      setError(null);
      setNote(null);
      setSelected([]);
      setQuery('');

      try {
        const { data: auth } = await supabase.auth.getUser();
        const me = auth.user?.id ?? null;

        const res = await supabase
          .from('profiles')
          .select('id, username, avatar_url, verified')
          .order('username', { ascending: true })
          .limit(PROFILE_LIMIT);

        if (res.error) {
          if (!cancelled) setError(friendlyError(res.error));
          return;
        }

        const rows = asArray(res.data)
          .map(toCandidate)
          .filter((row): row is CandidateRow => row !== null)
          .filter((row) => !excluded.has(row.id) && row.id !== me);

        if (!cancelled) setCandidates(rows);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, 'Could not load people.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [visible, excludedKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return candidates;
    return candidates.filter((row) => row.username.toLowerCase().includes(q));
  }, [candidates, query]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const addSelected = async () => {
    if (saving || selected.length === 0) return;
    const ids = [...selected];

    setSaving(true);
    setError(null);
    setNote(null);

    try {
      let duplicates = 0;
      let roleColumnMissing = false;
      let added = 0;

      for (const userId of ids) {
        // One row per selected user, with the exact migrated columns.
        let res = await supabase
          .from('conversation_participants')
          .insert({ conversation_id: conversationId, user_id: userId, role: DEFAULT_ROLE });

        if (res.error && isMissingRoleColumn(res.error)) {
          roleColumnMissing = true;
          // Legacy database: rely on the column default ('member').
          res = await supabase
            .from('conversation_participants')
            .insert({ conversation_id: conversationId, user_id: userId });
        }

        if (res.error) {
          if (isDuplicate(res.error)) {
            duplicates += 1;
            continue;
          }
          setError(friendlyError(res.error));
          return;
        }
        added += 1;
      }

      if (roleColumnMissing) {
        setNote(
          "Inserted without the `role` column — this database has not run supabase/messaging_v2.sql yet, so the column default 'member' applied."
        );
      } else if (duplicates > 0 && added === 0) {
        setNote('Everyone selected was already in this group.');
      }

      onAdded();
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'Could not add those people.'));
    } finally {
      setSaving(false);
    }
  };

  const renderRow = ({ item }: { item: CandidateRow }) => {
    const checked = selected.includes(item.id);
    return (
      <Pressable
        onPress={() => toggle(item.id)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`${item.username}${item.verified ? ', verified' : ''}`}
        accessibilityState={{ selected: checked }}
      >
        <Avatar url={item.avatarUrl} name={item.username} size={44} />
        <View style={styles.rowBody}>
          <View style={styles.nameRow}>
            <Text style={styles.rowName} numberOfLines={1}>
              {item.username}
            </Text>
            {item.verified ? <VerifiedBadge size={13} /> : null}
          </View>
        </View>
        <View style={[styles.check, checked && styles.checkOn]}>
          {checked ? <Ionicons name="checkmark" size={15} color={colors.bg} /> : null}
        </View>
      </Pressable>
    );
  };

  const count = selected.length;
  const buttonLabel = count > 0 ? `Add ${count}` : 'Add';
  const emptyText =
    query.trim().length > 0 ? 'No people match that search.' : 'No one new to add right now.';

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close add members sheet"
      />
      <View style={[styles.sheet, { paddingBottom: sheetPad }]}>
        <View style={styles.grabber} />

        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Add members
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close add members sheet"
          >
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={15} color={colors.textFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search people"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel="Search people to add"
          />
        </View>

        {error ? (
          <View style={styles.errorBar} accessibilityRole="alert">
            <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              onPress={() => setError(null)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
            >
              <Ionicons name="close" size={16} color={colors.danger} />
            </Pressable>
          </View>
        ) : null}

        {note ? (
          <View style={styles.noteBar} accessibilityRole="alert">
            <Ionicons name="information-circle-outline" size={16} color={colors.accent} />
            <Text style={styles.noteText}>{note}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.stateBlock}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : undefined}
            ListEmptyComponent={
              <View style={styles.stateBlock}>
                <Ionicons name="people-outline" size={24} color={colors.textFaint} />
                <Text style={styles.emptyText}>{emptyText}</Text>
              </View>
            }
          />
        )}

        <Pressable
          onPress={() => void addSelected()}
          disabled={count === 0 || saving}
          style={[styles.addButton, (count === 0 || saving) && styles.addButtonDisabled]}
          accessibilityRole="button"
          accessibilityLabel={count > 0 ? `Add ${count} selected member${count === 1 ? '' : 's'}` : 'Add members'}
          accessibilityState={{ disabled: count === 0 || saving }}
        >
          {saving ? (
            <ActivityIndicator color={colors.bg} size="small" />
          ) : (
            <Text style={styles.addButtonText}>{buttonLabel}</Text>
          )}
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
  },
  sheet: {
    maxHeight: '78%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingTop: spacing.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: {
    ...type.title,
    color: colors.text,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 10,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  errorText: {
    ...type.caption,
    color: colors.danger,
    flex: 1,
  },
  noteBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.accentGlow,
  },
  noteText: {
    ...type.caption,
    color: colors.accent,
    flex: 1,
  },
  list: {
    flexGrow: 0,
  },
  emptyContainer: {
    flexGrow: 1,
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
    ...type.heading,
    color: colors.text,
    flexShrink: 1,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceInput,
  },
  checkOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  emptyText: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  addButton: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    backgroundColor: colors.surfaceAlt,
  },
  addButtonText: {
    ...type.heading,
    color: colors.bg,
  },
});
