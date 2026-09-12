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
import { supabase } from '../../supabase/client';
import { colors, radius } from '../../theme';
import { TOP_INSET } from '../../utils/useInsets';
import Avatar from '../Avatar';
import Icon from '../ui/Icon';
import VerifiedBadge from '../ui/VerifiedBadge';

type Person = { id: string; username: string; avatar_url: string | null; verified: boolean };

// ---------------------------------------------------------------
// Shared page shell - full screen so long lists get real space
// ---------------------------------------------------------------
function Page({
  title,
  count,
  blurb,
  query,
  onQuery,
  onClose,
  children,
  searchPlaceholder,
}: {
  title: string;
  count: number;
  blurb: string;
  query: string;
  onQuery: (v: string) => void;
  onClose: () => void;
  children: React.ReactNode;
  searchPlaceholder: string;
}) {
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.backBtn}>
            <Icon name="chevron-back" size={22} color={colors.accent} />
          </Pressable>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerCount}>{count}</Text>
        </View>

        <View style={styles.searchWrap}>
          <View style={styles.searchPill}>
            <Icon name="search-outline" size={16} color={colors.textFaint} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={onQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {!!query && (
              <Pressable onPress={() => onQuery('')} hitSlop={8}>
                <Icon name="close-circle" size={16} color={colors.textFaint} />
              </Pressable>
            )}
          </View>
          <Text style={styles.blurb}>{blurb}</Text>
        </View>

        {children}
      </View>
    </Modal>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Icon name="sparkles-outline" size={22} color={colors.textFaint} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------
// Generic people list (blocked / muted)
// ---------------------------------------------------------------
type PeopleConfig = {
  title: string;
  blurb: string;
  emptyText: string;
  searchPlaceholder: string;
  table: string;
  ownerColumn: string;
  targetColumn: string;
  selectExpr: string;
  actionLabel: string;
};

function PeopleScreen({
  visible,
  config,
  onClose,
  onChanged,
}: {
  visible: boolean;
  config: PeopleConfig;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data } = await supabase.from(config.table).select(config.selectExpr).eq(config.ownerColumn, user.id);
    setRows(
      ((data ?? []) as any[]).map((row) => ({
        id: row[config.targetColumn],
        username: row.profile?.username ?? 'unknown',
        avatar_url: row.profile?.avatar_url ?? null,
        verified: !!row.profile?.verified,
      }))
    );
    setLoading(false);
  }, [config.table, config.ownerColumn, config.targetColumn, config.selectExpr]);

  useEffect(() => {
    if (visible) {
      setQuery('');
      load();
    }
  }, [visible, load]);

  const remove = async (id: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
    await supabase.from(config.table).delete().eq(config.ownerColumn, user.id).eq(config.targetColumn, id);
    onChanged?.();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.username.toLowerCase().includes(q));
  }, [rows, query]);

  if (!visible) return null;

  return (
    <Page
      title={config.title}
      count={rows.length}
      blurb={config.blurb}
      query={query}
      onQuery={setQuery}
      onClose={onClose}
      searchPlaceholder={config.searchPlaceholder}
    >
      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={styles.personRow}>
              <Avatar url={item.avatar_url} name={item.username} size={44} verified={item.verified} />
              <View style={styles.personInfo}>
                <View style={styles.personNameRow}>
                  <Text style={styles.personName} numberOfLines={1}>
                    @{item.username}
                  </Text>
                  {item.verified && <VerifiedBadge size={12} glow={false} style={styles.personBadge} />}
                </View>
                <Text style={styles.personMeta}>Tap {config.actionLabel.toLowerCase()} to restore them</Text>
              </View>
              <Pressable style={styles.actionBtn} onPress={() => remove(item.id)} hitSlop={6}>
                <Text style={styles.actionText}>{config.actionLabel}</Text>
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <EmptyState text={query ? `No matches for "${query.trim()}"` : config.emptyText} />
          }
        />
      )}
    </Page>
  );
}

export function BlockedScreen({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <PeopleScreen
      visible={visible}
      onClose={onClose}
      onChanged={onChanged}
      config={{
        title: 'Blocked accounts',
        blurb: 'Blocked people cannot see your profile, follow you or message you.',
        emptyText: 'Nobody is blocked. Blocking is the strongest limit you can set.',
        searchPlaceholder: 'Search blocked accounts',
        table: 'blocks',
        ownerColumn: 'blocker_id',
        targetColumn: 'blocked_id',
        selectExpr: 'blocked_id, profile:profiles!blocks_blocked_id_fkey(username, avatar_url, verified)',
        actionLabel: 'Unblock',
      }}
    />
  );
}

