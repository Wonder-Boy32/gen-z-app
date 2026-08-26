import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useInsets } from '../utils/useInsets';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import Avatar from './Avatar';
import Icon from './ui/Icon';
import { NotifyType } from '../utils/notify';

type NotifRow = {
  id: string;
  type: NotifyType;
  read: boolean;
  created_at: string;
  post_id: string | null;
  actor: { username: string; avatar_url: string | null } | null;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

const COPY: Record<NotifyType, (u: string) => string> = {
  follow: (u) => `${u} started following you`,
  like: (u) => `${u} liked your drop`,
  comment: (u) => `${u} commented on your drop`,
  reply: (u) => `${u} replied to your comment`,
  reaction: (u) => `${u} reacted to your drop`,
  repost: (u) => `${u} reposted your drop`,
  comment_like: (u) => `${u} liked your comment`,
};

const ICONS: Record<NotifyType, { icon: 'person-add' | 'heart' | 'chatbubble' | 'repeat' | 'sparkles'; color: string }> = {
  follow: { icon: 'person-add', color: '#4DD8FF' },
  like: { icon: 'heart', color: '#FF3B5C' },
  comment: { icon: 'chatbubble', color: '#8B7BFF' },
  reply: { icon: 'chatbubble', color: '#8B7BFF' },
  reaction: { icon: 'sparkles', color: '#FF7A00' },
  repost: { icon: 'repeat', color: '#34C759' },
  comment_like: { icon: 'heart', color: '#FF3B5C' },
};

export default function NotificationsModal({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const insets = useInsets();
  const [items, setItems] = useState<NotifRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('notifications')
      .select('id, type, read, created_at, post_id, actor:profiles!notifications_actor_id_fkey(username, avatar_url)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setItems((data ?? []) as unknown as NotifRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const markAllRead = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    onChanged?.();
  };

  const clearAll = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('notifications').delete().eq('user_id', user.id);
    setItems([]);
    onChanged?.();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={styles.titleRow}>
              <Icon name="notifications" size={18} color={colors.accent} />
              <Text style={styles.title}>Notifications</Text>
            </View>
            <View style={styles.headerActions}>
              {items.some((n) => !n.read) && (
                <Pressable onPress={markAllRead} hitSlop={6}>
                  <Text style={styles.markText}>Mark all read</Text>
                </Pressable>
              )}
              {items.length > 0 && (
                <Pressable onPress={clearAll} hitSlop={6}>
                  <Text style={styles.clearText}>Clear</Text>
                </Pressable>
              )}
            </View>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <FlatList
              data={items}
              keyExtractor={(n) => n.id}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => {
                const meta = ICONS[item.type];
                return (
                  <View style={[styles.row, !item.read && styles.rowUnread]}>
                    {!item.read && <View style={styles.unreadDot} />}
                    <Avatar url={item.actor?.avatar_url} name={item.actor?.username ?? 'G'} size={38} ring />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowText}>
                        {COPY[item.type](`@${item.actor?.username ?? 'someone'}`)}
                      </Text>
                      <Text style={styles.rowTime}>{timeAgo(item.created_at)}</Text>
                    </View>
                    <Icon name={meta.icon} size={17} color={meta.color} />
                  </View>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  No notifications yet — likes, follows and comments land here.
                </Text>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingHorizontal: 18,
    paddingTop: 10,
    maxHeight: '80%',
    ...shadows.glow,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  markText: { color: colors.cyan, fontSize: 12, fontWeight: '700' },
  clearText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  loader: { paddingVertical: 40 },
  list: { flexGrow: 0 },
  listContent: { paddingBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  rowUnread: {
    backgroundColor: 'rgba(255,122,0,0.07)',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  rowBody: { flex: 1 },
  rowText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  rowTime: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 2,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 32,
    lineHeight: 19,
  },
});
