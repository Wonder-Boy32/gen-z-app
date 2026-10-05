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
 * Notification privacy (spec §41).
 *
 * This matters most on a LOCK SCREEN: a full preview is readable by anyone
 * holding the phone, without unlocking it. So the control that answers
 * "what shows on my lock screen?" is the primary thing on this screen.
 *
 * ──────────────────────────────────────────────────────────────
 * !!! SERVER OWNS THE PUSH PAYLOAD !!!
 * ──────────────────────────────────────────────────────────────
 * This screen ONLY stores the preference. It never composes notification
 * text. When the push is actually delivered, the payload must be BUILT
 * SERVER-SIDE (Supabase edge function / trigger reading this row and
 * emitting a generic body) and never by the sending client — because if
 * the client puts the message text into the push payload, the plaintext
 * still leaves the sender's device and lands in the OS notification
 * service (APNs/FCM), and a `sender`/`none` preference would be a lie.
 * Turning this into real lock-screen privacy is therefore an
 * infrastructure change as much as a UI one.
 *
 * Every control writes through to public.messaging_privacy — the only table
 * that owns these columns — with an optimistic local update and a rollback if
 * the write is rejected (offline, RLS, SQL not run yet). A row may not exist
 * on a fresh account, so we render the table defaults and create the row lazily
 * on the first change via upsert(onConflict: 'user_id').
 */

// ---------------------------------------------------------------
// Table shape — column names copied verbatim from
// supabase/messaging_v2.sql -> create table public.messaging_privacy
//   notification_preview  text not null default 'full'
//     check (notification_preview in ('full','sender','none'))
//   effects_enabled       boolean not null default true
//   link_previews_enabled boolean not null default true
//
// All three columns the screen needs DO exist in the SQL, so all three
// are wired below (nothing is invented).
// ---------------------------------------------------------------
type NotificationPreview = 'full' | 'sender' | 'none';

type NotificationRow = {
  user_id: string;
  notification_preview: NotificationPreview;
  effects_enabled: boolean;
  link_previews_enabled: boolean;
};

type NotificationSettings = Omit<NotificationRow, 'user_id'>;

// SQL defaults: notification_preview defaults to 'full', the two
// booleans default to true.
const DEFAULT_SETTINGS: NotificationSettings = {
  notification_preview: 'full',
  effects_enabled: true,
  link_previews_enabled: true,
};

const SELECT_COLUMNS =
  'user_id, notification_preview, effects_enabled, link_previews_enabled';

// The ONLY values the CHECK constraint allows. Order = most exposed first.
const PREVIEW_OPTIONS: NotificationPreview[] = ['full', 'sender', 'none'];

const PREVIEW_LABEL: Record<NotificationPreview, string> = {
  full: 'Full preview',
  sender: 'Sender only',
  none: 'No preview',
};

/** Plain-English, lock-screen-first captions. */
const PREVIEW_CAPTION: Record<NotificationPreview, string> = {
  full: 'Full preview — anyone holding your phone sees the whole message on the lock screen.',
  sender: 'Sender only — the lock screen shows who messaged you, but not what they said.',
  none: 'No preview — the lock screen only says you have a new message.',
};

function asPreview(value: unknown, fallback: NotificationPreview): NotificationPreview {
  return value === 'full' || value === 'sender' || value === 'none' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Narrow an untyped Supabase row into the settings this screen manages. */
function hydrate(raw: unknown): NotificationSettings {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    notification_preview: asPreview(
      rec.notification_preview,
      DEFAULT_SETTINGS.notification_preview
    ),
    effects_enabled: asBoolean(rec.effects_enabled, DEFAULT_SETTINGS.effects_enabled),
    link_previews_enabled: asBoolean(
      rec.link_previews_enabled,
      DEFAULT_SETTINGS.link_previews_enabled
    ),
  };
}

function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

export default function NotificationSettingsScreen({ onBack }: { onBack: () => void }) {
  const [uid, setUid] = useState<string | null>(null);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setUid(null);
        setSettings({ ...DEFAULT_SETTINGS });
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
      if (readErr) setError(errorText(readErr, 'Could not load your notification settings.'));
      setSettings(hydrate(data));
    } catch (err) {
      setSettings({ ...DEFAULT_SETTINGS });
      setError(errorText(err, 'Could not load your notification settings.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Optimistic write: flip the control locally, then persist. If the write
   * fails we put the previous value back and surface a dismissible error bar.
   */
  const commit = useCallback(
    async (patch: Partial<NotificationSettings>) => {
      const previous = settings;
      if (!previous) return;

      setSettings({ ...previous, ...patch });
      setError(null);

      // Not signed in: keep the local value, there is nothing to persist to.
      if (!uid) return;

      try {
        const { error: writeErr } = await supabase
          .from('messaging_privacy')
          .upsert({ user_id: uid, ...patch }, { onConflict: 'user_id' });

        if (writeErr) {
          setSettings(previous);
          setError(errorText(writeErr, 'Could not save that change. Try again.'));
        }
      } catch (err) {
        setSettings(previous);
        setError(errorText(err, 'Could not save that change. Try again.'));
      }
    },
    [settings, uid]
  );

  const preview = settings?.notification_preview ?? DEFAULT_SETTINGS.notification_preview;

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
        <Text style={styles.title}>Notifications</Text>
        <View style={styles.headerSpacer} />
      </View>
      <Text style={styles.subtitle}>
        Who can see what you received — before you unlock your phone.
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
          {/* ── Lock screen ───────────────────────────────────── */}
          <Text style={styles.sectionHeading}>On the lock screen</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Message previews</Text>
              <Text style={styles.rowCaption}>
                What a notification reveals when your phone is locked.
              </Text>
              <View style={styles.segmented}>
                {PREVIEW_OPTIONS.map((option) => {
                  const selected = preview === option;
                  return (
                    <Pressable
                      key={option}
                      style={[styles.segment, selected && styles.segmentActive]}
                      onPress={() => commit({ notification_preview: option })}
                      accessibilityRole="button"
                      accessibilityLabel={`Lock screen preview: ${PREVIEW_LABEL[option]}`}
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                        {PREVIEW_LABEL[option]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.previewCaption}>{PREVIEW_CAPTION[preview]}</Text>
            </View>
          </View>

          {/* ── Message extras ────────────────────────────────── */}
          <Text style={styles.sectionHeading}>Message extras</Text>
          <View style={styles.card}>
            <SwitchRow
              label="Message effects"
              caption="Play the big full-screen effect when someone sends one."
              value={settings.effects_enabled}
              onChange={(v) => commit({ effects_enabled: v })}
              accessibilityLabel="Play message effects"
            />
            <View style={styles.separator} />
            <SwitchRow
              label="Link previews"
              caption="Show a preview card for links instead of a bare URL."
              value={settings.link_previews_enabled}
              onChange={(v) => commit({ link_previews_enabled: v })}
              accessibilityLabel="Show link previews"
            />
          </View>

          <Text style={styles.footnote}>
            Changes save as you make them. Previews are generated by the server when the push is
            built, so the choice here applies to every device you are signed in on.
          </Text>
        </ScrollView>
      )}
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
  previewCaption: {
    color: colors.accent,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
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
