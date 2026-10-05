import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { supabase } from '../supabase/client';
import { colors, radius, spacing } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import Icon from '../components/ui/Icon';

/**
 * Messaging privacy centre (spec §35).
 *
 * Every control writes straight through to public.messaging_privacy — the only
 * table that owns these switches — with an optimistic local update and a
 * rollback if the write is rejected (offline, RLS, SQL not run yet). A row may
 * not exist on a fresh account, so we render the table defaults and create the
 * row lazily on the first change via upsert(onConflict: 'user_id').
 */

// ---------------------------------------------------------------
// Table shape — column names copied verbatim from
// supabase/messaging_v2.sql -> create table public.messaging_privacy
// (user_id, who_can_message, who_can_call, who_can_add_to_groups,
//  who_can_see_moments, show_online, show_last_seen, read_receipts,
//  typing_indicators, notification_preview, effects_enabled,
//  link_previews_enabled, updated_at).
// Only the columns this screen owns are listed here.
// ---------------------------------------------------------------
type Audience = 'everyone' | 'followers' | 'nobody';

type PrivacyRow = {
  user_id: string;
  who_can_message: Audience;
  who_can_call: Audience;
  who_can_add_to_groups: Audience;
  show_online: boolean;
  show_last_seen: boolean;
  read_receipts: boolean;
  typing_indicators: boolean;
};

type PrivacySettings = Omit<PrivacyRow, 'user_id'>;

// SQL defaults: the three audience columns default to 'everyone',
// the four booleans default to true.
const DEFAULT_PRIVACY: PrivacySettings = {
  who_can_message: 'everyone',
  who_can_call: 'everyone',
  who_can_add_to_groups: 'everyone',
  show_online: true,
  show_last_seen: true,
  read_receipts: true,
  typing_indicators: true,
};

const SELECT_COLUMNS =
  'user_id, who_can_message, who_can_call, who_can_add_to_groups, show_online, show_last_seen, read_receipts, typing_indicators';

const AUDIENCES: Audience[] = ['everyone', 'followers', 'nobody'];

const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'Everyone',
  followers: 'Followers',
  nobody: 'Nobody',
};

const READ_RECEIPTS_CAPTION =
  "If you turn off read receipts, you also stop seeing other people's.";
const TYPING_CAPTION =
  "If you turn off typing indicators, you also stop seeing when other people are typing.";

function asAudience(value: unknown, fallback: Audience): Audience {
  return value === 'everyone' || value === 'followers' || value === 'nobody' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Narrow an untyped Supabase row into the settings this screen manages. */
function hydrate(raw: unknown): PrivacySettings {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    who_can_message: asAudience(rec.who_can_message, DEFAULT_PRIVACY.who_can_message),
    who_can_call: asAudience(rec.who_can_call, DEFAULT_PRIVACY.who_can_call),
    who_can_add_to_groups: asAudience(
      rec.who_can_add_to_groups,
      DEFAULT_PRIVACY.who_can_add_to_groups
    ),
    show_online: asBoolean(rec.show_online, DEFAULT_PRIVACY.show_online),
    show_last_seen: asBoolean(rec.show_last_seen, DEFAULT_PRIVACY.show_last_seen),
    read_receipts: asBoolean(rec.read_receipts, DEFAULT_PRIVACY.read_receipts),
    typing_indicators: asBoolean(rec.typing_indicators, DEFAULT_PRIVACY.typing_indicators),
  };
}

function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

