import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import PublicProfileScreen from './PublicProfileScreen';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Icon from '../components/ui/Icon';

// Shared with ProfileScreen: the timestamp of the last time the owner
// opened this screen, so the eye icon can badge what is new since then.
export const PROFILE_VIEWS_SEEN_KEY = '@genz/profile_views_seen_at';

type ViewerRow = {
  viewer_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
  view_count: number;
  last_viewed_at: string;
  first_viewed_at: string;
};

type Stats = {
  total_viewers: number;
  total_views: number;
  viewers_7d: number;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function isFresh(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() < 24 * 60 * 60 * 1000;
}

export default function ProfileViewersScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<ViewerRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [publicProfile, setPublicProfile] = useState<{ id: string; username: string } | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const [viewers, summary] = await Promise.all([
      supabase.rpc('my_profile_viewers', { p_limit: 200 }),
      supabase.rpc('my_profile_view_stats', { p_since: null }),
    ]);

    // The SQL file has not been run yet - show setup instructions instead
    // of an error, and keep the rest of the app untouched.
    if (viewers.error || summary.error) {
      setNeedsSetup(true);
      setRows([]);
      setStats(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setNeedsSetup(false);
    setRows((viewers.data ?? []) as ViewerRow[]);

    const rawStats = Array.isArray(summary.data) ? summary.data[0] : summary.data;
    setStats(
      rawStats
        ? {
            total_viewers: Number(rawStats.total_viewers ?? 0),
            total_views: Number(rawStats.total_views ?? 0),
            viewers_7d: Number(rawStats.viewers_7d ?? 0),
          }
        : null
    );

    // everything on screen is now "seen" - clears the badge on the profile page
    AsyncStorage.setItem(PROFILE_VIEWS_SEEN_KEY, new Date().toISOString()).catch(() => {});

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Icon name="chevron-back" size={20} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Profile views</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.privacyPill}>
        <Icon name="eye-outline" size={12} color={colors.accent} />
        <Text style={styles.privacyText}>Only you can see who viewed your profile</Text>
      </View>
    </View>
  );

  const statStrip = stats && stats.total_viewers > 0 && (
    <View style={styles.statStrip}>
      <View style={styles.statCell}>
        <View style={styles.statIconRow}>
          <Icon name="people-outline" size={13} color={colors.accent} />
          <Text style={styles.statNumber}>{stats.total_viewers}</Text>
        </View>
        <Text style={styles.statLabel}>viewers</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statCell}>
        <View style={styles.statIconRow}>
          <Icon name="eye-outline" size={13} color={colors.cyan} />
          <Text style={styles.statNumber}>{stats.total_views}</Text>
        </View>
        <Text style={styles.statLabel}>total views</Text>
      </View>
      <View style={styles.statDivider} />
      <View style={styles.statCell}>
        <View style={styles.statIconRow}>
          <Icon name="trending-up" size={13} color={colors.success} />
          <Text style={styles.statNumber}>{stats.viewers_7d}</Text>
        </View>
        <Text style={styles.statLabel}>last 7 days</Text>
      </View>
    </View>
  );

  const setupCard = (
    <View style={styles.setupCard}>
      <Icon name="construct-outline" size={22} color={colors.accent} />
      <Text style={styles.setupTitle}>Turn profile views on</Text>
      <Text style={styles.setupBody}>
        Run supabase/profile_views.sql once in your Supabase SQL editor. From then on every
        visit to your profile is counted and listed right here.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {header}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : needsSetup ? (
        setupCard
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.viewer_id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          ListHeaderComponent={
            <View>
              {statStrip}
              {rows.length > 0 && (
                <Text style={styles.listHeading}>
                  {rows.length > 1 ? 'People who viewed you' : 'The only person so far'}
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => setPublicProfile({ id: item.viewer_id, username: item.username })}
            >
              <Avatar
                url={item.avatar_url}
                name={item.display_name || item.username}
                size={44}
                ring
                verified={!!item.verified}
              />
              <View style={styles.info}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.display_name || item.username}
                  </Text>
                  {!!item.verified && <VerifiedBadge size={12} glow={false} style={styles.verifiedInline} />}
                  {isFresh(item.last_viewed_at) && (
                    <View style={styles.newChip}>
                      <Text style={styles.newChipText}>New</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.handle} numberOfLines={1}>
                  @{item.username}
                </Text>
                <View style={styles.metaRow}>
                  <Icon name="eye-outline" size={11} color={colors.textFaint} />
                  <Text style={styles.metaText}>
                    {item.view_count > 1 ? `Viewed ${item.view_count}x` : 'Viewed once'}
                    {' \u00B7 '}
                    {timeAgo(item.last_viewed_at)}
                  </Text>
                </View>
              </View>
              <Icon name="chevron-forward" size={17} color={colors.textFaint} />
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Icon name="eye-off-outline" size={26} color={colors.textFaint} />
              <Text style={styles.emptyTitle}>No profile views yet</Text>
              <Text style={styles.emptyBody}>
                When someone opens your profile they will show up here with the date and how many
                times they came back.
              </Text>
            </View>
          }
        />
      )}

      {publicProfile && (
        <PublicProfileScreen
          userId={publicProfile.id}
          username={publicProfile.username}
          onClose={() => setPublicProfile(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtn: {
    width: 80,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 80,
  },
  privacyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 5,
    marginTop: 9,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  privacyText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '600',
  },
  loader: {
    flex: 1,
  },
  statStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
  },
  statIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statNumber: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3,
  },
  statDivider: {
    width: 1,
    height: 26,
    backgroundColor: colors.border,
  },
  listHeading: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: 20,
    marginBottom: 4,
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  info: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    maxWidth: '70%',
  },
  verifiedInline: {
    marginLeft: 4,
  },
  newChip: {
    marginLeft: 6,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  newChipText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
  },
  handle: {
    color: colors.textMuted,
    fontSize: 12.5,
    marginTop: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 3,
  },
  metaText: {
    color: colors.textFaint,
    fontSize: 11.5,
    fontWeight: '600',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 40,
    marginTop: 70,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 12,
  },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 6,
  },
  setupCard: {
    margin: 20,
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
  },
  setupTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 10,
  },
  setupBody: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 6,
  },
});
