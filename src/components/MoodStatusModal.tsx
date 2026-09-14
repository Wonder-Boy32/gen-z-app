import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, shadows } from '../theme';
import { useInsets } from '../utils/useInsets';
import { useSheetPad } from '../utils/useSheetPad';
import Icon from './ui/Icon';
import Button from './Button';
import {
  STATUS_PRESETS,
  STATUS_MAX_LABEL,
  setMyStatus,
  clearMyStatus,
  shortTimeLeft,
  type ProfileStatus,
} from '../services/profileStatus';

// A mood is meant to be short-lived. These are how long it stays up.
const DURATIONS = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 48, label: '48h' },
];

export default function MoodStatusModal({
  visible,
  onClose,
  current,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  current: ProfileStatus | null;
  onChanged: () => void;
}) {
  const insets = useInsets();
  // Same IME fix as the other sheets in this app — this sheet has text inputs and
  // on Android a Modal does not resize for the keyboard.
  const padBottom = useSheetPad(16 + insets.bottom);

  const [emoji, setEmoji] = useState('✨');
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState<'set' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed from the live status each time the sheet opens, so reopening after a
  // change never shows a stale selection.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setBusy(null);
    if (current) {
      setEmoji(current.emoji);
      setLabel(current.label);
    } else {
      setEmoji('✨');
      setLabel('');
    }
  }, [visible, current]);

  const pick = (presetEmoji: string, presetLabel: string) => {
    setEmoji(presetEmoji);
    setLabel(presetLabel);
    setError(null);
  };

  const submit = async () => {
    setBusy('set');
    setError(null);
    const res = await setMyStatus(emoji, label, hours);
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onChanged();
    onClose();
  };

  const clear = async () => {
    setBusy('clear');
    setError(null);
    const res = await clearMyStatus();
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onChanged();
    onClose();
  };

  const canSubmit = label.trim().length > 0 && busy === null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: padBottom }]}>
          <View style={styles.grabber} />

          <View style={styles.head}>
            <Text style={styles.title}>What&apos;s the vibe?</Text>
            <Text style={styles.sub}>
              A mood shows on your profile and clears itself. Nothing to tidy up later.
            </Text>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {current && (
              <View style={styles.liveRow}>
                <View style={styles.livePill}>
                  <Text style={styles.liveText}>
                    {current.emoji} live now · disappears in {shortTimeLeft(current.expiresAt)}
                  </Text>
                </View>
              </View>
            )}

            <Text style={styles.sectionLabel}>Pick one</Text>
            <View style={styles.presets}>
              {STATUS_PRESETS.map((p) => {
                const active = p.label === label && p.emoji === emoji;
                return (
                  <Pressable
                    key={p.label}
                    style={[styles.preset, active && styles.presetActive]}
                    onPress={() => pick(p.emoji, p.label)}
                  >
                    <Text style={styles.presetEmoji}>{p.emoji}</Text>
                    <Text style={[styles.presetText, active && styles.presetTextActive]} numberOfLines={2}>
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.sectionLabel}>Or your own</Text>
            <View style={styles.customRow}>
              <TextInput
                style={styles.emojiInput}
                value={emoji}
                onChangeText={(t) => setEmoji(t)}
                maxLength={8}
                textAlign="center"
                placeholder="✨"
                placeholderTextColor={colors.textFaint}
              />
              <TextInput
                style={styles.labelInput}
                value={label}
                onChangeText={(t) => {
                  setLabel(t);
                  setError(null);
                }}
                maxLength={STATUS_MAX_LABEL}
                placeholder="Say it in a few words"
                placeholderTextColor={colors.textFaint}
                returnKeyType="done"
              />
            </View>
            <Text style={styles.counter}>
              {label.trim().length}/{STATUS_MAX_LABEL}
            </Text>

            <Text style={styles.sectionLabel}>Lasts for</Text>
            <View style={styles.durations}>
              {DURATIONS.map((d) => (
                <Pressable
                  key={d.hours}
                  style={[styles.duration, hours === d.hours && styles.durationActive]}
                  onPress={() => setHours(d.hours)}
                >
                  <Text style={[styles.durationText, hours === d.hours && styles.durationTextActive]}>
                    {d.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.hint}>Then it disappears on its own.</Text>

            {!!error && (
              <View style={styles.errorBox}>
                <Icon name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Button
              title={busy === 'set' ? 'Setting…' : 'Set status'}
              onPress={submit}
              disabled={!canSubmit}
              loading={busy === 'set'}
              style={styles.footerBtn}
            />
            {current && (
              <Pressable
                style={styles.clearBtn}
                onPress={clear}
                disabled={busy !== null}
                accessibilityRole="button"
              >
                {busy === 'clear' ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Text style={styles.clearText}>Clear my status</Text>
                )}
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: 8,
    maxHeight: '88%',
    ...(shadows.md as object),
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 12,
  },
  head: { paddingHorizontal: 18, marginBottom: 14 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 18, paddingBottom: 8 },
  liveRow: { flexDirection: 'row', marginBottom: 12 },
  livePill: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  liveText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  sectionLabel: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 6,
  },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  presetActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  presetEmoji: { fontSize: 17 },
  presetText: { color: colors.textMuted, fontSize: 12.5, flexShrink: 1, lineHeight: 16 },
  presetTextActive: { color: colors.text, fontWeight: '600' },
  customRow: { flexDirection: 'row', gap: 8 },
  emojiInput: {
    width: 58,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 20,
    paddingVertical: 10,
  },
  labelInput: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  counter: {
    color: colors.textFaint,
    fontSize: 11,
    textAlign: 'right',
    marginTop: 4,
  },
  durations: { flexDirection: 'row', gap: 8 },
  duration: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  durationActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  durationText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  durationTextActive: { color: colors.accent },
  hint: { color: colors.textFaint, fontSize: 12, marginTop: 8 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,92,124,0.12)',
    borderRadius: radius.md,
    padding: 10,
    marginTop: 14,
  },
  errorText: { color: colors.danger, fontSize: 12.5, flexShrink: 1 },
  footer: { paddingHorizontal: 18, paddingTop: 12, gap: 8 },
  footerBtn: { width: '100%' },
  clearBtn: { alignItems: 'center', paddingVertical: 10 },
  clearText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});
