import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import Button from '../components/Button';
import Avatar from '../components/Avatar';

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  location: string | null;
  pronouns: string | null;
  verified: boolean;
  streak_count: number;
  is_private: boolean;
  created_at: string;
};

type Post = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  content: string | null;
  views_count: number;
  expires_at: string;
};

export default function PublicProfileScreen({
  userId,
  username,
  onClose,
}: {
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [followState, setFollowState] = useState<'none' | 'pending' | 'following'>('none');
  const [loading, setLoading] = useState(true);
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;

    const [prof, myFollow, fw, fl] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, display_name, bio, avatar_url, location, pronouns, verified, streak_count, is_private, created_at')
        .eq('id', userId)
        .maybeSingle(),
      supabase.from('follows').select('status').eq('follower_id', user?.id ?? '').eq('following_id', userId).maybeSingle(),
      supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', userId),
      supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', userId),
    ]);

    setProfile((prof as Profile | null) ?? null);
    setFollowState((myFollow?.data?.status as 'pending' | 'accepted') === 'accepted' ? 'following' : myFollow?.data?.status === 'pending' ? 'pending' : 'none');
    setFollowers(fw.count ?? 0);
    setFollowing(fl.count ?? 0);

    // active content — RLS hides private accounts' posts from non-followers
    const { data: postRows } = await supabase
      .from('posts')
      .select('id, media_url, media_type, content, views_count, expires_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    setPosts(((postRows ?? []) as Post[]).filter((p) => new Date(p.expires_at) > new Date()));
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFollow = async () => {
    const me = myIdRef.current;
    if (!me || me === userId) return;
    if (followState === 'following') {
      setFollowState('none');
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', userId);
    } else if (followState === 'pending') {
      setFollowState('none');
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', userId);
    } else {
      const privateAccount = profile?.is_private ?? false;
      setFollowState(privateAccount ? 'pending' : 'following');
      await supabase.from('follows').insert({
        follower_id: me,
        following_id: userId,
        status: privateAccount ? 'pending' : 'accepted',
      });
    }
  };

  const shareProfile = () => {
    Share.share({
      message: `Check out @${profile?.username ?? username} on Gen Z — every story, gone in 48 hours!`,
    });
  };

  const isOwn = myIdRef.current === userId;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn} hitSlop={8}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Profile</Text>
          <Pressable onPress={shareProfile} style={styles.shareBtn} hitSlop={8}>
            <Text style={styles.shareText}>Share</Text>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : (
          <FlatList
            data={posts}
            keyExtractor={(p) => p.id}
            numColumns={3}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <View style={styles.headerInfo}>
                <Avatar
                  url={profile?.avatar_url}
                  name={profile?.display_name || profile?.username || 'G'}
                  size={90}
                  ring
                />

                <View style={styles.nameRow}>
                  <Text style={styles.displayName}>{profile?.display_name || profile?.username || 'Gen Z user'}</Text>
                  {profile?.verified && <Text style={styles.verified}>✓</Text>}
                </View>
                <Text style={styles.username}>@{profile?.username ?? 'unknown'}</Text>
                {!!profile?.pronouns && <Text style={styles.meta}>{profile.pronouns}</Text>}
                {!!profile?.location && <Text style={styles.meta}>📍 {profile.location}</Text>}
                {!!profile?.bio && <Text style={styles.bio}>{profile.bio}</Text>}
                <Text style={styles.joinDate}>
                  Joined {new Date(profile?.created_at ?? Date.now()).toLocaleDateString([], { month: 'long', year: 'numeric' })}
                </Text>

                <View style={styles.statsRow}>
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{posts.length}</Text>
                    <Text style={styles.statLabel}>active</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{followers}</Text>
                    <Text style={styles.statLabel}>followers</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={styles.statNumber}>{following}</Text>
                    <Text style={styles.statLabel}>following</Text>
                  </View>
                </View>

                {!isOwn && (
                  <Button
                    variant={followState === 'following' ? 'ghost' : 'primary'}
                    title={
                      followState === 'following' ? 'Following' : followState === 'pending' ? 'Requested' : 'Follow'
                    }
                    onPress={toggleFollow}
                    style={styles.followBtn}
                  />
                )}

                {profile?.is_private && !isOwn && followState !== 'following' && (
                  <View style={styles.lockBox}>
                    <Text style={styles.lockText}>🔒 Private account — follow to see their stories</Text>
                  </View>
                )}
              </View>
            }
            renderItem={({ item }) => (
              <View style={styles.tile}>
                {item.media_url ? (
                  <Image source={{ uri: item.media_url }} style={styles.tileImage} />
                ) : (
                  <View style={[styles.tileImage, styles.tileTextBg]}>
                    <Text style={styles.tileText} numberOfLines={3}>{item.content}</Text>
                  </View>
                )}
                {item.media_type === 'video' && (
                  <View style={styles.tileBadge}>
                    <Icon name="play" size={10} color={colors.logoWhite} />
                    <Text style={styles.tileBadgeText}>{item.views_count}</Text>
                  </View>
                )}
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {profile?.is_private && !isOwn && followState !== 'following'
                  ? 'Follow to see their active stories.'
                  : 'No active stories right now.'}
              </Text>
            }
          />
        )}
      </View>
    </Modal>
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
    paddingHorizontal: 14,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: {
    width: 70,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  shareBtn: {
    width: 70,
    alignItems: 'flex-end',
  },
  shareText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  loader: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  headerInfo: {
    alignItems: 'center',
    marginBottom: 18,
  },
  avatarRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 3,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarPlaceholder: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 34,
    fontWeight: '800',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  displayName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '800',
  },
  verified: {
    color: colors.accent,
    fontSize: 18,
    marginLeft: 6,
    fontWeight: '700',
  },
  username: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  bio: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 30,
    lineHeight: 18,
  },
  joinDate: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 8,
  },
  statsRow: {
    flexDirection: 'row',
    marginTop: 14,
  },
  stat: {
    alignItems: 'center',
    marginHorizontal: 18,
  },
  statNumber: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  followBtn: {
    marginTop: 16,
    width: 180,
  },
  lockBox: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 14,
  },
  lockText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  tile: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileTextBg: {
    backgroundColor: colors.surfaceAlt,
    padding: 6,
    justifyContent: 'center',
  },
  tileText: {
    color: colors.text,
    fontSize: 10,
    lineHeight: 13,
    textAlign: 'center',
  },
  tileBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tileBadgeText: {
    color: colors.logoWhite,
    fontSize: 10,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingTop: 24,
  },
});