export default function PrivacyScreen({ onBack }: { onBack: () => void }) {
  const [uid, setUid] = useState<string | null>(null);
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setUid(null);
      setSettings({ ...DEFAULT_PRIVACY });
      setLoading(false);
      return;
    }
    setUid(user.id);

    const { data, error: readErr } = await supabase
      .from('messaging_privacy')
      .select(SELECT_COLUMNS)
      .eq('user_id', user.id)
      .maybeSingle();

    // No row yet is normal (upserted on first change); a read error is shown
    // but never blocks the screen — the user still gets working controls.
    if (readErr) setError(errorText(readErr, 'Could not load your privacy settings.'));
    setSettings(hydrate(data));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Optimistic write: flip the control locally, then persist. If the write
   * fails we put the previous value back and surface a dismissible error bar.
   */
  const commit = useCallback(
    async (patch: Partial<PrivacySettings>) => {
      const previous = settings;
      if (!previous) return;

      setSettings({ ...previous, ...patch });
      setError(null);

      // Not signed in: keep the local value, there is nothing to persist to.
      if (!uid) return;

      const { error: writeErr } = await supabase
        .from('messaging_privacy')
        .upsert({ user_id: uid, ...patch }, { onConflict: 'user_id' });

      if (writeErr) {
        setSettings(previous);
        setError(errorText(writeErr, 'Could not save that change. Try again.'));
      }
    },
    [settings, uid]
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable
          onPress={onBack}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Icon name="chevron-back" size={20} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Privacy</Text>
        <View style={styles.headerSpacer} />
      </View>
      <Text style={styles.subtitle}>
        Who gets through to you, what you show, and what you see back.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {header}

      {error ? (
        <View style={styles.errorBar} accessibilityRole="alert">
          <Icon name="alert-circle-outline" size={15} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => setError(null)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Dismiss error"
          >
            <Icon name="close" size={16} color={colors.danger} />
          </Pressable>
        </View>
      ) : null}

      {loading || !settings ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* ── Who can reach me ─────────────────────────────── */}
          <Text style={styles.sectionHeading}>Who can reach me</Text>
          <View style={styles.card}>
            <SegmentedRow
              label="Message me"
              value={settings.who_can_message}
              onChange={(v) => commit({ who_can_message: v })}
              accessibilityLabel="Who can message me"
            />
            <View style={styles.separator} />
            <SegmentedRow
              label="Call me"
              value={settings.who_can_call}
              onChange={(v) => commit({ who_can_call: v })}
              accessibilityLabel="Who can call me"
            />
            <View style={styles.separator} />
            <SegmentedRow
              label="Add me to groups"
              value={settings.who_can_add_to_groups}
              onChange={(v) => commit({ who_can_add_to_groups: v })}
              accessibilityLabel="Who can add me to groups"
            />
          </View>

          {/* ── What I show ──────────────────────────────────── */}
          <Text style={styles.sectionHeading}>What I show</Text>
          <View style={styles.card}>
            <SwitchRow
              label="Online status"
              caption="Let people see when you're in the app."
              value={settings.show_online}
              onChange={(v) => commit({ show_online: v })}
              accessibilityLabel="Show when I am online"
            />
            <View style={styles.separator} />
            <SwitchRow
              label="Last seen"
              caption="Hide the last time you opened the app."
              value={settings.show_last_seen}
              onChange={(v) => commit({ show_last_seen: v })}
              accessibilityLabel="Show my last seen time"
            />
          </View>

          {/* ── Receipts ─────────────────────────────────────── */}
          <Text style={styles.sectionHeading}>Receipts</Text>
          <View style={styles.card}>
            <SwitchRow
              label="Read receipts"
              caption={READ_RECEIPTS_CAPTION}
              value={settings.read_receipts}
              onChange={(v) => commit({ read_receipts: v })}
              accessibilityLabel="Send read receipts"
            />
            <View style={styles.separator} />
            <SwitchRow
              label="Typing indicators"
              caption={TYPING_CAPTION}
              value={settings.typing_indicators}
              onChange={(v) => commit({ typing_indicators: v })}
              accessibilityLabel="Send typing indicators"
            />
          </View>

          <Text style={styles.footnote}>
            Changes save as you make them. Blocked people and deleted requests never reach your
            inbox.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function SegmentedRow({
  label,
  value,
  onChange,
  accessibilityLabel,
}: {
  label: string;
  value: Audience;
  onChange: (next: Audience) => void;
  accessibilityLabel: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segmented}>
        {AUDIENCES.map((option) => {
          const selected = value === option;
          return (
            <Pressable
              key={option}
              style={[styles.segment, selected && styles.segmentActive]}
              onPress={() => onChange(option)}
              accessibilityRole="button"
              accessibilityLabel={`${accessibilityLabel}: ${AUDIENCE_LABEL[option]}`}
              accessibilityState={{ selected }}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                {AUDIENCE_LABEL[option]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SwitchRow({
  label,
  caption,
  value,
  onChange,
  accessibilityLabel,
}: {
  label: string;
  caption?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  accessibilityLabel: string;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchInfo}>
        <Text style={styles.rowLabel}>{label}</Text>
        {caption ? <Text style={styles.rowCaption}>{caption}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        trackColor={{ false: colors.border, true: colors.accentSoft }}
        thumbColor={value ? colors.accent : colors.textFaint}
        ios_backgroundColor={colors.border}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: TOP_INSET + 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 72,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 2,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  headerSpacer: {
    minWidth: 72,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.2,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surfaceAlt,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontSize: 13,
    fontWeight: '500',
  },
  loader: {
    marginTop: spacing.xl,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sectionHeading: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },
  row: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 21,
  },
  rowCaption: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    padding: 3,
    marginTop: spacing.sm,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  segmentTextActive: {
    color: colors.bg,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  switchInfo: {
    flex: 1,
  },
  footnote: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.lg,
    marginHorizontal: spacing.xs,
  },
});
