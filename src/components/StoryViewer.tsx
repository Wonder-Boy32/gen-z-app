// ============================================================
// StoryViewer — the full-screen story surface
// ============================================================
//
// WHAT THIS IS BUILT ON
//
// This app has no separate `stories` table. A story here is what the product
// already calls a Drop: a post that expires. The avatar rail in the feed is
// therefore derived from posts (see FeedScreen's storyUsers), and this viewer
// opens the SAME rows full-screen. Nothing new is invented for it — no new
// table, no new metric, no fake viewer counts. Everything on screen comes from
// posts / likes / comments that already exist.
//
// Layout follows the reference: full-bleed media, segmented progress across the
// top, avatar + username + relative time, a vertical action rail on the right,
// and the caption with its sound pill at the bottom over a dark scrim.
//
// TIMING
//
// Images advance after 5s. A video loops (that is how DropVideoView already
// plays), so it gets a 15s budget instead of an end-of-stream signal — there is
// no onEnded callback on the shared player and adding one would mean touching
// playback code the feed also depends on. Tapping always advances immediately,
// which is the escape hatch when the timer and the video disagree.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors } from '../theme';
import { useInsets } from '../utils/useInsets';
import Avatar from './Avatar';
import { FILL } from './ui/Futuristic';
import DropVideoView, { parseDropEffects } from './DropVideoView';
import CommentsModal from './CommentsModal';
import Icon, { IconName } from './ui/Icon';
import VerifiedBadge from './ui/VerifiedBadge';
import { notifyUser } from '../utils/notify';

export type StoryUserLite = {
  id: string;
  username: string;
  avatar_url: string | null;
  verified?: boolean;
};

type StoryItem = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  cover_url?: string | null;
  caption: string | null;
  content: string | null;
  audio: string | null;
  sound: string | null;
  created_at: string;
  effects: any;
  filters: any;
  text_layers: any;
  stickers: any;
};

type Group = { user: StoryUserLite; items: StoryItem[] };

const IMAGE_MS = 5000;
const VIDEO_MS = 15000;

/** "3h", "just now" — same shape the feed uses, kept local and tiny. */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function mediaOf(item: StoryItem): { url: string | null; type: 'video' | 'image' } {
  const first = Array.isArray(item.media_items) ? item.media_items[0] : null;
  const url = first?.url ?? item.media_url ?? item.cover_url ?? null;
  const type = (first?.type as 'video' | 'image' | undefined) ?? item.media_type ?? 'image';
  return { url, type };
}

