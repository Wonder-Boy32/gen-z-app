import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import DropVideoView, { DropEffects, DropSticker, DropTextLayer } from './DropVideoView';
import { colors, shadows } from '../theme';
import Countdown from './Countdown';
import Avatar from './Avatar';

export type FeedPost = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  content: string | null;
  audio: string | null;
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
  onLike: () => void;
  onFollow: () => void;
  onComment: () => void;
  onShare: () => void;
  onSave: () => void;
  onRepost: () => void;
  onOpenProfile: () => void;
  onReact: (r: string) => void;
  onMenuAction: (action: 'hide' | 'mute' | 'block' | 'notinterested' | 'report') => void;
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

  return (
    <View style={[styles.post, { height }]}>
      <Pressable
        style={styles.media}
        onPress={handleTap}
        delayLongPress={350}
        onLongPress={() => setHoldPause(true)}
        onPressOut={() => setHoldPause(false)}
      >
        <MediaArea post={post} isActive={isActive} paused={holdPause} />
      </Pressable>

      <Animated.View
        pointerEvents="none"
        style={[
          styles.heartBurst,
          { opacity: heartOpacity, transform: [{ scale: heartScale }] },
        ]}
      >
        <Text style={styles.heartBurstIcon}>♥</Text>
      </Animated.View>

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.rail}>
          <Pressable onPress={() => setMenuOpen(true)} style={styles.railBtn} hitSlop={6}>
            <Text style={styles.railIcon}>•••</Text>
          </Pressable>
          <Pressable onPress={onLike} style={styles.railBtn} hitSlop={6}>
            <Text style={[styles.railIcon, post.liked_by_me && styles.railIconLiked]}>♥</Text>
            <Text style={styles.railCount}>{fmtCount(post.likes_count)}</Text>
          </Pressable>
          <Pressable onPress={onComment} style={styles.railBtn} hitSlop={6}>
            <Text style={styles.railIcon}>✎</Text>
            <Text style={styles.railCount}>{fmtCount(post.comments_count)}</Text>
          </Pressable>
          <Pressable onPress={onSave} style={styles.railBtn} hitSlop={6}>
            <Text style={[styles.railIcon, post.saved_by_me && styles.railIconLiked]}>⤓</Text>
          </Pressable>
          <Pressable onPress={onRepost} style={styles.railBtn} hitSlop={6}>
            <Text style={[styles.railIcon, post.reposted_by_me && styles.railIconLiked]}>↻</Text>
          </Pressable>
          <Pressable onPress={onShare} style={styles.railBtn} hitSlop={6}>
            <Text style={styles.railIcon}>↗</Text>
          </Pressable>
          {!!post.drop_id && (
            <Pressable onPress={cycleReaction} style={styles.railBtn} hitSlop={6}>
              <Text style={[styles.reactionBadge, !!post.my_reaction && styles.reactionBadgeActive]}>
                {post.my_reaction ?? '✧'}
              </Text>
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
            <TimeLeft expiresAt={post.expires_at} onExpired={onExpired} />
          </View>

          {!!post.caption && (
            <Text style={styles.caption} numberOfLines={2}>
              {post.caption}
            </Text>
          )}

          {!!post.audio && (
            <Pressable style={styles.audioChip} onPress={onOpenSound}>
              <Text style={styles.audioText}>♪ {post.audio}</Text>
              <Text style={styles.audioCta}> ›</Text>
            </Pressable>
          )}

          {!!post.drop_id && (
            <View style={styles.dropChip}>
              <Text style={styles.dropChipText}>📦 DROP</Text>
            </View>
          )}

          {(post.responses_count ?? 0) > 0 && (
            <Pressable style={styles.chainChip} onPress={onOpenChain}>
              <Text style={styles.chainChipText}>🔗 {post.responses_count} responses</Text>
            </Pressable>
          )}

          <PulseRow pulse={post.pulse} comments={post.comments_count} />

          <Countdown expiresAt={post.expires_at} style={styles.countdown} />
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
    <Text style={[styles.timeLeft, urgent && styles.timeLeftUrgent]}>
      {urgent ? '⚡ ENDING SOON' : `🔥 ${h}h ${m}m left`}
    </Text>
  );
}

// real Drop Pulse indicators — hidden when there is nothing meaningful
function PulseRow({ pulse, comments }: { pulse?: FeedPost['pulse']; comments: number }) {
  if (!pulse) return null;
  const chips: string[] = [];
  if (pulse.views30 >= 5) chips.push(`👁 ${pulse.views30} watching`);
  if (pulse.rising) chips.push('⚡ Rising fast');
  if (pulse.trending) chips.push('🔥 Trending now');
  if (comments >= 3) chips.push(`💬 ${comments} conversations`);
  if (!chips.length) return null;
  return (
    <View style={styles.pulseRow}>
      {chips.map((c) => (
        <View key={c} style={styles.pulseChip}>
          <Text style={styles.pulseChipText}>{c}</Text>
        </View>
      ))}
    </View>
  );
}

type MenuAction = 'hide' | 'mute' | 'block' | 'notinterested' | 'report' | 'replydrop' | 'why';

const MENU_ITEMS: { key: MenuAction; label: string }[] = [
  { key: 'why', label: '💡 Why am I seeing this?' },
  { key: 'replydrop', label: '🎥 Reply with Drop' },
  { key: 'notinterested', label: '🙅 Not interested' },
  { key: 'hide', label: '🙈 Hide this Drop' },
  { key: 'mute', label: '🔇 Mute creator' },
  { key: 'block', label: '🚫 Block creator' },
  { key: 'report', label: '⚠️ Report' },
];

function DropMenu({
  visible,
  onClose,
  showReasons,
  setShowReasons,
  reasons,
  onAction,
}: {
  visible: boolean;
  onClose: () => void;
  showReasons: boolean;
  setShowReasons: (v: boolean) => void;
  reasons: string[];
  onAction: (a: Exclude<MenuAction, 'why'>) => void;
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
              {MENU_ITEMS.map((it) => (
                <Pressable
                  key={it.key}
                  style={styles.menuItem}
                  onPress={() => {
                    if (it.key === 'why') setShowReasons(true);
                    else onAction(it.key);
                  }}
                >
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
}: {
  post: FeedPost;
  isActive: boolean;
  paused: boolean;
}) {
  if (post.media_type === 'video' && post.media_url) {
    return <VideoMedia post={post} isActive={isActive} paused={paused} />;
  }
  if (post.media_items && post.media_items.length > 1) {
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

function VideoMedia({ post, isActive, paused }: { post: FeedPost; isActive: boolean; paused: boolean }) {
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
    />
  );
}

function CarouselMedia({ items }: { items: { url: string; type: string }[] }) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  return (
    <View style={styles.fill}>
      <FlatList
        data={items}
        keyExtractor={(it, i) => `${it.url}-${i}`}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) =>
          setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
        }
        renderItem={({ item }) => (
          <Image source={{ uri: item.url }} style={[styles.fill, { width }]} resizeMode="cover" />
        )}
      />
      {items.length > 1 && (
        <View style={styles.dots}>
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
    fontSize: 110,
    color: colors.accent,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
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
    bottom: 118,
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
  railIconLiked: {
    color: colors.accent,
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
    paddingBottom: 120,
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
  countdown: {
    marginTop: 6,
  },
  timeLeft: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
    marginLeft: 10,
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
