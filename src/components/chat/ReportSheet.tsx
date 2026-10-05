import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../supabase/client';
import { colors, radius, shadows, spacing, type } from '../../theme';
import { friendlyError } from '../../utils/friendlyError';

// ------------------------------------------------------------------
// ReportSheet — §34 reporting / moderation.
//
// SCHEMA NOTE (read from supabase/chat_settings.sql + admin_center.sql):
// public.chat_reports has NO reason/details/note column. Its exact columns are:
//   id, reporter_id, conversation_id, reported_user_id,
//   created_at, status, severity, message_id,
//   resolved_by, resolved_at, resolution,
//   evidence            <- added by supabase/report_evidence.sql
//
// `evidence` (jsonb) holds a snapshot of the reported message, because
// `message_id` alone is a pointer to something routinely deleted before a
// moderator ever sees it.
// `status` is the only CHECK-constrained enum ('open','resolved','dismissed').
// `severity` is free text (default 'medium'); the admin queue renders it as a
// badge and filters on critical | high | medium | low. Because there is no
// reason column, the picked reason is MAPPED onto `severity` using one of those
// allowed values, and `status` is written as the allowed value 'open'.
// ------------------------------------------------------------------

type Props = {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  messageId?: string | null;
  reportedUserId?: string | null;
  /**
   * The message being reported, as-is.
   *
   * Passed whole and read defensively below rather than typed field-by-field:
   * the message envelope has fourteen variants (messaging/types.ts
   * MESSAGE_KINDS) with different payload shapes, and a report that FAILS TO
   * FILE because one field was renamed is far worse than one holding a
   * loosely-shaped snapshot. Unknown/absent keys simply come out null.
   */
  snapshot?: unknown;
  onSubmit?: () => void;
};

/**
 * Freeze the reportable content at the moment of reporting.
 *
 * This is the whole point of the evidence column: `message_id` is a pointer, and
 * the thing it points at is routinely gone by the time a moderator looks —
 * the expiry purge deletes it, the sender can delete it, and view-once NULLs
 * media_url and content the instant it is opened. A report must not depend on
 * the original still existing.
 */
function buildEvidence(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const src = snapshot as Record<string, unknown>;

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null;
  /** First present, non-empty value among several possible key spellings. */
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const got = str(src[k]);
      if (got) return got;
    }
    return null;
  };

  // The typed payload — a union member like { type: 'text', text } or
  // { type: 'image', caption }.
  const body = (src.body ?? src.payload) as Record<string, unknown> | null | undefined;
  const bodyStr = (...keys: string[]): string | null => {
    if (!body || typeof body !== 'object') return null;
    for (const k of keys) {
      const got = str(body[k]);
      if (got) return got;
    }
    return null;
  };

  const sender = src.sender as Record<string, unknown> | null | undefined;

  return {
    captured_at: new Date().toISOString(),
    kind: pick('kind', 'msg_type', 'messageKind', 'type'),
    text: pick('text', 'content', 'caption') ?? bodyStr('text', 'caption', 'fileName'),
    media_url: pick('mediaUrl', 'media_url'),
    sender_id: pick('senderId', 'sender_id'),
    sender_username:
      pick('senderUsername', 'sender_username') ??
      (sender && typeof sender === 'object' ? str(sender.username) : null),
    sent_at: pick('createdAt', 'created_at', 'sentAt'),
  };
}

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Severity = 'low' | 'medium' | 'high';

type Reason = {
  key: string;
  label: string;
  icon: IconName;
  severity: Severity;
};

const REASONS: Reason[] = [
  { key: 'spam', label: 'Spam', icon: 'mail-unread-outline', severity: 'low' },
  { key: 'harassment', label: 'Harassment or bullying', icon: 'alert-circle-outline', severity: 'high' },
  { key: 'scam', label: 'Scam or fraud', icon: 'card-outline', severity: 'high' },
  { key: 'impersonation', label: 'Impersonation', icon: 'person-remove-outline', severity: 'medium' },
  { key: 'inappropriate', label: 'Inappropriate content', icon: 'eye-off-outline', severity: 'medium' },
  { key: 'abusive', label: 'Abusive behaviour', icon: 'hand-left-outline', severity: 'high' },
  { key: 'suspicious', label: 'Suspicious account', icon: 'help-buoy-outline', severity: 'medium' },
];

