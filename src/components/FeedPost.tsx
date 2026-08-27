import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewToken,
} from 'react-native';
import DropVideoView, { DropEffects, DropSticker, DropTextLayer } from './DropVideoView';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { colors, shadows } from '../theme';
import Avatar from './Avatar';
import Icon, { IconName } from './ui/Icon';

export type FeedPost = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  content: string | null;
  audio: string | null;
  sound: string | null;
  sound_url: string | null;
  sound_start: number | null;
  sound_end: number | null;
  caption: string | null;
  effects: DropEffects | null;
  filters: { id?: string; label?: string }[] | null;
  text_layers: DropTextLayer[] | null;
  stickers: DropSticker[] | null;
  text_bg: string | null;
  text_color: string | null;
  likes_count: number;
  comments_count: number;
  views_count: number;
  created_at: string;
  expires_at: string;
  drop_id: string | null;
  profile: { username: string; avatar_url: string | null; is_private: boolean } | null;
  liked_by_me: boolean;
  following: boolean;
  follow_pending: boolean;
  saved_by_me: boolean;
  reposted_by_me: boolean;
  my_reaction: string | null;
  reactions_count: number;
  pulse?: { views30: number; likes30: number; comments30: number; rising: boolean; trending: boolean } | null;
  responses_count?: number;
  reasons?: string[];
};

const REACTIONS = ['🔥', '😂', '😮', '💯'];

type Props = {
  post: FeedPost;
  isActive: boolean;
  height: number;
  contentTop?: number;
  contentBottom?: number;
  onLike: () => void;
  onFollow: () => void;
  onComment: () => void;
  onShare: () => void;
  onSave: () => void;
  onRepost: () => void;
  onOpenProfile: () => void;
  onReact: (r: string) => void;
  onMenuAction: (action: 'hide' | 'mute' | 'block' | 'notinterested' | 'report' | 'delete') => void;
  onOpenSound: () => void;
  onOpenChain: () => void;
  onExpired: () => void;
  onReplyWithDrop: () => void;
};

