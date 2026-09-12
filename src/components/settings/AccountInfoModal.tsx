import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../../supabase/client';
import { colors, radius } from '../../theme';
import { copyToClipboard } from '../../utils/clipboard';
import type { AccountStats } from '../../utils/accountStats';
import Avatar from '../Avatar';
import Icon from '../ui/Icon';
import VerifiedBadge from '../ui/VerifiedBadge';

type ProfileLike = {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  verified?: boolean;
  created_at?: string;
} | null;

type AuthFacts = {
  id: string;
  email: string | null;
  provider: string | null;
  createdAt: string | null;
  lastSignIn: string | null;
  emailConfirmed: string | null;
};

function fmt(value: string | null | undefined): string {
  if (!value) return 'Not set';
  try {
    return new Date(value).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Not set';
  }
}

function InfoRow({
  label,
  value,
  onCopy,
  copied,
  mono,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowRight}>
        <Text style={[styles.rowValue, mono && styles.rowValueMono]} numberOfLines={2}>
          {value}
        </Text>
        {!!onCopy && (
          <Pressable onPress={onCopy} hitSlop={8}>
            <Icon
              name={copied ? 'checkmark-circle' : 'copy-outline'}
              size={16}
              color={copied ? colors.success : colors.accent}
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function AccountInfoModal({
  visible,
  onClose,
  profile,
  stats,
  security,
}: {
  visible: boolean;
  onClose: () => void;
  profile: ProfileLike;
  stats: AccountStats | null;
  security: { phone: string | null; phone_verified: boolean; mfa_enabled: boolean } | null;
}) {
  const [facts, setFacts] = useState<AuthFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!visible) return;
      setLoading(true);
      const { data } = await supabase.auth.getUser();
      const u = data.user;
      if (!alive) return;
      setFacts(
        u
          ? {
              id: u.id,
              email: u.email ?? null,
              provider: (u.app_metadata as { provider?: string } | undefined)?.provider ?? null,
              createdAt: u.created_at ?? null,
              lastSignIn: u.last_sign_in_at ?? null,
              emailConfirmed: u.email_confirmed_at ?? null,
            }
          : null
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) setCopiedField(null);
  }, [visible]);

  const copy = async (field: string, value: string) => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      Alert.alert('Copy unavailable', value);
      return;
    }
    setCopiedField(field);
    setTimeout(() => setCopiedField((c) => (c === field ? null : c)), 1800);
  };

  const stat = (label: string, value: number | null | undefined) =>
    value === null || value === undefined ? null : (
      <View key={label} style={styles.statBox}>
        <Text style={styles.statNumber}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Account information</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="close-outline" size={24} color={colors.text} />
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.identity}>
                <Avatar
                  url={profile?.avatar_url}
                  name={profile?.display_name || profile?.username || 'G'}
                  size={64}
                  ring
                  verified={!!profile?.verified}
                />
                <View style={styles.identityInfo}>
                  <View style={styles.identityNameRow}>
                    <Text style={styles.identityName} numberOfLines={1}>
                      {profile?.display_name || profile?.username || 'Gen Z user'}
                    </Text>
                    {!!profile?.verified && <VerifiedBadge size={14} glow={false} />}
                  </View>
                  <Text style={styles.identityHandle}>@{profile?.username ?? 'unknown'}</Text>
                </View>
              </View>

              {!!stats && (
                <View style={styles.statsRow}>
                  {stat('posts', stats.posts)}
                  {stat('comments', stats.comments)}
                  {stat('likes given', stats.likesGiven)}
                  {stat('followers', stats.followers)}
                  {stat('following', stats.following)}
                </View>
              )}

              <Text style={styles.sectionLabel}>Sign-in</Text>
              <View style={styles.card}>
                <InfoRow label="Email" value={facts?.email ?? 'Not set'} />
                <InfoRow
                  label="Email confirmed"
                  value={facts?.emailConfirmed ? fmt(facts.emailConfirmed) : 'Not confirmed yet'}
                />
                <InfoRow label="Sign-in method" value={facts?.provider ?? 'email'} />
                <InfoRow
                  label="Phone"
                  value={security?.phone ? `${security.phone}${security.phone_verified ? ' (verified)' : ''}` : 'Not set'}
                />
                <InfoRow
                  label="Two-factor"
                  value={security?.mfa_enabled ? 'Enabled - authenticator app' : 'Off'}
                />
                <InfoRow label="Last sign-in" value={fmt(facts?.lastSignIn)} />
              </View>

              <Text style={styles.sectionLabel}>Identity</Text>
              <View style={styles.card}>
                <InfoRow label="Username" value={`@${profile?.username ?? 'unknown'}`} />
                <InfoRow
                  label="Member since"
                  value={fmt(profile?.created_at ?? facts?.createdAt)}
                />
                <InfoRow
                  label="Account ID"
                  value={facts?.id ?? 'Unknown'}
                  mono
                  copied={copiedField === 'id'}
                  onCopy={() => facts?.id && copy('id', facts.id)}
                />
              </View>

              <Text style={styles.fineprint}>
                Keep your account ID private. Support may ask for it when you report a problem.
              </Text>
            </ScrollView>
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
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '90%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  loader: { paddingVertical: 40 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  identityInfo: { flex: 1 },
  identityNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  identityName: { color: colors.text, fontSize: 17, fontWeight: '800', maxWidth: '82%' },
  identityHandle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  statBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minWidth: 84,
  },
  statNumber: { color: colors.text, fontSize: 15, fontWeight: '800' },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    gap: 12,
  },
  rowLabel: { color: colors.textMuted, fontSize: 13 },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
    maxWidth: '62%',
    justifyContent: 'flex-end',
  },
  rowValue: { color: colors.text, fontSize: 13, fontWeight: '600', textAlign: 'right' },
  rowValueMono: { fontSize: 11.5, fontWeight: '500' },
  fineprint: { color: colors.textFaint, fontSize: 11.5, lineHeight: 17 },
});
