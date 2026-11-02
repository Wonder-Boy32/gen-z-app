// ============================================================
// ExploreScreen — the page the feed's clutter moved into
// ============================================================
//
// WHY THIS EXISTS
//   The feed used to carry four things at once on top of the video: a floating
//   GEN Z DROP banner pinned at safeTop+196, a "Create a Drop" CTA, an "Invite
//   friends" row and a "Discover something new" carousel. Over a real post that
//   meant the banner covered the caption; over an empty feed it meant ghost
//   text bleeding through the translucent banner card.
//
//   None of it belongs ON a video. It is all "what else can I do", so it lives
//   on one page reached from the compass button in the feed's top bar. The feed
//   goes back to being a feed.
//
// The Drop banner stays reproducible here rather than being deleted: joining a
// live Drop is a real action and it needed a home that is not the video surface.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../supabase/client';
import { colors, radius } from '../theme';
import { useInsets } from '../utils/useInsets';
import Icon from '../components/ui/Icon';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Button from '../components/Button';
import DropCountdown from '../components/DropCountdown';
import InviteSheet from '../components/InviteSheet';

type Drop = {
  id: string;
  prompt: string;
  status: 'live' | 'voting' | string;
  ends_at: string | null;
  voting_ends_at: string | null;
};

type Person = {
  id: string;
  username: string;
  avatar_url: string | null;
  verified?: boolean;
  following?: boolean;
};

type Props = {
  onCreate: () => void;
  onSearch: () => void;
  onJoinDrop: (dropId: string) => void;
  onOpenUser: (id: string, username: string) => void;
  onClose: () => void;
};

