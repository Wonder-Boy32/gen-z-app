import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import SoundTrack from './SoundTrack';
import { colors, shadows, getThemeEpoch } from '../theme';
import Avatar from './Avatar';
import VerifiedBadge from './ui/VerifiedBadge';
import Icon, { IconName } from './ui/Icon';
import CaptionText from './ui/CaptionText';
import DownloadFlowModal from './download/DownloadFlowModal';
import { postAllowsDownload } from '../utils/downloadMedia';

export type FeedPost = {
  id: string;
  user_id: string;
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items: { url: string; type: string }[] | null;
  /** cover frame for a video post. The feed has always received this — the
   *  column is on `posts` and the query is `select('*')` — but nothing typed
   *  or drew it, so every cell was black until the first frame decoded. */
  cover_url?: string | null;
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
  profile: { username: string; avatar_url: string | null; is_private: boolean; verified?: boolean } | null;
  liked_by_me: boolean;
  following: boolean;
  follow_pending: boolean;
  saved_by_me: boolean;
  reposted_by_me: boolean;
  my_reaction: string | null;
  reactions_count: number;
  // creator toggles — absent (older posts) = allowed
  allow_likes?: boolean;
  allow_comments?: boolean;
  allow_shares?: boolean;
  allow_reposts?: boolean;
  allow_downloads?: boolean;
  allow_mentions?: boolean;
  pulse?: { views30: number; likes30: number; comments30: number; rising: boolean; trending: boolean } | null;
  responses_count?: number;
  reasons?: string[];
  /** present only on items that reached the feed because an account you follow
   *  reposted them — names the account whose repost surfaced the drop */
  reposted_by?: { username: string; avatar_url: string | null; verified?: boolean } | null;
};

const REACTIONS = ['🔥', '😂', '😮', '💯'];

type Props = {
  post: FeedPost;
  isActive: boolean;
  /** true when this page is the NEXT one in the pager — its video is
   *  loaded (muted) ahead of time so playback starts instantly on swipe */
  preload?: boolean;
  /** true two pages ahead: fetch the bytes, paint nothing */
  warm?: boolean;
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
  /** Tapping a #hashtag in the caption. Receives the normalised (lower-case) tag. */
  onPressTag?: (tag: string) => void;
};

