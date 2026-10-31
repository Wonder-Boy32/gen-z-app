import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import Avatar from './Avatar';
import VerifiedBadge from './ui/VerifiedBadge';
import Icon, { IconName } from './ui/Icon';
import { useSheetPad } from '../utils/useSheetPad';

type P = { id: string; username: string; avatar_url: string | null; last_seen_at: string | null };

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
};

export default function NewChatModal({ visible, onClose, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const [online, setOnline] = useState<P[]>([]);
  const [recent, setRecent] = useState<P[]>([]);
  const [following, setFollowing] = useState<P[]>([]);
  const [suggested, setSuggested] = useState<P[]>([]);
  const [trending, setTrending] = useState<P[]>([]);

  const sheetPad = useSheetPad(30);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const me = user?.id ?? null;

      const [profiles, follows, myFollows] = await Promise.all([
        supabase.from('profiles').select('id, username, avatar_url, last_seen_at, verified').limit(200),
        supabase.from('follows').select('follower_id, following_id').limit(1000),
        supabase.from('follows').select('following_id').eq('follower_id', me ?? '').limit(500),
      ]);

      const all = ((profiles.data ?? []) as P[]).filter((p) => p.id !== me);
      const followRows = (follows.data ?? []) as { follower_id: string; following_id: string }[];
      const mySet = new Set((myFollows.data ?? []).map((f: any) => f.following_id));

      const followerCount = new Map<string, number>();
      followRows.forEach((f) => followerCount.set(f.following_id, (followerCount.get(f.following_id) ?? 0) + 1));

      const affinity = new Map<string, number>();
      followRows.forEach((f) => {
        if (mySet.has(f.follower_id) && f.following_id !== me && !mySet.has(f.following_id)) {
          affinity.set(f.following_id, (affinity.get(f.following_id) ?? 0) + 1);
        }
      });

      const now = Date.now();
      setOnline(
        all
          .filter((p) => p.last_seen_at && now - new Date(p.last_seen_at).getTime() < 2 * 60000)
          .slice(0, 8)
      );
      setRecent(
        all
          .filter((p) => {
            if (!p.last_seen_at) return false;
            const d = now - new Date(p.last_seen_at).getTime();
            return d >= 2 * 60000 && d < 24 * 3600000;
          })
          .slice(0, 8)
      );
      setFollowing(all.filter((p) => mySet.has(p.id)).slice(0, 12));
      setSuggested(
        [...all.filter((p) => !mySet.has(p.id))]
          .sort((a, b) => (affinity.get(b.id) ?? 0) - (affinity.get(a.id) ?? 0))
          .slice(0, 8)
      );
      setTrending(
        [...all.filter((p) => !mySet.has(p.id))]
          .sort((a, b) => (followerCount.get(b.id) ?? 0) - (followerCount.get(a.id) ?? 0))
          .slice(0, 8)
      );
    })();
  }, [visible]);

  const q = query.trim().toLowerCase();
  const filter = (list: P[]) => (!q ? list : list.filter((p) => p.username.toLowerCase().includes(q)));

  const allPeople = [...online, ...recent, ...following, ...suggested, ...trending].filter(
    (p, i, arr) => arr.findIndex((x) => x.id === p.id) === i
  );
  const matched = q ? filter(allPeople).slice(0, 15) : [];

  const statusOf = (p: P) => {
    if (!p.last_seen_at) return 'Gen Z member';
    const diff = Date.now() - new Date(p.last_seen_at).getTime();
    if (diff < 2 * 60000) return 'Online now';
    if (diff < 3600000) return `Active ${Math.floor(diff / 60000)}m ago`;
    if (diff < 24 * 3600000) return `Active ${Math.floor(diff / 3600000)}h ago`;
    return 'Recently active';
  };

  const renderRow = (p: P) => (
    <Pressable key={p.id} style={styles.row} onPress={() => onOpen(p.id)}>
      <Avatar url={p.avatar_url} name={p.username} size={42} ring verified={!!(p as any).verified} />
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>@{p.username}</Text>
          {!!(p as any).verified && <VerifiedBadge size={12} style={styles.verifiedInline} />}
        </View>
        <Text style={[styles.status, statusOf(p) === 'Online now' && styles.statusOnline]}>
          {statusOf(p)}
        </Text>
      </View>
      <Text style={styles.cta}>Chat</Text>
    </Pressable>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: sheetPad }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Who do you want to vibe with?</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            placeholder="Search people..."
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
          />

          {q ? (
            <FlatList
              data={matched}
              keyExtractor={(p) => p.id}
              renderItem={({ item }) => renderRow(item)}
              ListEmptyComponent={<Text style={styles.empty}>No one found.</Text>}
            />
          ) : (
            <FlatList
              data={[
                ...(online.length ? [{ key: 'Online now', icon: 'radio', color: '#34C759', items: online }] : []),
                ...(recent.length ? [{ key: 'Recently active', icon: 'time-outline', color: '#FFC53D', items: recent }] : []),
                ...(suggested.length ? [{ key: 'Suggested for you', icon: 'sparkles', color: '#8B5CF6', items: suggested }] : []),
                ...(following.length ? [{ key: 'People you follow', icon: 'people-outline', color: '#4DD8FF', items: following }] : []),
                ...(trending.length ? [{ key: 'Trending creators', icon: 'flame', color: '#E52BFF', items: trending }] : []),
              ]}
              keyExtractor={(s) => s.key}
              renderItem={({ item }) => (
                <View>
                  <View style={styles.sectionTitleRow}>
                    <Icon name={item.icon as IconName} size={14} color={item.color} />
                    <Text style={styles.sectionTitle}>{item.key}</Text>
                  </View>
                  {item.items.map(renderRow)}
                </View>
              )}
              ListEmptyComponent={<Text style={styles.empty}>No one to vibe with yet — invite friends!</Text>}
            />
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
    height: '85%',
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 16,
    paddingBottom: 30,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    flex: 1,
  },
  close: {
    color: colors.textMuted,
    fontSize: 18,
    padding: 4,
  },
  search: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 14,
    marginBottom: 12,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    marginBottom: 4,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  avatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '700',
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  nameRow: { flexDirection: "row", alignItems: "center" },
  verifiedInline: { marginLeft: 4 },
  name: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  status: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 1,
  },
  statusOnline: {
    color: colors.success,
    fontWeight: '600',
  },
  cta: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 30,
  },
});