export function MutedScreen({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <PeopleScreen
      visible={visible}
      onClose={onClose}
      onChanged={onChanged}
      config={{
        title: 'Muted accounts',
        blurb: 'Muted people still follow you, you just stop seeing their posts in the feed.',
        emptyText: 'Nobody is muted. Muting keeps a follow intact while hiding the posts.',
        searchPlaceholder: 'Search muted accounts',
        table: 'muted_accounts',
        ownerColumn: 'user_id',
        targetColumn: 'muted_id',
        selectExpr: 'muted_id, profile:profiles!muted_accounts_muted_id_fkey(username, avatar_url, verified)',
        actionLabel: 'Unmute',
      }}
    />
  );
}

// ---------------------------------------------------------------
// Hidden words
// ---------------------------------------------------------------
export function HiddenWordsScreen({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [words, setWords] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data } = await supabase.from('hidden_words').select('word').eq('user_id', user.id);
    setWords(((data ?? []) as { word: string }[]).map((r) => r.word).sort((a, b) => a.localeCompare(b)));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) {
      setQuery('');
      setDraft('');
      setError(null);
      load();
    }
  }, [visible, load]);

  const add = async () => {
    const word = draft.trim().toLowerCase();
    if (!word) return;
    if (words.includes(word)) {
      setError('That word is already hidden.');
      return;
    }
    setError(null);
    setDraft('');
    setWords((prev) => [...prev, word].sort((a, b) => a.localeCompare(b)));
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('hidden_words').insert({ user_id: user.id, word });
    onChanged?.();
  };

  const remove = async (word: string) => {
    setWords((prev) => prev.filter((w) => w !== word));
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('hidden_words').delete().eq('user_id', user.id).eq('word', word);
    onChanged?.();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return words;
    return words.filter((w) => w.includes(q));
  }, [words, query]);

  if (!visible) return null;

  return (
    <Page
      title="Hidden words"
      count={words.length}
      blurb="Comments and captions containing these words are kept out of your view."
      query={query}
      onQuery={setQuery}
      onClose={onClose}
      searchPlaceholder="Search hidden words"
    >
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="Add a word to hide..."
          placeholderTextColor={colors.textFaint}
          value={draft}
          onChangeText={(t) => {
            setDraft(t);
            setError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={add}
        />
        <Pressable style={[styles.addBtn, !draft.trim() && styles.addBtnOff]} onPress={add} disabled={!draft.trim()}>
          <Icon name="add" size={20} color={draft.trim() ? colors.bg : colors.textFaint} />
        </Pressable>
      </View>
      {!!error && <Text style={styles.errorText}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <View style={styles.wordRow}>
              <Icon name="eye-off-outline" size={16} color={colors.textMuted} />
              <Text style={styles.wordText}>{item}</Text>
              <Pressable onPress={() => remove(item)} hitSlop={10} style={styles.wordRemove}>
                <Icon name="trash-outline" size={17} color={colors.danger} />
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <EmptyState
              text={
                query
                  ? `No hidden word matches "${query.trim()}"`
                  : 'No hidden words yet. Add the words you never want to see.'
              }
            />
          }
        />
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: TOP_INSET + 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.glass,
  },
  backBtn: { width: 40 },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  headerCount: {
    minWidth: 40,
    textAlign: 'right',
    color: colors.accent,
    fontSize: 15,
    fontWeight: '800',
    paddingRight: 6,
  },
  searchWrap: { paddingHorizontal: 16, paddingTop: 14 },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 13.5,
    padding: 0,
  },
  blurb: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
    marginBottom: 4,
  },
  loader: { paddingVertical: 40 },
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  personInfo: { flex: 1 },
  personNameRow: { flexDirection: 'row', alignItems: 'center' },
  personName: { color: colors.text, fontSize: 14, fontWeight: '600', maxWidth: '80%' },
  personBadge: { marginLeft: 4 },
  personMeta: { color: colors.textFaint, fontSize: 11.5, marginTop: 2 },
  actionBtn: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.surface,
  },
  actionText: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
  empty: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 56,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  addInput: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 13.5,
  },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnOff: { backgroundColor: colors.surfaceAlt },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 18,
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  wordText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '500' },
  wordRemove: { padding: 4 },
});
