import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme';
import Icon from '../ui/Icon';

export type CallRow = {
  id: string;
  kind: 'audio' | 'video';
  status: 'ringing' | 'active' | 'completed' | 'declined' | 'missed';
  caller_id: string;
  callee_id: string;
  started_at: string;
  ended_at: string | null;
  duration: number | null;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

/**
 * WhatsApp-style call entry inside a chat thread:
 * direction arrow + "Voice call"/"Video call" + outcome + time.
 */
export default function CallHistoryRow({ call, me }: { call: CallRow; me: string | null }) {
  const mine = call.caller_id === me;
  const kind = call.kind === 'video' ? 'Video call' : 'Voice call';
  const missed = call.status === 'missed' || call.status === 'declined';

  let label: string;
  if (call.status === 'missed') {
    label = mine ? `${kind} · No answer` : `Missed ${kind.toLowerCase()}`;
  } else if (call.status === 'declined') {
    label = mine ? `${kind} · Declined` : `${kind} · Declined`;
  } else if (call.status === 'completed' && call.duration != null) {
    label = `${kind} · ${fmtDuration(call.duration)}`;
  } else {
    label = kind;
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.pill}>
        <Icon
          name={mine ? 'arrow-up' : 'arrow-down'}
          size={14}
          color={missed ? colors.danger : colors.success}
        />
        <Text style={[styles.label, missed && styles.labelMissed]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.time}>{timeAgo(call.started_at)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
    maxWidth: '86%',
  },
  label: {
    color: colors.textMuted,
    fontSize: 12.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  labelMissed: {
    color: colors.danger,
  },
  time: {
    color: colors.textFaint,
    fontSize: 11,
  },
});