export function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${n}`;
}

function FeedPostInner({
  post,
  isActive,
  preload = false,
  warm = false,
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
  onPressTag,
}: Props) {
  const lastTap = useRef(0);
  const heartAnim = useRef(new Animated.Value(0)).current;
  const [holdPause, setHoldPause] = useState(false);
  const [tapPaused, setTapPaused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [dlChecking, setDlChecking] = useState(false);

  // TikTok-style download — respects the creator's Downloads OFF toggle
  const onDownload = async () => {
    if (dlChecking || dlOpen) return;
    setDlChecking(true);
    try {
      const ok = await postAllowsDownload(post.id);
      if (!ok) {
        Alert.alert('Downloads disabled', 'This creator turned downloads off for this drop.');
        return;
      }
      setDlOpen(true);
    } finally {
      setDlChecking(false);
    }
  };

  // ---------- attached sound track (plays on video, photo AND text drops) ----------
  //
  // The player is created HERE, but nothing reads its STATUS here any more.
  // useAudioPlayerStatus() ticks continuously while audio plays, and reading it
  // in this component re-rendered the whole post — including the native video
  // surface, because VideoMedia and DropVideoView are plain function components
  // (only FeedPostInner is memoized). That render work competes with video
  // decode and shows up as the picture breaking up.
  //
  // All of that logic now lives in <SoundTrack>, mounted below.
  const soundUrl = post.sound_url;
  const soundActive = isActive && !holdPause && !tapPaused && !!post.sound_url;

  // creator interaction toggles (missing flag = allowed, for older posts)
  const canLike = post.allow_likes !== false;
  const canComment = post.allow_comments !== false;
  // reuse the existing module-level viewer id (set by FeedScreen + PostViewer via
  // setFeedUserId) rather than adding a second "is this mine" mechanism — the same
  // value already hides the Follow pill on own posts. The RLS policy in
  // supabase/reposts_enforcement.sql rejects a self-repost regardless of the UI.
  const canRepost = post.allow_reposts !== false && post.user_id !== currentUserId;
  const canShare = post.allow_shares !== false;
  const canDownload = post.allow_downloads !== false;

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
      if (canLike && !post.liked_by_me) onLike();
      if (canLike) showHeart();
    } else {
      lastTap.current = now;
      // single tap = pause/play for videos (waits to make sure it wasn't
      // the first half of a double-tap before toggling)
      setTimeout(() => {
        if (lastTap.current === now && post.media_type === 'video') {
          setTapPaused((p) => !p);
        }
      }, 300);
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
      {/* Plays the attached sound. Deliberately its own component so its
          high-frequency status ticks re-render only itself — never the video
          surface below. SoundTrack carries the full reasoning. */}
      {soundUrl ? (
        <SoundTrack
          url={soundUrl}
          start={post.sound_start ?? 0}
          end={post.sound_end ?? null}
          active={soundActive}
        />
      ) : null}
      {isCarousel ? (
        // carousel must NOT sit inside a Pressable — on Android a Pressable
        // becomes the touch responder and starves the inner ScrollView, so
        // swiping dies. It gets its own non-blocking double-tap detection.
        <View style={[styles.media, { top: contentTop, bottom: contentBottom }]}>
          <CarouselMedia
            items={post.media_items!}
            onDoubleTap={() => {
              if (canLike && !post.liked_by_me) onLike();
              if (canLike) showHeart();
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
            preload={preload}
            warm={warm}
            paused={holdPause || tapPaused}
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
          {canLike && (
            <Pressable onPress={onLike} style={styles.railBtn} hitSlop={6}>
              <Icon
                name={post.liked_by_me ? 'heart' : 'heart-outline'}
                size={30}
                color={post.liked_by_me ? colors.accent : colors.logoWhite}
                style={styles.railIconShadow}
              />
              <Text style={styles.railCount}>{fmtCount(post.likes_count)}</Text>
            </Pressable>
          )}
          {canComment && (
            <Pressable onPress={onComment} style={styles.railBtn} hitSlop={6}>
              <Icon name="chatbubble-ellipses-outline" size={27} color={colors.logoWhite} style={styles.railIconShadow} />
              <Text style={styles.railCount}>{fmtCount(post.comments_count)}</Text>
            </Pressable>
          )}
          <Pressable onPress={onSave} style={styles.railBtn} hitSlop={6}>
            <Icon
              name={post.saved_by_me ? 'bookmark' : 'bookmark-outline'}
              size={28}
              color={post.saved_by_me ? colors.accent : colors.logoWhite}
              style={styles.railIconShadow}
            />
          </Pressable>
          {canRepost && (
            <Pressable onPress={onRepost} style={styles.railBtn} hitSlop={6}>
              <Icon
                name={post.reposted_by_me ? 'repeat' : 'repeat-outline'}
                size={30}
                color={post.reposted_by_me ? colors.accent : colors.logoWhite}
                style={styles.railIconShadow}
              />
            </Pressable>
          )}
          {canShare && (
            <Pressable onPress={onShare} style={styles.railBtn} hitSlop={6}>
              <Icon name="share-social-outline" size={27} color={colors.logoWhite} style={styles.railIconShadow} />
            </Pressable>
          )}
          {canDownload && !!post.media_url && !!post.media_type && (
            <Pressable onPress={onDownload} style={styles.railBtn} hitSlop={6}>
              {dlChecking ? (
                <ActivityIndicator size="small" color={colors.logoWhite} />
              ) : (
                <Icon name="download-outline" size={29} color={colors.logoWhite} style={styles.railIconShadow} />
              )}
            </Pressable>
          )}
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
          {!!post.reposted_by && (
            <View style={styles.repostRow}>
              <Icon name="repeat" size={12} color={colors.cyan} />
              <Text style={styles.repostText} numberOfLines={1}>
                @{post.reposted_by.username} reposted
              </Text>
            </View>
          )}
          <View style={styles.userRow}>
            <Pressable style={styles.userPress} onPress={onOpenProfile} hitSlop={6}>
              <Avatar
                url={post.profile?.avatar_url}
                name={post.profile?.username ?? 'G'}
                size={36}
                ring
                verified={!!post.profile?.verified}
              />
              <Text style={styles.username}>@{post.profile?.username ?? 'unknown'}</Text>
              {post.profile?.verified && <VerifiedBadge size={13} style={styles.verifiedInline} />}
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

          {/* CaptionText, not a bare <Text>: hashtags in a caption are links, and
              they open the same filtered feed a tag chip would. */}
          {!!post.caption && (
            <CaptionText
              text={post.caption}
              style={styles.caption}
              numberOfLines={2}
              onPressTag={onPressTag}
            />
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
      {dlOpen && (
        <DownloadFlowModal post={post} onClose={() => setDlOpen(false)} />
      )}
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

// Everyone: hide/block/report etc. — NEVER "Delete drop" (that's owner-only)
const MENU_ITEMS: { key: MenuAction; label: string; icon: IconName; iconColor: string }[] = [
  { key: 'why', label: 'Why am I seeing this?', icon: 'bulb-outline', iconColor: colors.accent },
  { key: 'replydrop', label: 'Reply with Drop', icon: 'videocam-outline', iconColor: colors.cyan },
  { key: 'notinterested', label: 'Not interested', icon: 'hand-left-outline', iconColor: colors.textMuted },
  { key: 'hide', label: 'Hide this Drop', icon: 'eye-off-outline', iconColor: colors.textMuted },
  { key: 'mute', label: 'Mute creator', icon: 'volume-mute-outline', iconColor: colors.textMuted },
  { key: 'block', label: 'Block creator', icon: 'ban-outline', iconColor: colors.danger },
  { key: 'report', label: 'Report', icon: 'warning-outline', iconColor: colors.danger },
];

// Own posts only: Delete drop + the still-useful actions
const OWN_MENU_ITEMS: { key: MenuAction; label: string; icon: IconName; iconColor: string }[] = [
  { key: 'delete', label: 'Delete drop', icon: 'trash-outline', iconColor: colors.danger },
  ...MENU_ITEMS.filter((m) => m.key === 'why' || m.key === 'replydrop' || m.key === 'report'),
];

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
  preload = false,
  warm = false,
  paused,
  onTap,
  onHoldStart,
  onHoldEnd,
}: {
  post: FeedPost;
  isActive: boolean;
  preload?: boolean;
  warm?: boolean;
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
        preload={preload}
        warm={warm}
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
  preload = false,
  warm = false,
  paused,
  forceMute = false,
  onTap,
  onHoldStart,
  onHoldEnd,
}: {
  post: FeedPost;
  isActive: boolean;
  preload?: boolean;
  warm?: boolean;
  paused: boolean;
  forceMute?: boolean;
  onTap?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
}) {
  return (
    <DropVideoView
      url={post.media_url!}
      poster={post.cover_url ?? null}
      effects={post.effects}
      filters={post.filters}
      textLayers={post.text_layers}
      stickers={post.stickers}
      isActive={isActive}
      preload={preload}
      warm={warm}
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
    // Only the FALLBACK for a text drop that carries no text_bg of its own
    // (see post.text_bg in the render). It used to be a hardcoded dark navy,
    // but textPostContent reads colors.text — so in White mode a text post
    // rendered near-black text on navy and disappeared. A surface token keeps
    // the tile and its text on the same side of the theme.
    backgroundColor: colors.surfaceAlt,
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
    textShadowColor: 'rgba(229,43,255,0.35)',
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
        // same pill language as the profile reposts tile (ProfileScreen tileRepost),
        // sized up for the full-screen feed
        repostRow: {
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: colors.overlay,
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 2,
          marginBottom: 6,
          maxWidth: '100%',
        },
        repostText: {
          color: colors.cyan,
          fontSize: 12,
          fontWeight: '600',
          flexShrink: 1,
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
    fontSize: 14,
    fontWeight: '700',
  },
  verifiedInline: {
    marginLeft: 6,
  },
  avatarWrap: {
    position: 'relative',
  },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderWidth: 2,
    borderColor: colors.bgDeep,
    borderRadius: 8,
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

// ============================================================
// Memoisation — the single biggest fix for "the UI is slow"
// ============================================================
// FeedScreen passes THIRTEEN inline arrow functions to every row:
//
//   onLike={() => toggleLike(item)}
//   onFollow={() => toggleFollow(item)}
//   onSave={() => toggleSave(item)}
//   ... and ten more
//
// Every one is a brand-new function identity on every render. So plain
// React.memo() would never once hit — it compares props by reference, sees
// thirteen "changed" functions, and re-renders anyway. Adding memo without a
// comparator would have looked like a fix and changed nothing.
//
// Why this matters: `isActive={index === effectiveIndex}` changes on every
// scroll tick. FeedScreen re-renders, and with no memoisation every mounted row
// re-rendered its ENTIRE subtree — video surface, gradients, icon set, animated
// overlays, action rail. That is the scroll jank and the sluggish taps.
//
// So this comparator ignores the function props and asks the only question that
// actually matters: would this row render anything different?
//
// Keeping the previous element (and therefore the previous closures) is safe
// because those closures call stable useCallback handlers in FeedScreen and are
// keyed off the post's id. Any change to the post's own data is caught below.
// ============================================================

function samePost(a: Props['post'], b: Props['post']): boolean {
  if (a === b) return true;

  // Compare every own field except `profile`, shallowly, with arrays by value.
  // Deliberately generic rather than a hand-written field list: a list would go
  // stale the moment a column is added to the query, and a missed field means a
  // row that silently stops updating.
  for (const key of Object.keys(a) as (keyof Props['post'])[]) {
    if (key === 'profile') continue;

    const av = a[key] as unknown;
    const bv = b[key] as unknown;
    if (av === bv) continue;

    // media_items / reactions are rebuilt on every fetch, so compare contents.
    if (Array.isArray(av) || Array.isArray(bv)) {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      continue;
    }

    return false;
  }

  // profile is a nested object that is rebuilt often; compare only the fields
  // the card actually paints.
  return (
    a.profile?.username === b.profile?.username &&
    a.profile?.avatar_url === b.profile?.avatar_url
  );
}

/**
 * Theme epoch per post, so a theme change re-renders each card exactly once.
 *
 * React.memo skips a component whose props are unchanged — and a theme change
 * changes no post props at all. So a card that is already on screen would keep
 * painting its old colours while everything around it switched, which is the one
 * thing a theme setting must not do.
 *
 * Comparing epochs per item rather than using a single global flag matters: a
 * lone global "theme just changed" flag would be consumed by whichever card the
 * list happened to compare first, and every card after it would still be
 * considered equal. Keyed by the post object, each card notices exactly once.
 * A WeakMap so entries are collected with the posts they describe.
 */
const seenThemeEpoch = new WeakMap<object, number>();

function areEqualProps(prev: Props, next: Props): boolean {
  const post = (next.post ?? prev.post) as object | undefined;
  if (post && typeof post === 'object') {
    const current = getThemeEpoch();
    if (seenThemeEpoch.get(post) !== current) {
      seenThemeEpoch.set(post, current);
      return false; // palette moved since this card last rendered
    }
  }

  if (!samePost(prev.post, next.post)) return false;

  // These drive the video surface and the layout, so they must be exact.
  // `warm` belongs here for the same reason as `preload`: it decides whether
  // the player fetches a source, and a memo that ignored it would leave the
  // two-ahead item permanently cold.
  return (
    prev.isActive === next.isActive &&
    prev.preload === next.preload &&
    prev.warm === next.warm &&
    prev.height === next.height &&
    prev.contentTop === next.contentTop &&
    prev.contentBottom === next.contentBottom
  );
}

export default React.memo(FeedPostInner, areEqualProps);
