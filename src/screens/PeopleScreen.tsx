import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import PublicProfileScreen from './PublicProfileScreen';
import Avatar from '../components/Avatar';

type Row = {
  id: string; // the other user's id
  username: string;
  avatar_url: string | null;
  status: string; // follows.status
};

export default function PeopleScreen({
  mode,
  onBack,
}: {
  mode: 'followers' | 'following';
  onBack: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [mutuals, setMutuals] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;
    const me = user?.id;
    if (!me) return;

    const myFollows = await supabase.from('follows').select('following_id').eq('follower_id', me).limit(500);
    const myFollowing = new Set((myFollows.data ?? []).map((f) => f.following_id));

    if (mode === 'followers') {
      const { data } = await supabase
        .from('follows')
        .select('follower_id, status, profile:profiles(username, avatar_url)')
        .eq('following_id', me)
        .limit(500);
      setRows(
        ((data ?? []) as any[]).map((f) => ({
          id: f.follower_id,
          username: f.profile?.username ?? 'unknown',
          avatar_url: f.profile?.avatar_url ?? null,
          status: f.status,
        }))
      );
      setMutuals(new Set((data ?? []).filter((f: any) => myFollowing.has(f.follower_id)).map((f: any) => f.follower_id)));
    } else {
      const { data } = await supabase
        .from('follows')
        .select('following_id, status, profile:profiles(username, avatar_url)')
        .eq('follower_id', me)
        .limit(500);
      setRows(
        ((data ?? []) as any[]).map((f) => ({
          id: f.following_id,
          username: f.profile?.username ?? 'unknown',
          avatar_url: f.profile?.avatar_url ?? null,
          status: f.status,
        }))
      );
      setMutuals(new Set());
    }
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    load();
  }, [load]);

  const removeFollower = async (row: Row) => {
    const me = myIdRef.current;
    if (!me) return;
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    await supabase.from('follows').delete().eq('follower_id', row.id).eq('following_id', me);
  };

  const unfollow = async (row: Row) => {
    const me = myIdRef.current;
    if (!me) return;
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', row.id);
  };

  const acceptRequest = async (row: Row) => {
    const me = myIdRef.current;
    if (!me) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: 'accepted' } : r)));
    await supabase.from('follows').update({ status: 'accepted' }).eq('follower_id', row.id).eq('following_id', me);
  };

  const isFollowingMode = mode === 'following';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>{isFollowingMode ? 'Following' : 'Followers'}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Pressable style={styles.pressArea} onPress={() => setPublicProfile({ id: item.id, username: item.username })}>
                <Avatar url={item.avatar_url} name={item.username} size={44} ring />
                <View style={styles.info}>
                  <Text style={styles.name}>@{item.username}</Text>
                  {mutuals.has(item.id) && (
                    <View style={styles.mutualChip}>
                      <Text style={styles.mutualText}>Mutual</Text>
                    </View>
                  )}
                </View>
              </Pressable>
              {isFollowingMode ? (
                <Pressable
                  style={[styles.actionBtn, item.status === 'pending' && styles.actionBtnPending]}
                  onPress={() => unfollow(item)}
                >
                  <Text style={[styles.actionText, item.status === 'pending' && styles.actionTextPending]}>
                    {item.status === 'pending' ? 'Requested' : 'Unfollow'}
                  </Text>
                </Pressable>
              ) : item.status === 'pending' ? (
                <View style={styles.pendingActions}>
                  <Pressable style={styles.acceptBtn} onPress={() => acceptRequest(item)}>
                    <Text style={styles.acceptText}>Accept</Text>
                  </Pressable>
                  <Pressable style={styles.actionBtnDanger} onPress={() => removeFollower(item)}>
                    <Text style={styles.actionTextDanger}>Reject</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable style={styles.actionBtnDanger} onPress={() => removeFollower(item)}>
                  <Text style={styles.actionTextDanger}>Remove</Text>
                </Pressable>
              )}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {isFollowingMode ? 'You are not following anyone yet.' : 'No followers yet.'}
            </Text>
          }
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: {
    width: 80,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 80,
  },
  loader: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  pressArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  avatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: '700',
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  mutualChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 3,
  },
  mutualText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  actionBtn: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  actionBtnPending: {
    backgroundColor: 'transparent',
    borderColor: colors.accent,
  },
  actionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  actionTextPending: {
    color: colors.accent,
  },
  pendingActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  acceptBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginRight: 8,
  },
  acceptText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
  actionBtnDanger: {
    backgroundColor: 'rgba(255,92,124,0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  actionTextDanger: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '600',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 60,
  },
});
