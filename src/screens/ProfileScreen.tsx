import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import LogoHeader from '../components/LogoHeader';
import Button from '../components/Button';
import Avatar from '../components/Avatar';
import AvatarPickerModal from '../components/AvatarPickerModal';
import PeopleScreen from './PeopleScreen';
import SettingsScreen from './SettingsScreen';

type Profile = {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  location: string | null;
  region: string | null;
  pronouns: string | null;
  verified: boolean;
  streak_count: number;
  created_at: string;
  is_private: boolean;
};

type Post = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  cover_url: string | null;
  text_bg: string | null;
  text_color: string | null;
  content: string | null;
  drop_id: string | null;
  views_count: number;
  likes_count: number;
  comments_count: number;
  expires_at: string;
  created_at: string;
};

type RepostRow = Post & { profile: { username: string; avatar_url: string | null } | null };

type Tab = 'active' | 'videos' | 'reposts' | 'saved';

const H48 = 48 * 3600 * 1000;

export default function ProfileScreen() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [reposts, setReposts] = useState<RepostRow[]>([]);
  const [saved, setSaved] = useState<Post[]>([]);
  const [followers, setFollowers] = useState(0);
  const [following, setFollowing] = useState(0);
  const [totalLikes, setTotalLikes] = useState(0);
  const [tab, setTab] = useState<Tab>('active');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [peopleMode, setPeopleMode] = useState<'followers' | 'following' | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const [{ data: prof }, { data: myPosts }, { data: repostRows }, { data: savedRows }, fw, fl] =
      await Promise.all([
        supabase
          .from('profiles')
          .select('username, display_name, bio, avatar_url, location, region, pronouns, verified, streak_count, created_at, is_private')
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('posts')
          .select('id, media_url, media_type, cover_url, text_bg, text_color, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('reposts')
          .select('post_id, post:posts!reposts_post_id_fkey(id, media_url, media_type, content, drop_id, views_count, likes_count, comments_count, expires_at, created_at, profile:profiles!posts_user_id_fkey(username, avatar_url))')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('saved_posts')
          .select('post_id, post:posts!saved_posts_post_id_fkey(id, media_url, media_type, content, drop_id, views_count, expires_at)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', user.id),
        supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', user.id),
      ]);

    setProfile((prof as Profile | null) ?? null);
    setPosts((myPosts ?? []) as Post[]);
    setReposts(((repostRows ?? []).map((r: any) => r.post).filter(Boolean)) as RepostRow[]);
    setSaved(((savedRows ?? []).map((s: any) => s.post).filter(Boolean)) as Post[]);
    setFollowing(fw.count ?? 0);
    setFollowers(fl.count ?? 0);
    setTotalLikes(((myPosts ?? []) as Post[]).reduce((sum, p) => sum + (p.likes_count ?? 0), 0));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shareProfile = () => {
    Share.share({
      message: `Check out @${profile?.username ?? 'unknown'} on Gen Z — every story, gone in 48 hours!`,
    });
  };

  const achievements = useAchievements(profile, posts, totalLikes);
  const activePosts = posts; // RLS already returns only unexpired posts

  const tabData: { [k in Tab]: (Post | RepostRow)[] } = {
    active: posts,
    videos: posts.filter((p) => p.media_type === 'video'),
    reposts: reposts,
    saved: saved,
  };

  const grid = tabData[tab];

  if (settingsOpen) return <SettingsScreen onBack={() => setSettingsOpen(false)} />;
  if (peopleMode) return <PeopleScreen mode={peopleMode} onBack={() => setPeopleMode(null)} />;

  return (
    <View style={styles.container}>
      {loading ? null : (
        <FlatList
          data={grid}
          keyExtractor={(p, i) => `${p.id}-${i}`}
          numColumns={3}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.topRow}>
                <View style={styles.topSpacer} />
                <LogoHeader compact />
                <Pressable style={styles.settingsBtn} onPress={() => setSettingsOpen(true)} hitSlop={8}>
                  <Text style={styles.settingsIcon}>⚙</Text>
                </Pressable>
              </View>

              <Avatar
                url={profile?.avatar_url}
                name={profile?.display_name || profile?.username || 'G'}
                size={94}
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
                  <Text style={styles.statNumber}>{activePosts.length}</Text>
                  <Text style={styles.statLabel}>active</Text>
                </View>
                <Pressable style={styles.stat} onPress={() => setPeopleMode('followers')}>
                  <Text style={styles.statNumber}>{followers}</Text>
                  <Text style={styles.statLabel}>followers</Text>
                </Pressable>
                <Pressable style={styles.stat} onPress={() => setPeopleMode('following')}>
                  <Text style={styles.statNumber}>{following}</Text>
                  <Text style={styles.statLabel}>following</Text>
                </Pressable>
                <View style={styles.stat}>
                  <Text style={styles.statNumber}>{totalLikes}</Text>
                  <Text style={styles.statLabel}>likes</Text>
                </View>
              </View>

              <View style={styles.btnRow}>
                <Button variant="secondary" title="Edit profile" onPress={() => setEditing(true)} style={styles.halfBtn} />
                <Button variant="secondary" title="Share profile" onPress={() => setShareOpen(true)} style={styles.halfBtn} />
              </View>

              {achievements.length > 0 && (
                <View style={styles.achievements}>
                  {achievements.map((a) => (
                    <View key={a.label} style={styles.achievement}>
                      <Text style={styles.achievementIcon}>{a.icon}</Text>
                      <Text style={styles.achievementLabel}>{a.label}</Text>
                    </View>
                  ))}
                </View>
              )}

              {activePosts.length > 0 && (
                <View style={styles.dropsSection}>
                  <Text style={styles.dropsTitle}>🔥 Active Drops</Text>
                  <FlatList
                    data={activePosts}
                    horizontal
                    keyExtractor={(p) => p.id}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => (
                      <View style={styles.dropCard}>
                        {item.cover_url || (item.media_type === 'image' && item.media_url) ? (
                          <Image
                            source={{ uri: item.cover_url ?? item.media_url! }}
                            style={styles.dropMedia}
                          />
                        ) : item.media_type === 'video' ? (
                          <View style={[styles.dropMedia, styles.dropVideoPh]}>
                            <Text style={styles.dropVideoPhText}>▶ {item.views_count}</Text>
                          </View>
                        ) : (
                          <View style={[styles.dropMedia, styles.dropTextBg, item.text_bg ? { backgroundColor: item.text_bg } : null]}>
                            <Text style={[styles.dropText, item.text_color ? { color: item.text_color } : null]} numberOfLines={3}>{item.content}</Text>
                          </View>
                        )}
                        <View style={styles.dropInfo}>
                          <Text style={styles.dropTime}>🔥 {hoursLeft(item.expires_at)}</Text>
                          <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${progressOf(item.created_at, item.expires_at)}%` }]} />
                          </View>
                        </View>
                      </View>
                    )}
                  />
                </View>
              )}

              <View style={styles.tabs}>
                {(['active', 'videos', 'reposts', 'saved'] as Tab[]).map((t) => (
                  <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
                    <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.tile}>
              {item.cover_url || (item.media_type === 'image' && item.media_url) ? (
                <Image source={{ uri: item.cover_url ?? item.media_url! }} style={styles.tileImage} />
              ) : item.media_type === 'video' ? (
                <View style={[styles.tileImage, styles.tileVideoPh]}>
                  <Text style={styles.tileVideoPhText}>▶ {item.views_count}</Text>
                </View>
              ) : (
                <View style={[styles.tileImage, styles.tileTextBg, item.text_bg ? { backgroundColor: item.text_bg } : null]}>
                  <Text style={[styles.tileText, item.text_color ? { color: item.text_color } : null]} numberOfLines={3}>{item.content}</Text>
                </View>
              )}
              {item.media_type === 'video' && (
                <View style={styles.tileBadge}>
                  <Text style={styles.tileBadgeText}>▶ {item.views_count}</Text>
                </View>
              )}
              {!!item.drop_id && (
                <View style={styles.tileDrop}>
                  <Text style={styles.tileDropText}>📦</Text>
                </View>
              )}
              {'profile' in item && item.profile && tab === 'reposts' && (
                <View style={styles.tileRepost}>
                  <Text style={styles.tileRepostText} numberOfLines={1}>↻ @{item.profile.username}</Text>
                </View>
              )}
            </View>
          )}
          ListEmptyComponent={<Text style={styles.empty}>Nothing active right now — post something before it vanishes.</Text>}
        />
      )}

      <EditProfileModal
        visible={editing}
        profile={profile}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          load();
        }}
      />

      <ShareProfileModal visible={shareOpen} profile={profile} onClose={() => setShareOpen(false)} onShare={shareProfile} />
    </View>
  );
}

function hoursLeft(expiresAt: string): string {
  const h = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 3600000));
  return `${h}h left`;
}

function progressOf(createdAt: string, expiresAt: string): number {
  const total = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
  const elapsed = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.min(100, (elapsed / total) * 100));
}

function useAchievements(profile: Profile | null, posts: Post[], totalLikes: number) {
  if (!profile) return [];
  const out: { icon: string; label: string }[] = [];
  if (profile.streak_count >= 3) out.push({ icon: '🔥', label: `${profile.streak_count} Day Streak` });
  if (posts.some((p) => p.media_type === 'video')) out.push({ icon: '🎥', label: 'Creator' });
  const comments = posts.reduce((s, p) => s + (p.comments_count ?? 0), 0);
  if (comments >= 5) out.push({ icon: '💬', label: 'Conversation Starter' });
  if (posts.some((p) => p.drop_id)) out.push({ icon: '🚀', label: 'First Drop' });
  if (totalLikes >= 25) out.push({ icon: '🌟', label: 'Rising Creator' });
  return out;
}

function EditProfileModal({ visible, profile, onClose, onSaved }: any) {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [region, setRegion] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [localAvatar, setLocalAvatar] = useState<string | null | undefined>(undefined);
  const [avatarPicker, setAvatarPicker] = useState(false);

  useEffect(() => {
    if (visible && profile) {
      setDisplayName(profile.display_name ?? '');
      setBio(profile.bio ?? '');
      setLocation(profile.location ?? '');
      setRegion(profile.region ?? '');
      setPronouns(profile.pronouns ?? '');
      setLocalAvatar(undefined);
    }
  }, [visible, profile]);

  const save = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        location: location.trim() || null,
        region: region.trim() || null,
        pronouns: pronouns.trim() || null,
      })
      .eq('id', user.id);
    onSaved();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Edit profile</Text>
          <Pressable style={styles.modalAvatarRow} onPress={() => setAvatarPicker(true)}>
            <Avatar
              url={localAvatar !== undefined ? localAvatar : profile?.avatar_url}
              name={displayName || profile?.username || 'G'}
              size={84}
              ring
            />
            <Text style={styles.modalAvatarCta}>Change avatar</Text>
          </Pressable>
          <TextInput style={styles.modalInput} placeholder="Display name" placeholderTextColor={colors.textFaint} value={displayName} onChangeText={setDisplayName} />
          <TextInput style={[styles.modalInput, styles.modalBio]} placeholder="Bio" placeholderTextColor={colors.textFaint} multiline value={bio} onChangeText={setBio} />
          <TextInput style={styles.modalInput} placeholder="Location (optional)" placeholderTextColor={colors.textFaint} value={location} onChangeText={setLocation} />
          <TextInput style={styles.modalInput} placeholder="Region for discovery (e.g. Nigeria) — never exact" placeholderTextColor={colors.textFaint} value={region} onChangeText={setRegion} />
          <TextInput style={styles.modalInput} placeholder="Pronouns (e.g. he/him)" placeholderTextColor={colors.textFaint} value={pronouns} onChangeText={setPronouns} />
          <AvatarPickerModal
            visible={avatarPicker}
            current={profile?.avatar_url}
            name={displayName || profile?.username || 'G'}
            onClose={() => setAvatarPicker(false)}
            onSaved={(value) => setLocalAvatar(value)}
          />
          <Button title="Save" onPress={save} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ShareProfileModal({ visible, profile, onClose, onShare }: any) {
  const username = profile?.username ?? 'unknown';
  const link = `genz://profile/@${username}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(link)}`;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Share your profile</Text>
          <View style={styles.qrBox}>
            <Image source={{ uri: qrUrl }} style={styles.qr} />
          </View>
          <Text style={styles.qrHandle}>@{username}</Text>
          <Text style={styles.qrLink}>{link}</Text>
          <Button title="Share profile" onPress={onShare} style={{ marginTop: 16 }} />
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingTop: TOP_INSET + 8,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 14,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 10,
  },
  topSpacer: {
    width: 36,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsIcon: {
    color: colors.textMuted,
    fontSize: 16,
  },
  avatarRing: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.glow,
  },
  avatar: {
    width: 92,
    height: 92,
    borderRadius: 46,
  },
  avatarPlaceholder: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: colors.accent,
    fontSize: 36,
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
    paddingHorizontal: 24,
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
    marginHorizontal: 16,
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
  btnRow: {
    flexDirection: 'row',
    marginTop: 16,
    width: '100%',
  },
  halfBtn: {
    width: '48%',
    marginHorizontal: '1%',
  },
  achievements: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 14,
  },
  achievement: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    margin: 3,
  },
  achievementIcon: {
    fontSize: 12,
  },
  achievementLabel: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 5,
  },
  dropsSection: {
    width: '100%',
    marginTop: 18,
  },
  dropsTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  dropCard: {
    width: 130,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginRight: 10,
  },
  dropMedia: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  dropVideoPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A1220',
  },
  dropVideoPhText: {
    color: colors.textMuted,
    fontSize: 22,
    fontWeight: '800',
  },
  tileVideoPh: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A1220',
  },
  tileVideoPhText: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: '800',
  },
  dropTextBg: {
    justifyContent: 'center',
    padding: 8,
  },
  dropText: {
    color: colors.text,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  dropInfo: {
    padding: 8,
  },
  dropTime: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
    marginTop: 18,
    width: '100%',
  },
  tab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: colors.accent,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  tabTextActive: {
    color: colors.bg,
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
  tileDrop: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: colors.accentSoft,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  tileDropText: {
    fontSize: 11,
  },
  tileRepost: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    right: 6,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tileRepostText: {
    color: colors.cyan,
    fontSize: 9,
    fontWeight: '600',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingTop: 24,
    paddingHorizontal: 30,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 22,
    paddingBottom: 36,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalAvatarRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  modalAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  modalAvatarPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalAvatarLetter: {
    color: colors.accent,
    fontSize: 32,
    fontWeight: '800',
  },
  modalAvatarCta: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  modalInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 12,
  },
  modalBio: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalCancel: {
    alignItems: 'center',
    marginTop: 12,
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  qrBox: {
    alignItems: 'center',
    marginBottom: 10,
  },
  qr: {
    width: 220,
    height: 220,
    borderRadius: radius.md,
    backgroundColor: colors.logoWhite,
  },
  qrHandle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  qrLink: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
});