export default function StoryViewer({
  users,
  startIndex,
  onClose,
  onOpenProfile,
}: {
  users: StoryUserLite[];
  startIndex: number;
  onClose: () => void;
  onOpenProfile?: (userId: string) => void;
}) {
  const insets = useInsets();
  const [groups, setGroups] = useState<Group[]>([]);
  const [gi, setGi] = useState(0);
  const [ii, setIi] = useState(0);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [commentId, setCommentId] = useState<string | null>(null);
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const meRef = useRef<string | null>(null);
  const bar = useRef(new Animated.Value(0)).current;

  // ---- data -------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      meRef.current = auth?.user?.id ?? null;

      const ids = users.map((u) => u.id);
      if (!ids.length) {
        if (alive) setLoading(false);
        return;
      }
      const { data } = await supabase
        .from('posts')
        .select(
          'id, user_id, media_url, media_type, media_items, cover_url, caption, content, audio, sound, created_at, effects, filters, text_layers, stickers'
        )
        .in('user_id', ids)
        .is('parent_drop_id', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true })
        .limit(80);

      if (!alive) return;
      const rows = (data ?? []) as StoryItem[];
      const byUser = new Map<string, StoryItem[]>();
      rows.forEach((r) => {
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
        byUser.get(r.user_id)!.push(r);
      });

      // keep the rail's own order; drop anyone whose drops have all expired or
      // were removed between the fetch that built the rail and this one
      const next: Group[] = [];
      users.forEach((u) => {
        const items = byUser.get(u.id);
        if (items?.length) next.push({ user: u, items });
      });

      setGroups(next);
      // start on the tapped person when they still have something live
      const wanted = Math.max(0, Math.min(startIndex, users.length - 1));
      const at = next.findIndex((g) => g.user.id === users[wanted]?.id);
      setGi(at >= 0 ? at : 0);
      setIi(0);
      setLoading(false);
      if (meRef.current && rows.length) {
        const mine = new Set<string>();
        const { data: myLikes } = await supabase
          .from('likes')
          .select('post_id')
          .in('post_id', rows.map((r) => r.id))
          .eq('user_id', meRef.current);
        (myLikes ?? []).forEach((l: any) => mine.add(l.post_id));
        if (alive && mine.size) {
          const map: Record<string, boolean> = {};
          mine.forEach((id) => (map[id] = true));
          setLiked(map);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const group = groups[gi];
  const item = group?.items[ii];

  // ---- advancing --------------------------------------------------------
  const next = useCallback(() => {
    if (!groups.length) return onClose();
    const g = groups[gi];
    if (ii + 1 < g.items.length) {
      setIi(ii + 1);
      return;
    }
    if (gi + 1 < groups.length) {
      setGi(gi + 1);
      setIi(0);
      return;
    }
    onClose();
  }, [groups, gi, ii, onClose]);

  const prev = useCallback(() => {
    if (!groups.length) return;
    if (ii > 0) return setIi(ii - 1);
    if (gi > 0) {
      setGi(gi - 1);
      setIi(groups[gi - 1].items.length - 1);
    }
  }, [groups, gi, ii]);

  // ---- progress ---------------------------------------------------------
  useEffect(() => {
    if (!item) return;
    const ms = mediaOf(item).type === 'video' ? VIDEO_MS : IMAGE_MS;
    bar.setValue(0);
    if (paused) return; // resume restarts the segment from where it stopped
    const anim = Animated.timing(bar, {
      toValue: 1,
      duration: ms,
      easing: Easing.linear,
      useNativeDriver: false, // width is not a transform
    });
    anim.start(({ finished }) => {
      if (finished) next();
    });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gi, ii, paused, item?.id]);

  // ---- actions ----------------------------------------------------------
  const toggleLike = async () => {
    const me = meRef.current;
    if (!me || !item) return;
    const on = !!liked[item.id];
    setLiked((p) => ({ ...p, [item.id]: !on }));
    if (on) {
      await supabase.from('likes').delete().eq('post_id', item.id).eq('user_id', me);
    } else {
      await supabase.from('likes').insert({ post_id: item.id, user_id: me });
      notifyUser({ userId: item.user_id, actorId: me, type: 'like', postId: item.id });
    }
  };

  const share = () => {
    if (!item || !group) return;
    Share.share({
      message: `@${group.user.username} on Gen Z — ${item.caption ?? item.content ?? 'a drop'}`,
    });
  };

  const shareLink = () => {
    if (!group) return;
    Share.share({ message: `genz://profile/@${group.user.username}` });
  };

  const segments = useMemo(() => group?.items ?? [], [group]);
  const caption = item ? item.caption || item.content || '' : '';

  return (
    <View style={styles.fill}>
      {/* media ------------------------------------------------------- */}
      {item &&
        (() => {
          const m = mediaOf(item);
          if (!m.url) return <View style={[styles.fill, { backgroundColor: '#05070F' }]} />;
          if (m.type === 'video') {
            return (
              <DropVideoView
                url={m.url}
                effects={parseDropEffects(item.effects)}
                filters={item.filters}
                textLayers={item.text_layers}
                stickers={item.stickers}
                isActive
                paused={paused}
                showProgress={false}
                showMute={false}
                onTap={next}
                onHoldStart={() => setPaused(true)}
                onHoldEnd={() => setPaused(false)}
                style={StyleSheet.absoluteFill}
              />
            );
          }
          return (
            <Image
              source={{ uri: m.url }}
              style={StyleSheet.absoluteFill as any}
              resizeMode="cover"
            />
          );
        })()}

      {/* scrims — the header and caption have to stay legible over any media */}
      <View style={[styles.scrim, { height: 150 }]} pointerEvents="none">
        {[0.62, 0.55, 0.46, 0.36, 0.26, 0.17, 0.09, 0.03].map((o, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgba(4,6,14,${o})` }} />
        ))}
      </View>
      <View style={[styles.scrimBottom, { height: 300 }]} pointerEvents="none">
        {[0, 0.05, 0.12, 0.22, 0.34, 0.46, 0.56, 0.62].map((o, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgba(4,6,14,${o})` }} />
        ))}
      </View>

      {/* Tap zones — above the media, below the controls. Holding either one
          pauses, which is how you read a caption that is about to disappear. */}
      <Pressable
        style={styles.tapLeft}
        onPress={prev}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
        delayLongPress={280}
        accessibilityLabel="Previous story"
      />
      <Pressable
        style={styles.tapRight}
        onPress={next}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
        delayLongPress={280}
        accessibilityLabel="Next story"
      />

      {/* progress + header ---------------------------------------------- */}
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <View style={styles.segments}>
          {segments.map((s, i) => (
            <View key={s.id} style={styles.segmentTrack}>
              <Animated.View
                style={[
                  styles.segmentFill,
                  {
                    width:
                      i < ii
                        ? '100%'
                        : i > ii
                        ? '0%'
                        : bar.interpolate({
                            inputRange: [0, 1],
                            outputRange: ['0%', '100%'],
                          }),
                  },
                ]}
              />
            </View>
          ))}
        </View>

        <View style={styles.headerRow}>
          <Pressable
            style={styles.headerLeft}
            onPress={() => group && onOpenProfile?.(group.user.id)}
            hitSlop={6}
            accessibilityLabel={`Open ${group?.user.username ?? ''}'s profile`}
          >
            <Avatar
              url={group?.user.avatar_url}
              name={group?.user.username ?? 'G'}
              size={34}
            />
            <View style={styles.headerText}>
              <View style={styles.nameRow}>
                <Text style={styles.username} numberOfLines={1}>
                  {group?.user.username ?? ''}
                </Text>
                {!!group?.user.verified && <VerifiedBadge size={11} glow={false} />}
              </View>
              <Text style={styles.time}>{item ? ago(item.created_at) : ''}</Text>
            </View>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close story">
            <Icon name="close" size={22} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>

      {/* right rail ------------------------------------------------------ */}
      <View style={[styles.rail, { bottom: insets.bottom + 150 }]}>
        <RailButton
          icon={liked[item?.id ?? ''] ? 'heart' : 'heart-outline'}
          label={liked[item?.id ?? ''] ? 'Liked' : 'Like'}
          onPress={toggleLike}
          active={!!liked[item?.id ?? '']}
        />
        <RailButton icon="chatbubble-ellipses-outline" label="Comment" onPress={() => item && setCommentId(item.id)} />
        <RailButton icon="paper-plane-outline" label="Share" onPress={share} />
        <RailButton icon="link-outline" label="Link" onPress={shareLink} />
      </View>

      {/* caption --------------------------------------------------------- */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 26 }]} pointerEvents="box-none">
        {!!caption && (
          <Text style={styles.caption} numberOfLines={3}>
            {caption}
          </Text>
        )}
        {!!(item?.audio || item?.sound) && (
          <View style={styles.soundPill}>
            <Icon name="musical-notes" size={13} color="#FFFFFF" />
            <Text style={styles.soundText} numberOfLines={1}>
              {item?.audio ?? item?.sound}
            </Text>
          </View>
        )}
      </View>

      {loading && (
        <View style={styles.loading} pointerEvents="none">
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      )}

      <CommentsModal
        post={commentId ? { id: commentId } : null}
        onClose={() => setCommentId(null)}
        onPosted={() => {
          // the story viewer shows no comment count, so there is nothing to
          // increment; the notification is sent by CommentsModal's own composer
        }}
      />
    </View>
  );
}

