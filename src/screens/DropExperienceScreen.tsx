import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import DropVideoView from '../components/DropVideoView';
import Icon from '../components/ui/Icon';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import DropCountdown from '../components/DropCountdown';
import CommentsModal from '../components/CommentsModal';
import { fmtCount } from '../components/FeedPost';

type Drop = {
  id: string;
  prompt: string;
  status: 'scheduled' | 'live' | 'voting' | 'closed';
  starts_at: string;
  ends_at: string;
  voting_ends_at: string;
};

type Sub = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  cover_url: string | null;
  text_bg: string | null;
  text_color: string | null;
  media_items: { url: string; type: string }[] | null;
  content: string | null;
  caption: string | null;
  audio: string | null;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
  likes_count: number;
  comments_count: number;
  views_count: number;
  expires_at: string;
  profile: { username: string; avatar_url: string | null } | null;
  liked_by_me: boolean;
  my_reaction: string | null;
  reactions_count: number;
};

const REACTIONS = ['🔥', '😂', '😮', '💯'];

type Props = {
  drop: Drop;
  onClose: () => void;
  onViewAll: () => void;
  onJoin: () => void;
};

export default function DropExperienceScreen({ drop, onClose, onViewAll, onJoin }: Props) {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Sub | null>(null);
  const [commenting, setCommenting] = useState<Sub | null>(null);
  const myIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;

    const { data, error } = await supabase
      .from('posts')
      .select('*, profile:profiles!posts_user_id_fkey(username, avatar_url)')
      .eq('drop_id', drop.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.warn('drop load error', error.message);
      return;
    }
    const rows = (data ?? []) as Sub[];
    const ids = rows.map((s) => s.id);

    let liked = new Set<string>();
    let myReaction = new Map<string, string>();
    let counts = new Map<string, number>();
    if (user && ids.length) {
      const [l, r] = await Promise.all([
        supabase.from('likes').select('post_id').in('post_id', ids).eq('user_id', user.id),
        supabase.from('post_reactions').select('post_id, user_id, reaction').in('post_id', ids),
      ]);
      liked = new Set((l.data ?? []).map((x) => x.post_id));
      (r.data ?? []).forEach((x: any) => {
        if (x.user_id === user.id) myReaction.set(x.post_id, x.reaction);
        counts.set(x.post_id, (counts.get(x.post_id) ?? 0) + 1);
      });
    }

    setSubs(
      rows.map((s) => ({
        ...s,
        liked_by_me: liked.has(s.id),
        my_reaction: myReaction.get(s.id) ?? null,
        reactions_count: counts.get(s.id) ?? 0,
      }))
    );
    setLoading(false);
  }, [drop.id]);

  useEffect(() => {
    load();
  }, [load]);

  const participants = new Set(subs.map((s) => s.user_id)).size;
  const trending = [...subs].sort(
    (a, b) =>
      b.likes_count + b.comments_count + b.reactions_count - (a.likes_count + a.comments_count + a.reactions_count)
  );
  const grid = drop.status === 'closed' ? trending : subs;

  const winners = useMemo(() => {
    if (!subs.length || (drop.status !== 'voting' && drop.status !== 'closed')) return [];
    const byLikes = [...subs].sort((a, b) => b.likes_count - a.likes_count)[0];
    const byViews = [...subs].sort((a, b) => b.views_count - a.views_count)[0];
    const byComments = [...subs].sort((a, b) => b.comments_count - a.comments_count)[0];
    const randomSpot = subs[Math.floor(Math.random() * subs.length)];
    return [
      { label: 'Most liked', sub: byLikes, metric: `${fmtCount(byLikes.likes_count)} likes` },
      { label: 'Most viewed', sub: byViews, metric: `${fmtCount(byViews.views_count)} views` },
      { label: 'Most talked about', sub: byComments, metric: `${fmtCount(byComments.comments_count)} comments` },
      { label: 'Random spotlight', sub: randomSpot, metric: 'community pick' },
    ];
  }, [subs, drop.status]);

  const toggleLike = async (s: Sub) => {
    const me = myIdRef.current;
    if (!me) return;
    setSubs((prev) =>
      prev.map((x) =>
        x.id === s.id ? { ...x, liked_by_me: !x.liked_by_me, likes_count: x.likes_count + (x.liked_by_me ? -1 : 1) } : x
      )
    );
    if (s.liked_by_me) {
      await supabase.from('likes').delete().eq('post_id', s.id).eq('user_id', me);
    } else {
      await supabase.from('likes').insert({ post_id: s.id, user_id: me });
    }
  };

  const cycleReaction = async (s: Sub) => {
    const me = myIdRef.current;
    if (!me) return;
    const next = !s.my_reaction
      ? REACTIONS[0]
      : REACTIONS[(REACTIONS.indexOf(s.my_reaction) + 1) % REACTIONS.length] === s.my_reaction
        ? ''
        : REACTIONS[(REACTIONS.indexOf(s.my_reaction) + 1) % REACTIONS.length];
    setSubs((prev) =>
      prev.map((x) =>
        x.id === s.id
          ? {
              ...x,
              my_reaction: next || null,
              reactions_count: x.reactions_count - (x.my_reaction ? 1 : 0) + (next ? 1 : 0),
            }
          : x
      )
    );
    await supabase.from('post_reactions').delete().eq('post_id', s.id).eq('user_id', me);
    if (next) await supabase.from('post_reactions').insert({ post_id: s.id, user_id: me, reaction: next });
  };

  const isLive = drop.status === 'live';
  const isVoting = drop.status === 'voting';

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <Text style={styles.closeText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.headerTitle}>GEN Z DROP</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <Text style={[styles.statusChip, isLive && styles.statusLive, isVoting && styles.statusVoting]}>
              {isLive ? '● LIVE NOW' : isVoting ? '🗳 VOTING' : '💨 CLOSED'}
            </Text>
            <Text style={styles.prompt}>“{drop.prompt}”</Text>
            <DropCountdown
              endsAt={isLive ? drop.ends_at : drop.voting_ends_at}
              mode={drop.status}
              big
            />
            <Text style={styles.participants}>{participants} participant{participants === 1 ? '' : 's'}</Text>
          </View>

          {isLive && (
            <View style={styles.actions}>
              <Pressable style={styles.joinBtn} onPress={onJoin}>
                <Text style={styles.joinBtnText}>Join now →</Text>
              </Pressable>
              <Pressable style={styles.viewAllBtn} onPress={onViewAll}>
                <Text style={styles.viewAllText}>Browse all submissions</Text>
              </Pressable>
            </View>
          )}
          {!isLive && subs.length > 0 && (
            <Pressable style={styles.viewAllBtnWide} onPress={onViewAll}>
              <Text style={styles.viewAllText}>Browse all submissions</Text>
            </Pressable>
          )}

          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <>
              <Text style={styles.sectionTitle}>
                {isLive ? 'Live submissions' : isVoting ? 'Submissions — voting now' : 'All submissions'}
              </Text>
              {grid.length === 0 ? (
                <Text style={styles.empty}>No submissions yet. Be the first.</Text>
              ) : (
                <FlatList
                  data={grid}
                  keyExtractor={(s) => s.id}
                  numColumns={3}
                  scrollEnabled={false}
                  renderItem={({ item }) => (
                    <Pressable style={styles.tile} onPress={() => setSelected(item)}>
                      <TileMedia sub={item} />
                      {item.likes_count > 0 && (
                        <View style={styles.tileCount}>
                          <Icon name="heart" size={10} color={colors.danger} />
                          <Text style={styles.tileCountText}>{fmtCount(item.likes_count)}</Text>
                        </View>
                      )}
                    </Pressable>
                  )}
                />
              )}

              {!isLive && winners.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>{drop.status === 'voting' ? 'Podium forming' : '🏆 Drop results'}</Text>
                  {winners.map((w, i) => (
                    <View key={i} style={styles.winnerCard}>
                      <Text style={styles.winnerLabel}>{w.label}</Text>
                      {w.sub && (
                        <View style={styles.winnerRow}>
                          <View style={styles.winnerThumb}>
                            <TileMedia sub={w.sub} small />
                          </View>
                          <View style={styles.winnerInfo}>
                            <Text style={styles.winnerUser}>@{w.sub.profile?.username ?? 'unknown'}</Text>
                            <Text style={styles.winnerMetric}>{w.metric}</Text>
                          </View>
                        </View>
                      )}
                    </View>
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      </View>

      <DetailModal
        sub={selected}
        onClose={() => setSelected(null)}
        onLike={() => selected && toggleLike(selected)}
        onReact={() => selected && cycleReaction(selected)}
        onComment={() => {
          setCommenting(selected);
        }}
      />

      <CommentsModal
        post={commenting}
        onClose={() => setCommenting(null)}
        onPosted={() => {
          setSubs((prev) =>
            prev.map((x) => (x.id === commenting?.id ? { ...x, comments_count: x.comments_count + 1 } : x))
          );
        }}
      />
    </Modal>
  );
}

function TileMedia({ sub, small }: { sub: Sub; small?: boolean }) {
  if (sub.media_type === 'video' && sub.media_url) {
    return (
      <View style={styles.tileImage}>
        <Image source={{ uri: sub.media_url }} style={styles.tileImage} resizeMode="cover" />
        <View style={styles.tileVideoBadge}>
          <Icon name="play" size={14} color={colors.logoWhite} />
        </View>
      </View>
    );
  }
  const src = sub.cover_url || (sub.media_type === 'image' ? sub.media_url : null);
  if (src) {
    return <Image source={{ uri: src }} style={styles.tileImage} resizeMode="cover" />;
  }
  if (sub.media_type === 'video') {
  return (
    <View style={[styles.tileImage, styles.tileTextBg, sub.text_bg ? { backgroundColor: sub.text_bg } : null]}>
      <Text style={[styles.tileText, sub.text_color ? { color: sub.text_color } : null]} numberOfLines={3}>{sub.content}</Text>
    </View>
  );
  }
  if (sub.media_url) {
    return <Image source={{ uri: sub.media_url }} style={styles.tileImage} resizeMode="cover" />;
  }
  return (
    <View style={[styles.tileImage, styles.tileTextBg]}>
      <Text style={[styles.tileText, small && styles.tileTextSmall]} numberOfLines={3}>
        {sub.content}
      </Text>
    </View>
  );
}

function DetailModal({
  sub,
  onClose,
  onLike,
  onReact,
  onComment,
}: {
  sub: Sub | null;
  onClose: () => void;
  onLike: () => void;
  onReact: () => void;
  onComment: () => void;
}) {
  return (
    <Modal visible={!!sub} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.detailOverlay}>
        {sub && (
          <>
            <Pressable style={styles.detailClose} onPress={onClose} hitSlop={10}>
              <Text style={styles.detailCloseText}>✕</Text>
            </Pressable>
            <View style={styles.detailMedia}>
              {sub.media_type === 'video' && sub.media_url ? (
                <DropVideoView
                  url={sub.media_url}
                  effects={sub.effects}
                  filters={sub.filters}
                  textLayers={sub.text_layers}
                  stickers={sub.stickers}
                  isActive
                  contentFit="contain"
                  showProgress={false}
                  showMute={false}
                />
              ) : sub.media_url ? (
                <Image source={{ uri: sub.media_url }} style={styles.detailMedia} resizeMode="contain" />
              ) : (
                <View style={[styles.detailMedia, styles.detailTextBg]}>
                  <Text style={styles.detailText}>{sub.content}</Text>
                </View>
              )}
            </View>
            <View style={styles.detailInfo}>
              <Text style={styles.detailUser}>@{sub.profile?.username ?? 'unknown'}</Text>
              {!!sub.caption && <Text style={styles.detailCaption}>{sub.caption}</Text>}
              {!!sub.audio && (
                <View style={styles.detailAudioRow}>
                  <Icon name="musical-note" size={12} color={colors.cyan} />
                  <Text style={styles.detailAudio}>{sub.audio}</Text>
                </View>
              )}
              <View style={styles.detailActions}>
                <Pressable style={styles.detailAction} onPress={onLike} hitSlop={8}>
                  <Icon
                    name={sub.liked_by_me ? 'heart' : 'heart-outline'}
                    size={22}
                    color={sub.liked_by_me ? colors.danger : colors.logoWhite}
                  />
                  <Text style={styles.detailActionLabel}>{fmtCount(sub.likes_count)}</Text>
                </Pressable>
                <Pressable style={styles.detailAction} onPress={onReact} hitSlop={8}>
                  {sub.my_reaction ? (
                    <Text style={[styles.detailActionIcon, styles.detailActionActive]}>{sub.my_reaction}</Text>
                  ) : (
                    <Icon name="sparkles" size={21} color={colors.logoWhite} />
                  )}
                  {sub.reactions_count > 0 && (
                    <Text style={styles.detailActionLabel}>{fmtCount(sub.reactions_count)}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.detailAction} onPress={onComment} hitSlop={8}>
                  <Icon name="chatbubble-ellipses-outline" size={21} color={colors.logoWhite} />
                  <Text style={styles.detailActionLabel}>{fmtCount(sub.comments_count)}</Text>
                </Pressable>
                <Text style={styles.detailViews}>{fmtCount(sub.views_count)} views</Text>
              </View>
            </View>
          </>
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
    paddingHorizontal: 12,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  closeBtn: {
    width: 80,
  },
  closeText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2,
  },
  headerSpacer: {
    width: 80,
  },
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  hero: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.xl,
    padding: 22,
    alignItems: 'center',
    ...shadows.glow,
  },
  statusChip: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  statusLive: {
    color: colors.danger,
  },
  statusVoting: {
    color: colors.violet,
  },
  prompt: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 32,
  },
  participants: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 14,
  },
  actions: {
    flexDirection: 'row',
    marginTop: 16,
  },
  joinBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
    ...shadows.glow,
  },
  joinBtnText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '700',
  },
  viewAllBtn: {
    flex: 1,
    marginLeft: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
  },
  viewAllBtnWide: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  viewAllText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  loader: {
    paddingVertical: 40,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 24,
    marginBottom: 12,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
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
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  videoPh: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A1220' },
  videoPhText: { color: colors.textMuted, fontSize: 18, fontWeight: '800' },
  tileText: {
    color: colors.text,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  tileTextSmall: {
    fontSize: 9,
  },
  tileVideoBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  tileVideoIcon: {
    color: colors.logoWhite,
    fontSize: 10,
  },
  tileCount: {
    position: 'absolute',
    bottom: 5,
    left: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.overlay,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tileCountText: {
    color: colors.logoWhite,
    fontSize: 10,
    fontWeight: '700',
  },
  winnerCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 10,
  },
  winnerLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  winnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  winnerThumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  winnerInfo: {
    marginLeft: 12,
    flex: 1,
  },
  winnerUser: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  winnerMetric: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  detailOverlay: {
    flex: 1,
    backgroundColor: 'rgba(3,6,14,0.92)',
    justifyContent: 'center',
    padding: 20,
  },
  detailClose: {
    position: 'absolute',
    top: 54,
    right: 20,
    zIndex: 10,
  },
  detailCloseText: {
    color: colors.text,
    fontSize: 22,
  },
  detailMedia: {
    width: '100%',
    height: '62%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  detailTextBg: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  detailText: {
    color: colors.text,
    fontSize: 18,
    lineHeight: 26,
    textAlign: 'center',
    fontWeight: '600',
  },
  detailInfo: {
    marginTop: 16,
  },
  detailUser: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  detailCaption: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
  },
  detailAudioRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  detailAudio: {
    color: colors.cyan,
    fontSize: 13,
  },
  detailActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
  },
  detailAction: {
    alignItems: 'center',
    marginRight: 22,
  },
  detailActionIcon: {
    color: colors.logoWhite,
    fontSize: 24,
  },
  detailActionActive: {
    color: colors.accent,
  },
  detailActionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  detailViews: {
    color: colors.textFaint,
    fontSize: 12,
    marginLeft: 'auto',
  },
});