export function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${n}`;
}

export default function FeedPost({
  post,
  isActive,
  height,
  contentTop = 0,
  contentBottom = 0,
  onLike,
  onFollow,
  onComment,
  onShare,
  onSave,
  onRepost,
  onOpenProfile,
  onReact,
  onMenuAction,
  onOpenSound,
  onOpenChain,
  onExpired,
  onReplyWithDrop,
}: Props) {
  const lastTap = useRef(0);
  const heartAnim = useRef(new Animated.Value(0)).current;
  const [holdPause, setHoldPause] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showReasons, setShowReasons] = useState(false);

  // ---------- attached sound track (plays on video, photo AND text drops) ----------
  const soundUrl = post.sound_url;
  const soundPlayer = useAudioPlayer(soundUrl ?? null);
  const soundStatus = useAudioPlayerStatus(soundPlayer);
  const soundActive = isActive && !holdPause && !!post.sound_url;

  useEffect(() => {
    if (soundActive) {
      const st = post.sound_start ?? 0;
      const ct = soundStatus.currentTime;
      const end = post.sound_end;
      if (ct < st || (end && ct >= end)) soundPlayer.seekTo(st);
      soundPlayer.play();
    } else {
      soundPlayer.pause();
    }
  }, [soundActive, post.sound_start, post.sound_end, post.sound_url, soundPlayer]);

  // auto-stop at the trimmed end, ready to loop from the start
  useEffect(() => {
    if (soundStatus.playing && post.sound_end && soundStatus.currentTime >= post.sound_end - 0.15) {
      soundPlayer.pause();
      soundPlayer.seekTo(post.sound_start ?? 0);
    }
  }, [soundStatus.currentTime, soundStatus.playing, post.sound_end, post.sound_start, soundPlayer]);

  const showHeart = () => {
    heartAnim.setValue(0);
    Animated.sequence([
      Animated.spring(heartAnim, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }),
      Animated.timing(heartAnim, { toValue: 0, delay: 380, duration: 260, useNativeDriver: true }),
    ]).start();
  };

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      if (!post.liked_by_me) onLike();
      showHeart();
    } else {
      lastTap.current = now;
    }
  };

  const cycleReaction = () => {
    if (!post.my_reaction) {
      onReact(REACTIONS[0]);
      return;
    }
    const idx = REACTIONS.indexOf(post.my_reaction);
    const next = REACTIONS[(idx + 1) % REACTIONS.length];
    onReact(next === post.my_reaction ? '' : next);
  };

  const heartScale = heartAnim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.2, 1.2, 1] });
  const heartOpacity = heartAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 0] });

  const isCarousel = Array.isArray(post.media_items) && post.media_items.length > 1;

  return (
    <View style={[styles.post, { height }]}>
      {isCarousel ? (
        // carousel must NOT sit inside a Pressable — on Android a Pressable
        // becomes the touch responder and starves the inner ScrollView, so
        // swiping dies. It gets its own non-blocking double-tap detection.
        <View style={[styles.media, { top: contentTop, bottom: contentBottom }]}>
          <CarouselMedia
            items={post.media_items!}
            onDoubleTap={() => {
              if (!post.liked_by_me) onLike();
              showHeart();
            }}
          />
        </View>
      ) : (
        <Pressable
          style={[styles.media, { top: contentTop, bottom: contentBottom }]}
          onPress={handleTap}
          delayLongPress={350}
          onLongPress={() => setHoldPause(true)}
          onPressOut={() => setHoldPause(false)}
        >
          <MediaArea
            post={post}
            isActive={isActive}
            paused={holdPause}
            onTap={handleTap}
            onHoldStart={() => setHoldPause(true)}
            onHoldEnd={() => setHoldPause(false)}
          />
        </Pressable>
      )}

      <Animated.View
        pointerEvents="none"
        style={[
          styles.heartBurst,
          { opacity: heartOpacity, transform: [{ scale: heartScale }] },
        ]}
      >
        <Icon name="heart" size={110} color={colors.accent} style={styles.heartBurstIcon} />
      </Animated.View>

      <View style={[styles.overlay, { top: contentTop, bottom: contentBottom }]} pointerEvents="box-none">
        <View style={styles.rail}>
          <Pressable onPress={() => setMenuOpen(true)} style={styles.railBtn} hitSlop={6}>
            <Icon name="ellipsis-horizontal" size={30} color={colors.logoWhite} style={styles.railIconShadow} />
          </Pressable>
          <Pressable onPress={onLike} style={styles.railBtn} hitSlop={6}>
            <Icon
              name={post.liked_by_me ? 'heart' : 'heart-outline'}
              size={30}
              color={post.liked_by_me ? colors.accent : colors.logoWhite}
              style={styles.railIconShadow}
            />
            <Text style={styles.railCount}>{fmtCount(post.likes_count)}</Text>
          </Pressable>
          <Pressable onPress={onComment} style={styles.railBtn} hitSlop={6}>
            <Icon name="chatbubble-ellipses-outline" size={27} color={colors.logoWhite} style={styles.railIconShadow} />
            <Text style={styles.railCount}>{fmtCount(post.comments_count)}</Text>
          </Pressable>
          <Pressable onPress={onSave} style={styles.railBtn} hitSlop={6}>
            <Icon
              name={post.saved_by_me ? 'bookmark' : 'bookmark-outline'}
              size={28}
              color={post.saved_by_me ? colors.accent : colors.logoWhite}
              style={styles.railIconShadow}
            />
          </Pressable>
          <Pressable onPress={onRepost} style={styles.railBtn} hitSlop={6}>
            <Icon
              name={post.reposted_by_me ? 'repeat' : 'repeat-outline'}
              size={30}
              color={post.reposted_by_me ? colors.accent : colors.logoWhite}
              style={styles.railIconShadow}
            />
          </Pressable>
          <Pressable onPress={onShare} style={styles.railBtn} hitSlop={6}>
            <Icon name="share-social-outline" size={27} color={colors.logoWhite} style={styles.railIconShadow} />
          </Pressable>
          {!!post.drop_id && (
            <Pressable onPress={cycleReaction} style={styles.railBtn} hitSlop={6}>
              {post.my_reaction ? (
                <Text style={[styles.reactionBadge, styles.reactionBadgeActive]}>{post.my_reaction}</Text>
              ) : (
                <Icon name="sparkles" size={26} color={colors.logoWhite} style={styles.railIconShadow} />
              )}
              {post.reactions_count > 0 && (
                <Text style={styles.railCount}>{fmtCount(post.reactions_count)}</Text>
              )}
            </Pressable>
          )}
          <Text style={styles.views}>{fmtCount(post.views_count)} views</Text>
        </View>

        <View style={styles.bottomLeft}>
          <View style={styles.userRow}>
            <Pressable style={styles.userPress} onPress={onOpenProfile} hitSlop={6}>
              <Avatar url={post.profile?.avatar_url} name={post.profile?.username ?? 'G'} size={36} ring />
              <Text style={styles.username}>@{post.profile?.username ?? 'unknown'}</Text>
            </Pressable>
            {post.user_id !== currentUserId && (
              <Pressable
                style={[
                  styles.followPill,
                  post.following && styles.followPillActive,
                  post.follow_pending && styles.followPillPending,
                ]}
                onPress={onFollow}
              >
                <Text
                  style={[
                    styles.followText,
                    post.following && styles.followTextActive,
                    post.follow_pending && styles.followTextPending,
                  ]}
                >
                  {post.following ? 'Following' : post.follow_pending ? 'Requested' : 'Follow'}
                </Text>
              </Pressable>
            )}
          </View>

          {!!post.caption && (
            <Text style={styles.caption} numberOfLines={2}>
              {post.caption}
            </Text>
          )}

          <View style={styles.timeRow}>
            <TimeLeft expiresAt={post.expires_at} onExpired={onExpired} />
          </View>

          {!!(post.audio ?? post.sound) && (
            <Pressable style={styles.audioChip} onPress={onOpenSound}>
              <Icon name="musical-note" size={13} color={colors.cyan} />
              <Text style={styles.audioText} numberOfLines={1}>
                {post.sound ?? post.audio}
              </Text>
              <Text style={styles.audioCta}> ›</Text>
            </Pressable>
          )}

          {!!post.drop_id && (
            <View style={styles.dropChip}>
              <Icon name="cube-outline" size={12} color={colors.accent} />
              <Text style={styles.dropChipText}>DROP</Text>
            </View>
          )}

          {(post.responses_count ?? 0) > 0 && (
            <Pressable style={styles.chainChip} onPress={onOpenChain}>
              <Icon name="link-outline" size={12} color={colors.violet} />
              <Text style={styles.chainChipText}>{post.responses_count} responses</Text>
            </Pressable>
          )}

          <PulseRow pulse={post.pulse} comments={post.comments_count} />
        </View>
      </View>

      <DropMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        showReasons={showReasons}
        setShowReasons={setShowReasons}
        reasons={post.reasons ?? []}
        onAction={(a) => {
          setMenuOpen(false);
          if (a === 'replydrop') onReplyWithDrop();
          else onMenuAction(a);
        }}
        isOwner={post.user_id === currentUserId}
      />
    </View>
  );
}

// small live "time left" chip — disappears with the drop, never resets
function TimeLeft({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(expiresAt).getTime() - now;
  useEffect(() => {
    if (ms <= 0) onExpired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms <= 0]);
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const urgent = ms < 3 * 3600000;
  return (
    <View style={styles.timeRow}>
      <Icon
        name={urgent ? 'flash' : 'flame'}
        size={14}
        color={urgent ? colors.danger : colors.accent}
        style={styles.railIconShadow}
      />
      <Text style={[styles.timeLeft, urgent && styles.timeLeftUrgent]}>
        {urgent ? 'ENDING SOON' : `${h}h ${m}m left`}
      </Text>
    </View>
  );
}

// real Drop Pulse indicators — hidden when there is nothing meaningful
function PulseRow({ pulse, comments }: { pulse?: FeedPost['pulse']; comments: number }) {
  if (!pulse) return null;
  const chips: { icon: IconName; color: string; text: string }[] = [];
  if (pulse.views30 >= 5) chips.push({ icon: 'eye-outline', color: colors.logoWhite, text: `${pulse.views30} watching` });
  if (pulse.rising) chips.push({ icon: 'flash', color: colors.accent, text: 'Rising fast' });
  if (pulse.trending) chips.push({ icon: 'flame', color: colors.accent, text: 'Trending now' });
  if (comments >= 3) chips.push({ icon: 'chatbubble-ellipses-outline', color: colors.logoWhite, text: `${comments} conversations` });
  if (!chips.length) return null;
  return (
    <View style={styles.pulseRow}>
      {chips.map((c) => (
        <View key={c.text} style={styles.pulseChip}>
          <Icon name={c.icon} size={11} color={c.color} />
          <Text style={styles.pulseChipText}>{c.text}</Text>
        </View>
      ))}
    </View>
  );
}

type MenuAction = 'hide' | 'mute' | 'block' | 'notinterested' | 'report' | 'replydrop' | 'why' | 'delete';

const MENU_ITEMS: { key: MenuAction; label: string; icon: IconName; iconColor: string }[] = [
  { key: 'why', label: 'Why am I seeing this?', icon: 'bulb-outline', iconColor: colors.accent },
  { key: 'replydrop', label: 'Reply with Drop', icon: 'videocam-outline', iconColor: colors.cyan },
  { key: 'notinterested', label: 'Not interested', icon: 'hand-left-outline', iconColor: colors.textMuted },
  { key: 'hide', label: 'Hide this Drop', icon: 'eye-off-outline', iconColor: colors.textMuted },
  { key: 'mute', label: 'Mute creator', icon: 'volume-mute-outline', iconColor: colors.textMuted },
  { key: 'block', label: 'Block creator', icon: 'ban-outline', iconColor: colors.danger },
  { key: 'report', label: 'Report', icon: 'warning-outline', iconColor: colors.danger },
  { key: 'delete', label: 'Delete drop', icon: 'trash-outline', iconColor: colors.danger },
];

// own posts: delete + the still-useful actions only
const OWN_MENU_ITEMS = MENU_ITEMS.filter((m) => m.key === 'delete' || m.key === 'why' || m.key === 'replydrop' || m.key === 'report');

function DropMenu({
  visible,
  onClose,
  showReasons,
  setShowReasons,
  reasons,
  onAction,
  isOwner,
}: {
  visible: boolean;
  onClose: () => void;
  showReasons: boolean;
  setShowReasons: (v: boolean) => void;
  reasons: string[];
  onAction: (a: Exclude<MenuAction, 'why'>) => void;
  isOwner?: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.menuOverlay} onPress={onClose}>
        <Pressable style={styles.menuSheet} onPress={() => {}}>
          {showReasons ? (
            <>
              <Text style={styles.menuTitle}>Why am I seeing this?</Text>
              {reasons.length ? (
                reasons.map((r) => (
                  <View key={r} style={styles.reasonRow}>
                    <Text style={styles.reasonDot}>•</Text>
                    <Text style={styles.reasonText}>{r}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.menuMuted}>
                  This Drop matched general discovery — no special signals yet.
                </Text>
              )}
              <Pressable style={styles.menuBack} onPress={() => setShowReasons(false)}>
                <Text style={styles.menuBackText}>← Back</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.menuTitle}>Drop options</Text>
              {(isOwner ? OWN_MENU_ITEMS : MENU_ITEMS).map((it) => (
                <Pressable
                  key={it.key}
                  style={styles.menuItem}
                  onPress={() => {
                    if (it.key === 'why') setShowReasons(true);
                    else onAction(it.key);
                  }}
                >
                  <Icon name={it.icon} size={19} color={it.iconColor} />
                  <Text style={styles.menuItemText}>{it.label}</Text>
                </Pressable>
              ))}
              <Pressable style={styles.menuCancel} onPress={onClose}>
                <Text style={styles.menuCancelText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MediaArea({
  post,
  isActive,
  paused,
  onTap,
  onHoldStart,
  onHoldEnd,
}: {
  post: FeedPost;
  isActive: boolean;
  paused: boolean;
  onTap?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
}) {
  if (post.media_type === 'video' && post.media_url) {
    return (
      <VideoMedia
        post={post}
        isActive={isActive}
        paused={paused}
        forceMute={!!post.sound_url}
        onTap={onTap}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
      />
    );
  }
  if (Array.isArray(post.media_items) && post.media_items.length > 1) {
    return <CarouselMedia items={post.media_items} />;
  }
  if (post.media_url) {
    return <Image source={{ uri: post.media_url }} style={styles.fill} resizeMode="cover" />;
  }
  // text post — creator's chosen background + readable text color
  return (
    <View style={[styles.fill, styles.textPostBg, post.text_bg ? { backgroundColor: post.text_bg } : null]}>
      <Text style={[styles.textPostContent, post.text_color ? { color: post.text_color } : null]}>{post.content}</Text>
    </View>
  );
}

function VideoMedia({
  post,
  isActive,
  paused,
  forceMute = false,
  onTap,
  onHoldStart,
  onHoldEnd,
}: {
  post: FeedPost;
  isActive: boolean;
  paused: boolean;
  forceMute?: boolean;
  onTap?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
}) {
  return (
    <DropVideoView
      url={post.media_url!}
      effects={post.effects}
      filters={post.filters}
      textLayers={post.text_layers}
      stickers={post.stickers}
      isActive={isActive}
      paused={paused}
      showProgress
      showMute
      forceMute={forceMute}
      onTap={onTap}
      onHoldStart={onHoldStart}
      onHoldEnd={onHoldEnd}
    />
  );
}

function CarouselMedia({ items, onDoubleTap }: { items: { url: string; type: string }[]; onDoubleTap?: () => void }) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const lastTap = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // plain touch events (not a responder) — detects double-tap WITHOUT
  // blocking the ScrollView's swipes
  const onTouchStart = (e: any) => {
    touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
  };
  const onTouchEnd = (e: any) => {
    const t = e.nativeEvent.changedTouches?.[0];
    const end = t ? { x: t.pageX, y: t.pageY } : null;
    const start = touchStart.current;
    touchStart.current = null;
    const moved = start && end ? Math.hypot(end.x - start.x, end.y - start.y) : 0;
    if (moved > 12) return; // it was a swipe, not a tap
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      onDoubleTap?.();
    } else {
      lastTap.current = now;
    }
  };

  return (
    <View style={styles.fill} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <ScrollView
        horizontal
        pagingEnabled
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        style={styles.carousel}
        onMomentumScrollEnd={(e) =>
          setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
        }
      >
        {items.map((it, i) => (
          <Image
            key={`${it.url}-${i}`}
            source={{ uri: it.url }}
            style={[styles.carouselImage, { width }]}
            resizeMode="cover"
          />
        ))}
      </ScrollView>
      {items.length > 1 && (
        <View style={styles.dots} pointerEvents="none">
          {items.map((it, i) => (
            <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

// set by FeedScreen on every load — hides Follow on own posts
let currentUserId: string | null = null;
export function setFeedUserId(id: string | null) {
  currentUserId = id;
}

const styles = StyleSheet.create({
  post: {
    width: '100%',
    backgroundColor: colors.bg,
  },
  media: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  carousel: {
    height: '100%',
  },
  carouselImage: {
    height: '100%',
    backgroundColor: '#0A1220',
  },
  textPostBg: {
    backgroundColor: '#101A33',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.accent,
  },
  textPostContent: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '800',
    textAlign: 'center',
    textShadowColor: 'rgba(255,122,0,0.35)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  heartBurst: {
    position: 'absolute',
    top: '42%',
    alignSelf: 'center',
    zIndex: 20,
  },
  heartBurstIcon: {
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  railIconShadow: {
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  rail: {
    position: 'absolute',
    right: 14,
    bottom: 26,
    alignItems: 'center',
  },
  railBtn: {
    alignItems: 'center',
    marginBottom: 18,
  },
  railIcon: {
    color: colors.logoWhite,
    fontSize: 28,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  railCount: {
    color: colors.logoWhite,
    fontSize: 12,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  reactionBadge: {
    fontSize: 26,
    color: colors.logoWhite,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  reactionBadgeActive: {
    color: colors.accent,
  },
  views: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  bottomLeft: {
    padding: 16,
    paddingBottom: 22,
    maxWidth: '78%',
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userPress: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
  username: {
    color: colors.logoWhite,
    fontSize: 15,
    fontWeight: '700',
    marginLeft: 8,
  },
  followPill: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 5,
    marginLeft: 10,
    ...shadows.glow,
  },
  followPillActive: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.logoWhite,
  },
  followPillPending: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  followText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
  followTextActive: {
    color: colors.logoWhite,
  },
  followTextPending: {
    color: colors.accent,
  },
  caption: {
    color: colors.logoWhite,
    fontSize: 14,
    marginTop: 8,
    lineHeight: 19,
  },
  audioChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
  },
  audioText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
  dropChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 8,
  },
  dropChipText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  timeRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeLeft: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
    marginLeft: 4,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  timeLeftUrgent: {
    color: colors.danger,
  },
  audioCta: {
    color: colors.cyan,
    fontSize: 14,
    fontWeight: '800',
  },
  chainChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(139,123,255,0.16)',
    borderWidth: 1,
    borderColor: colors.violet,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 8,
  },
  chainChipText: {
    color: colors.violet,
    fontSize: 11,
    fontWeight: '700',
  },
  pulseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    gap: 6,
  },
  pulseChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  pulseChipText: {
    color: colors.logoWhite,
    fontSize: 10,
    fontWeight: '600',
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    paddingBottom: 40,
  },
  menuTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 10,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuItemText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  menuMuted: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  reasonRow: {
    flexDirection: 'row',
    paddingVertical: 8,
  },
  reasonDot: {
    color: colors.accent,
    fontSize: 16,
    marginRight: 8,
  },
  reasonText: {
    color: colors.text,
    fontSize: 14,
    flex: 1,
    lineHeight: 19,
  },
  menuBack: {
    marginTop: 12,
  },
  menuBackText: {
    color: colors.cyan,
    fontSize: 14,
    fontWeight: '700',
  },
  menuCancel: {
    marginTop: 12,
    alignItems: 'center',
  },
  menuCancelText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  dots: {
    position: 'absolute',
    bottom: 14,
    alignSelf: 'center',
    flexDirection: 'row',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.4)',
    marginHorizontal: 3,
  },
  dotActive: {
    backgroundColor: colors.accent,
    width: 18,
  },
});