function RailButton({
  icon,
  label,
  onPress,
  active,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable style={styles.railBtn} onPress={onPress} hitSlop={8} accessibilityLabel={label}>
      <Icon name={icon} size={24} color={active ? '#FF3D7F' : '#FFFFFF'} />
      <Text style={styles.railLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { ...FILL, backgroundColor: '#04060E' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  tapLeft: { position: 'absolute', left: 0, top: 120, bottom: 140, width: '32%' },
  tapRight: { position: 'absolute', right: 0, top: 120, bottom: 140, left: '32%' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12 },
  segments: { flexDirection: 'row', gap: 4, marginBottom: 12 },
  segmentTrack: {
    flex: 1,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
  },
  segmentFill: { height: 2.5, borderRadius: 2, backgroundColor: '#FFFFFF' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  headerText: { flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  username: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  time: { color: 'rgba(255,255,255,0.68)', fontSize: 11.5, marginTop: 1 },
  closeBtn: { padding: 4, marginLeft: 8 },
  rail: { position: 'absolute', right: 10, alignItems: 'center', gap: 20 },
  railBtn: { alignItems: 'center', gap: 4, minWidth: 52 },
  railLabel: { color: 'rgba(255,255,255,0.82)', fontSize: 10.5, fontWeight: '700' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18 },
  caption: { color: '#FFFFFF', fontSize: 14, lineHeight: 20, fontWeight: '600' },
  soundPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    maxWidth: '80%',
  },
  soundText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '600', flexShrink: 1 },
  loading: { ...FILL, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: colors.textMuted, fontSize: 13 },
});
