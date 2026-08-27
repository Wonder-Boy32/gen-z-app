import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewToken,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors } from '../theme';
import { TOP_INSET, useInsets } from '../utils/useInsets';
import FeedPost, { FeedPost as FeedPostType, setFeedUserId } from './FeedPost';
import CommentsModal from './CommentsModal';
import SoundPage from './SoundPage';
import { notifyUser } from '../utils/notify';

export type ViewerPost = FeedPostType;

type Props = {
  posts: ViewerPost[];
  index: number;
  onClose: () => void;
};

export default function PostViewer({ posts, index, onClose }: Props) {
  const { height } = useWindowDimensions();
  const insets = useInsets();
  const [current, setCurrent] = useState(index);
  const [items, setItems] = useState<ViewerPost[]>(posts);
  const [commentPost, setCommentPost] = useState<ViewerPost | null>(null);
  const [sound, setSound] = useState<string | null>(null);
  const meRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      meRef.current = user?.id ?? null;
      setFeedUserId(user?.id ?? '');
    })();
  }, []);

  const patch = useCallback(
    (id: string, fn: (p: ViewerPost) => ViewerPost) =>
      setItems((prev) => prev.map((p) => (p.id === id ? fn(p) : p))),
    []
  );

  const toggleLike = async (post: ViewerPost) => {
    const me = meRef.current;
    if (!me) return;
    if (post.liked_by_me) {
      await supabase.from('likes').delete().eq('post_id', post.id).eq('user_id', me);
      patch(post.id, (p) => ({ ...p, liked_by_me: false, likes_count: Math.max(0, p.likes_count - 1) }));
    } else {
      await supabase.from('likes').insert({ post_id: post.id, user_id: me });
      patch(post.id, (p) => ({ ...p, liked_by_me: true, likes_count: p.likes_count + 1 }));
      notifyUser({ userId: post.user_id, actorId: me, type: 'like', postId: post.id });
    }
  };

  const toggleFollow = async (post: ViewerPost) => {
    const me = meRef.current;
    if (!me || me === post.user_id) return;
    if (post.following) {
      await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', post.user_id);
      patch(post.id, (p) => ({ ...p, following: false, follow_pending: false }));
    } else {
      await supabase.from('follows').insert({
        follower_id: me,
        following_id: post.user_id,
        status: post.profile?.is_private ? 'pending' : 'accepted',
      });
      patch(post.id, (p) => ({ ...p, following: !p.profile?.is_private, follow_pending: !!p.profile?.is_private }));
      if (!post.profile?.is_private) {
        notifyUser({ userId: post.user_id, actorId: me, type: 'follow' });
      }
    }
  };

  const toggleSave = async (post: ViewerPost) => {
    const me = meRef.current;
    if (!me) return;
    if (post.saved_by_me) {
      await supabase.from('saved_posts').delete().eq('post_id', post.id).eq('user_id', me);
      patch(post.id, (p) => ({ ...p, saved_by_me: false }));
    } else {
      await supabase.from('saved_posts').insert({ post_id: post.id, user_id: me });
      patch(post.id, (p) => ({ ...p, saved_by_me: true }));
    }
  };

  const toggleRepost = async (post: ViewerPost) => {
    const me = meRef.current;
    if (!me) return;
    if (post.reposted_by_me) {
      await supabase.from('reposts').delete().eq('post_id', post.id).eq('user_id', me);
      patch(post.id, (p) => ({ ...p, reposted_by_me: false }));
    } else {
      await supabase.from('reposts').insert({ post_id: post.id, user_id: me });
      patch(post.id, (p) => ({ ...p, reposted_by_me: true }));
      notifyUser({ userId: post.user_id, actorId: me, type: 'repost', postId: post.id });
    }
  };

  const toggleReaction = async (post: ViewerPost, r: string) => {
    const me = meRef.current;
    if (!me) return;
    await supabase.from('post_reactions').delete().eq('post_id', post.id).eq('user_id', me);
    if (post.my_reaction !== r) {
      await supabase.from('post_reactions').insert({ post_id: post.id, user_id: me, reaction: r });
      patch(post.id, (p) => ({ ...p, my_reaction: r, reactions_count: p.reactions_count + 1 }));
      if (!post.my_reaction) {
        notifyUser({ userId: post.user_id, actorId: me, type: 'reaction', postId: post.id });
      }
    } else {
      patch(post.id, (p) => ({ ...p, my_reaction: null, reactions_count: Math.max(0, p.reactions_count - 1) }));
    }
  };

  const share = (post: ViewerPost) => {
    Share.share({
      message: `Check this out on Gen Z — @${post.profile?.username ?? 'someone'}: ${post.caption ?? post.content ?? ''}`,
    });
  };

  const removePost = (id: string) => setItems((prev) => prev.filter((p) => p.id !== id));

  const personalize = async (post: ViewerPost, action: 'hide' | 'mute' | 'block' | 'notinterested' | 'report' | 'delete') => {
    const me = meRef.current;
    if (!me) return;
    if (action === 'delete') {
      if (post.user_id !== me) return;
      Alert.alert('Delete drop?', 'This removes it everywhere — likes, comments and replies go too.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('posts').delete().eq('id', post.id).eq('user_id', me);
            removePost(post.id);
          },
        },
      ]);
      return;
    }
    if (action === 'hide' || action === 'notinterested') {
      await supabase.from('hidden_posts').insert({ user_id: me, post_id: post.id });
      removePost(post.id);
      return;
    }
    if (action === 'mute') {
      await supabase.from('muted_users').insert({ user_id: me, muted_id: post.user_id });
      removePost(post.id);
      return;
    }
    if (action === 'block') {
      await supabase.from('blocks').insert({ blocker_id: me, blocked_id: post.user_id });
      removePost(post.id);
      return;
    }
    if (action === 'report') {
      await supabase.from('reports').insert({ reporter_id: me, post_id: post.id, reason: 'reported from viewer' });
    }
  };

  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (first?.index != null) setCurrent(first.index);
  }, []);

  const renderItem = ({ item, index: i }: { item: ViewerPost; index: number }) => (
    <View style={{ height }}>
      <FeedPost
        post={item}
        isActive={i === current}
        height={height}
        contentTop={0}
        contentBottom={28}
        onLike={() => toggleLike(item)}
        onFollow={() => toggleFollow(item)}
        onComment={() => setCommentPost(item)}
        onShare={() => share(item)}
        onSave={() => toggleSave(item)}
        onRepost={() => toggleRepost(item)}
        onOpenProfile={onClose}
        onReact={(r: string) => toggleReaction(item, r)}
        onMenuAction={(a) => personalize(item, a)}
        onOpenSound={() => {
          if (item.audio) setSound(item.audio);
        }}
        onOpenChain={() => {}}
        onExpired={() => removePost(item.id)}
        onReplyWithDrop={() => setCommentPost(item)}
      />
    </View>
  );

  return (
    <View style={styles.fill}>
      <FlatList
        data={items}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        initialScrollIndex={index}
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={2}
      />
      <Pressable style={[styles.closeBtn, { top: Math.max(insets.top, TOP_INSET) + 10 }]} onPress={onClose} hitSlop={10}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
      <CommentsModal
        post={commentPost}
        onClose={() => setCommentPost(null)}
        onPosted={() => {
          const me = meRef.current;
          if (commentPost && me) {
            notifyUser({ userId: commentPost.user_id, actorId: me, type: 'comment', postId: commentPost.id });
          }
        }}
      />
      {sound && <SoundPage name={sound} onClose={() => setSound(null)} onUseSound={() => {}} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  closeBtn: {
    position: 'absolute',
    right: 16,
    zIndex: 20,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    padding: 10,
  },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
