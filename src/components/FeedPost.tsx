import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Image,
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
}: Props) {
  const lastTap = useRef(0);
  const heartAnim = useRef(new Animated.Value(0)).current;
  const [holdPause, setHoldPause] = useState(false);

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
          </View>

          {!!post.caption && (
            <Text style={styles.caption} numberOfLines={2}>
              {post.caption}
            </Text>
          )}

          {!!post.audio && (
            <View style={styles.audioChip}>
              <Text style={styles.audioText}>♪ {post.audio}</Text>
            </View>
          )}

          {!!post.drop_id && (
            <View style={styles.dropChip}>
              <Text style={styles.dropChipText}>📦 DROP</Text>
            </View>
          )}

          <Countdown expiresAt={post.expires_at} style={styles.countdown} />
        </View>
      </View>
    </View>
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
  // text post
  return (
    <View style={[styles.fill, styles.textPostBg]}>
      <Text style={styles.textPostContent}>{post.content}</Text>
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
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  textPostContent: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
    textAlign: 'center',
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
    paddingBottom: 34,
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
