import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Avatar from './Avatar';
import Icon from './ui/Icon';
import { notifyUser } from '../utils/notify';
import { fmtCount } from './FeedPost';

type PeekProfile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_private: boolean;
  verified: boolean;
};

type PeekPost = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  expires_at: string;
  likes_count: number;
};

const H = 3600 * 1000;

function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / H);
  if (h >= 24) return `${h}h`;
  return `${h}h ${Math.floor((ms % H) / 60000)}m`;
}

export default function ProfilePeekModal({
  user,
  onClose,
  onOpenFull,
}: {
  user: { id: string; username: string } | null;
  onClose: () => void;
  onOpenFull: (id: string, username: string) => void;
}) {
  const [profile, setProfile] = useState<PeekProfile | null>(null);
  const [posts, setPosts] = useState<PeekPost[]>([]);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const me = (await supabase.auth.getUser()).data.user;
      const [p, fw, ps, fs] = await Promise.all([
        supabase.from('profiles').select('id, username, display_name, avatar_url, bio, is_private, verified').eq('id', user.id).maybeSingle(),
        supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', user.id),
        supabase
          .from('posts')
          .select('id, media_url, media_type, content, expires_at, likes_count')
          .eq('user_id', user.id)
          .is('parent_drop_id', null)
          .order('created_at', { ascending: false })
          .limit(6),
        me ? supabase.from('follows').select('status').eq('follower_id', me.id).eq('following_id', user.id).maybeSingle() : null,
      ]);
      setProfile((p.data as unknown as PeekProfile) ?? null);
      setFollowers(fw.count ?? 0);
      setPosts((ps.data ?? []) as unknown as PeekPost[]);
      setFollowing(!!fs?.data);
      setLoading(false);
    })();
  }, [user?.id]);

  const toggleFollow = async () => {
    const me = (await supabase.auth.getUser()).data.user;
    if (!me || !user || !profile) return;
    if (following) {
      await supabase.from('follows').delete().eq('follower_id', me.id).eq('following_id', user.id);
      setFollowing(false);
    } else {
      await supabase
        .from('follows')
        .insert({ follower_id: me.id, following_id: user.id, status: profile.is_private ? 'pending' : 'accepted' });
      setFollowing(true);
      if (!profile.is_private) {
        notifyUser({ userId: user.id, actorId: me.id, type: 'follow' });
      }
    }
  };

  return (
    <Modal visible={!!user} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {loading || !profile ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <>
              <View style={styles.topRow}>
                <Avatar url={profile.avatar_url} name={profile.display_name || profile.username} size={64} ring />
                <View style={styles.ident}>
                  <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>
                      {profile.display_name || profile.username}
                    </Text>
                    {profile.verified && <Text style={styles.verified}>✓</Text>}
                  </View>
                  <Text style={styles.username}>@{profile.username}</Text>
                  {!!profile.bio && <Text style={styles.bio} numberOfLines={1}>{profile.bio}</Text>}
                </View>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.stat}>
                  <Text style={styles.statNum}>{followers}</Text>
                  <Text style={styles.statLabel}>followers</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={styles.statNum}>{posts.length}</Text>
                  <Text style={styles.statLabel}>active Drops</Text>
                </View>
              </View>

              <View style={styles.btnRow}>
                <Pressable style={[styles.followBtn, following && styles.followBtnActive]} onPress={toggleFollow}>
                  <Text style={[styles.followBtnText, following && styles.followBtnTextActive]}>
                    {following ? 'Following' : profile.is_private ? 'Request' : 'Follow'}
                  </Text>
                </Pressable>
                <Pressable style={styles.fullBtn} onPress={() => onOpenFull(user!.id, user!.username)}>
                  <Text style={styles.fullBtnText}>View full profile →</Text>
                </Pressable>
              </View>

              {posts.length > 0 && (
                <>
                  <View style={styles.sectionTitleRow}>
                    <Icon name="flame" size={15} color={colors.accent} />
                    <Text style={styles.dropsTitle}>Active Drops</Text>
                  </View>
                  <FlatList
                    data={posts}
                    horizontal
                    keyExtractor={(p) => p.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => (
                      <View style={styles.tile}>
                        {item.media_url ? (
                          <Image source={{ uri: item.media_url }} style={styles.tileMedia} resizeMode="cover" />
                        ) : (
                          <View style={[styles.tileMedia, styles.tileTextBg]}>
                            <Text style={styles.tileText} numberOfLines={3}>{item.content ?? ''}</Text>
                          </View>
                        )}
                        <View style={styles.tileTimeRow}>
                          <Icon name="flame" size={10} color={colors.accent} />
                          <Text style={styles.tileTime}>{timeLeft(item.expires_at)}</Text>
                        </View>
                      </View>
                    )}
                  />
                </>
              )}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.xl,
    padding: 18,
    ...shadows.glow,
  },
  loader: {
    paddingVertical: 40,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ident: {
    flex: 1,
    marginLeft: 12,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  verified: {
    color: colors.accent,
    fontSize: 14,
    marginLeft: 4,
    fontWeight: '800',
  },
  username: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 1,
  },
  bio: {
    color: colors.text,
    fontSize: 12,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 24,
  },
  stat: {
    alignItems: 'center',
  },
  statNum: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  btnRow: {
    flexDirection: 'row',
    marginTop: 14,
    gap: 10,
  },
  followBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 20,
    paddingVertical: 9,
    ...shadows.glow,
  },
  followBtnActive: {
    backgroundColor: 'rgba(255,122,0,0.15)',
  },
  followBtnText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '800',
  },
  followBtnTextActive: {
    color: colors.accent,
  },
  fullBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
  },
  fullBtnText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '700',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 18,
    marginBottom: 8,
  },
  dropsTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  tile: {
    width: 84,
    height: 110,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginRight: 8,
    backgroundColor: '#000',
  },
  tileMedia: {
    width: '100%',
    height: '100%',
  },
  tileTextBg: {
    backgroundColor: '#101A33',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  tileText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  tileTimeRow: {
    position: 'absolute',
    bottom: 5,
    left: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tileTime: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: '700',
  },
});