export default function ExploreScreen({
  onCreate,
  onSearch,
  onJoinDrop,
  onOpenUser,
  onClose,
}: Props) {
  const insets = useInsets();
  const [drop, setDrop] = useState<Drop | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Resolved from the local session, not supabase.auth.getUser(): that call is
  // a network round-trip on every mount and a known cause of spurious sign-outs
  // when it lands during a token refresh.
  const [myId, setMyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    const { data: sess } = await supabase.auth.getSession();
    const me = sess.session?.user?.id ?? null;
    setMyId(me);

    // Same query the feed used for its floating banner: the newest Drop that is
    // still open for entries or votes. `.limit(1)` because the page shows one,
    // not a list — an older Drop is not "active" just because it is recent.
    const [dropRes, followRes] = await Promise.all([
      supabase
        .from('drops')
        .select('*')
        .in('status', ['live', 'voting'])
        .order('starts_at', { ascending: false })
        .limit(1),
      supabase.from('follows').select('following_id').eq('follower_id', me ?? ''),
    ]);

    setDrop(((dropRes.data ?? [])[0] as Drop) ?? null);
    const followed = new Set((followRes.data ?? []).map((f) => f.following_id));

    const { data: profs } = await supabase
      .from('profiles')
      .select('id, username, avatar_url, verified')
      .neq('id', me ?? '')
      .order('created_at', { ascending: false })
      .limit(12);

    setPeople(
      ((profs ?? []) as Person[]).map((p) => ({ ...p, following: followed.has(p.id) }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const follow = async (id: string) => {
    if (!myId) return;
    // Optimistic: the row is the whole interaction, and a failed insert is
    // reverted by the reload rather than left looking followed.
    setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, following: true } : p)));
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: myId, following_id: id });
    if (error) void load();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.eyebrow}>EXPLORE</Text>
          <Text style={styles.title}>More to do</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn} accessibilityLabel="Close explore">
          <Icon name="close" size={20} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* one search entry — the compass replaced the top-bar magnifier, so
            search has to remain reachable from here in one tap */}
        <Pressable style={styles.searchRow} onPress={onSearch}>
          <Icon name="search-outline" size={17} color={colors.textMuted} />
          <Text style={styles.searchText}>Search people, Drops, sounds</Text>
        </Pressable>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <>
            {drop ? (
              <Pressable style={styles.dropCard} onPress={() => onJoinDrop(drop.id)}>
                <View style={styles.dropHead}>
                  {drop.status === 'live' ? (
                    <View style={styles.liveBadge}>
                      <View style={styles.liveDot} />
                      <Text style={styles.liveText}>LIVE</Text>
                    </View>
                  ) : (
                    <View style={[styles.liveBadge, styles.votingBadge]}>
                      <Text style={[styles.liveText, styles.votingText]}>VOTING</Text>
                    </View>
                  )}
                  <View style={styles.dropTitleRow}>
                    <Icon name="megaphone-outline" size={13} color={colors.accent} />
                    <Text style={styles.dropTitle}>GEN Z DROP</Text>
                  </View>
                </View>

                <Text style={styles.dropPrompt} numberOfLines={2}>
                  “{drop.prompt}”
                </Text>

                <View style={styles.dropFoot}>
                  {/* ends_at / voting_ends_at are nullable in the table, and a
                      countdown with no end time would render as if it had one.
                      Show the phase label instead of a fake clock. */}
                  {drop.status === 'live' && drop.ends_at ? (
                    <DropCountdown endsAt={drop.ends_at} mode="live" />
                  ) : drop.status !== 'live' && drop.voting_ends_at ? (
                    <DropCountdown endsAt={drop.voting_ends_at} mode="voting" />
                  ) : (
                    <Text style={styles.dropPhaseText}>
                      {drop.status === 'live' ? 'Entries open' : 'Voting open'}
                    </Text>
                  )}
                  <View style={styles.joinPill}>
                    <Text style={styles.joinPillText}>JOIN DROP →</Text>
                  </View>
                </View>
              </Pressable>
            ) : (
              <View style={styles.emptyDrop}>
                <Icon name="megaphone-outline" size={18} color={colors.textMuted} />
                <Text style={styles.emptyDropText}>
                  No Drop is running right now. Start the next one.
                </Text>
              </View>
            )}

            <Button title="Create a Drop" onPress={onCreate} style={styles.createCta} />

            <Pressable style={styles.inviteRow} onPress={() => setInviteOpen(true)}>
              <View style={styles.inviteIcon}>
                <Icon name="person-add-outline" size={17} color={colors.accent} />
              </View>
              <View style={styles.inviteCopy}>
                <Text style={styles.inviteTitle}>Invite friends to Gen Z</Text>
                <Text style={styles.inviteSub}>The feed only gets good with people on it.</Text>
              </View>
              <Icon name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>

            {people.length > 0 && (
              <View style={styles.peopleWrap}>
                <View style={styles.sectionRow}>
                  <Icon name="flame" size={15} color={colors.accent} />
                  <Text style={styles.sectionTitle}>Discover something new</Text>
                </View>

                {people.map((p) => (
                  <Pressable
                    key={p.id}
                    style={styles.personRow}
                    onPress={() => onOpenUser(p.id, p.username)}
                  >
                    {p.avatar_url ? (
                      <Image source={{ uri: p.avatar_url }} style={styles.avatar} />
                    ) : (
                      <View style={[styles.avatar, styles.avatarPlaceholder]}>
                        <Text style={styles.avatarLetter}>
                          {p.username.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}

                    <View style={styles.personNameRow}>
                      <Text style={styles.personName} numberOfLines={1}>
                        @{p.username}
                      </Text>
                      {!!p.verified && <VerifiedBadge size={11} glow={false} />}
                    </View>

                    <Pressable
                      style={[styles.followBtn, p.following && styles.followBtnOn]}
                      onPress={() => {
                        if (!p.following) void follow(p.id);
                      }}
                      hitSlop={4}
                      disabled={!!p.following}
                    >
                      <Icon
                        name={p.following ? 'checkmark' : 'add'}
                        size={12}
                        color={p.following ? colors.accent : '#0B0A14'}
                      />
                      <Text style={[styles.followText, p.following && styles.followTextOn]}>
                        {p.following ? 'Following' : 'Follow'}
                      </Text>
                    </Pressable>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitleWrap: { flex: 1 },
  eyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 3 },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  body: { paddingHorizontal: 20, paddingTop: 16 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  searchText: { color: colors.textMuted, fontSize: 14 },
  loadingWrap: { paddingVertical: 48, alignItems: 'center' },

  dropCard: {
    marginTop: 18,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  dropHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  votingBadge: { backgroundColor: colors.surfaceAlt },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
  liveText: { color: colors.danger, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  votingText: { color: colors.textMuted },
  dropTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dropTitle: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  dropPrompt: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 8,
    lineHeight: 22,
  },
  dropFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  joinPill: {
    backgroundColor: colors.accent,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  joinPillText: { color: '#0B0A14', fontSize: 12, fontWeight: '800' },
  dropPhaseText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  emptyDrop: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  emptyDropText: { color: colors.textMuted, fontSize: 13, flex: 1, lineHeight: 19 },

  createCta: { marginTop: 16 },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  inviteIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  inviteCopy: { flex: 1 },
  inviteTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  inviteSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  peopleWrap: { marginTop: 20 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceAlt },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: colors.accent, fontSize: 17, fontWeight: '800' },
  personNameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  personName: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  followBtnOn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  followText: { color: '#0B0A14', fontSize: 12, fontWeight: '800' },
  followTextOn: { color: colors.accent },
});