export default function ReportSheet({
  visible,
  onClose,
  conversationId,
  messageId,
  reportedUserId,
  snapshot,
  onSubmit,
}: Props) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setSelectedKey(null);
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const selected = REASONS.find((r) => r.key === selectedKey) ?? null;

  const submit = async () => {
    if (!selected || busy) return;

    setBusy(true);
    setError(null);

    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid: string | undefined = auth?.user?.id;

      if (!uid) {
        setError('You need to be signed in to send a report.');
        setBusy(false);
        return;
      }

      if (!reportedUserId) {
        setError('We could not tell who to report in this chat.');
        setBusy(false);
        return;
      }

      // chat_reports.reported_user_id is NOT NULL, so it is always sent here.
      const payload: {
        reporter_id: string;
        conversation_id: string;
        reported_user_id: string;
        status: 'open';
        severity: Severity;
        message_id?: string;
        evidence?: Record<string, unknown>;
      } = {
        reporter_id: uid,
        conversation_id: conversationId,
        reported_user_id: reportedUserId,
        status: 'open',
        severity: selected.severity,
      };

      if (messageId) payload.message_id = messageId;

      // The snapshot is written in the SAME insert as the report, so a report can
      // never exist without its evidence — the two cannot drift apart or be
      // half-written. Only attach it when we actually captured something, so we
      // don't store an empty object that reads as "evidence present".
      const evidence = buildEvidence(snapshot);
      if (evidence && (evidence.text || evidence.media_url || evidence.kind)) {
        payload.evidence = evidence;
      }

      const { error: insertError } = await supabase.from('chat_reports').insert(payload);

      if (insertError) {
        setError(friendlyError(insertError, 'Could not send the report. Please try again.'));
        setBusy(false);
        return;
      }

      setBusy(false);
      onSubmit?.();
      onClose();
    } catch (e) {
      setError(friendlyError(e, 'Could not send the report. Please try again.'));
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        style={styles.overlay}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close report sheet"
      >
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title}>Report</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close report sheet"
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <Text style={styles.subtitle}>Why are you reporting this?</Text>

          <ScrollView bounces={false} style={styles.list}>
            {REASONS.map((reason) => {
              const on = reason.key === selectedKey;
              return (
                <Pressable
                  key={reason.key}
                  onPress={() => {
                    setSelectedKey(reason.key);
                    setError(null);
                  }}
                  style={[styles.reasonRow, on && styles.reasonRowOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Report reason: ${reason.label}`}
                >
                  <View style={[styles.reasonIcon, on && styles.reasonIconOn]}>
                    <Ionicons name={reason.icon} size={19} color={on ? colors.accent : colors.textMuted} />
                  </View>
                  <Text style={[styles.reasonLabel, on && styles.reasonLabelOn]}>{reason.label}</Text>
                  {on && <Ionicons name="checkmark-circle" size={20} color={colors.accent} />}
                </Pressable>
              );
            })}
          </ScrollView>

          {error && <Text style={styles.error}>{error}</Text>}

          {selected && (
            <Pressable
              onPress={() => void submit()}
              disabled={busy}
              style={[styles.submitBtn, busy && styles.submitBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Submit report"
              accessibilityState={{ disabled: busy }}
            >
              {busy ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.submitText}>Submit report</Text>
              )}
            </Pressable>
          )}
        </Pressable>
      </Pressable>
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
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '82%',
    paddingBottom: spacing.xl,
    ...shadows.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  title: {
    ...type.heading,
    color: colors.text,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.md,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  reasonRowOn: {
    backgroundColor: colors.accentSoft,
  },
  reasonIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reasonIconOn: {
    backgroundColor: colors.surface,
  },
  reasonLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  reasonLabelOn: {
    color: colors.accent,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  submitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
  },
});
