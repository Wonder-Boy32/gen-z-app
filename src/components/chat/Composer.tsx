// ============================================================
// Composer — the five-state input machine (§11.5).
//
//   IDLE   →  ＋   Message…                    🎤
//   TYPING →  ＋   Hello                       ➤
//   RECORD →  ◀ slide to cancel   ●  ━━ 0:07  🔒
//   LOCKED →  ⏸  ━━━━ 0:24            ⏹  ✖
//   REPLY  →  ↳ quoted message             ✖
//
// The mic↔send swap is the ONLY layout-changing animation on the
// screen, and both controls occupy the same 44×44 box so the message
// list never shifts under the user's thumb.
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import Icon from '../ui/Icon';
import { colors, radius, spacing, type } from '../../theme';
import type { Message } from '../../messaging';
import { MOTION, ensureReadable, useReducedMotion } from './chatVisuals';

/** Horizontal travel that cancels a recording. */
const CANCEL_DX = -70;

export interface ComposerProps {
  onSendText: (text: string) => void;
  onSendVoice: (uri: string, durationMs: number) => void;
  onTyping: (active: boolean) => void;
  onAttach: () => void;
  replyTo: Message | null;
  onCancelReply: () => void;
  palette: { myBg: string; myText: string };
  disabled?: boolean;
  /** §25 — broadcast "Recording…" while a voice note is being captured. */
  onRecordingChange?: (on: boolean) => void;
}

export default function Composer({
  onSendText,
  onSendVoice,
  onTyping,
  onAttach,
  replyTo,
  onCancelReply,
  palette,
  disabled,
  onRecordingChange,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [locked, setLocked] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const reduced = useReducedMotion();

  const cancelledRef = useRef(false);
  const lockedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const swap = useRef(new Animated.Value(0)).current;

  const hasText = text.trim().length > 0;

  // 140ms opacity crossfade between mic and send. No layout shift, because both
  // live in the same fixed 44×44 slot.
  useEffect(() => {
    Animated.timing(swap, {
      toValue: hasText ? 1 : 0,
      duration: reduced ? 0 : MOTION.composer,
      useNativeDriver: true,
    }).start();
  }, [hasText, reduced, swap]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    []
  );

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError('Microphone permission denied');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      await recorder.record();

      cancelledRef.current = false;
      startedAtRef.current = Date.now();
      setSeconds(0);
      setRecording(true);
      onRecordingChange?.(true);

      clearTimer();
      timerRef.current = setInterval(() => {
        setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
    } catch (err) {
      setError('Could not start recording');
      if (__DEV__) console.warn('[composer] startRecording failed:', err);
      setRecording(false);
    }
  }, [recorder]);

  const finishRecording = useCallback(
    async (cancelled: boolean) => {
      clearTimer();
      const elapsed = Date.now() - startedAtRef.current;

      try {
        await recorder.stop();
        const uri = recorder.uri;

        // Under ~700ms this was almost certainly a mis-tap, not a message.
        if (!cancelled && uri && elapsed > 700) {
          onSendVoice(uri, elapsed);
        }
      } catch (err) {
        if (__DEV__) console.warn('[composer] stopRecording failed:', err);
      }

      setRecording(false);
      setLocked(false);
      lockedRef.current = false;
      setSeconds(0);
      onRecordingChange?.(false);
    },
    [onSendVoice, recorder, onRecordingChange]
  );

  /**
   * ONE gesture owner for the mic. Combining Pressable's press-in/out with a
   * separate PanResponder is the usual source of "recording sometimes sticks"
   * bugs, so the whole gesture lives here instead.
   */
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        void startRecording();
      },
      onPanResponderMove: (_e, g) => {
        if (!cancelledRef.current && g.dx < CANCEL_DX) cancelledRef.current = true;
      },
      onPanResponderRelease: () => {
        // If the user locked the recording, releasing must NOT send it.
        if (lockedRef.current) return;
        void finishRecording(cancelledRef.current);
      },
      onPanResponderTerminate: () => {
        if (lockedRef.current) return;
        void finishRecording(true);
      },
    })
  ).current;

  const handleChange = (value: string) => {
    setText(value);
    onTyping(value.length > 0);
  };

  const handleSend = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    onTyping(false);
    onSendText(body);
  };

  const accentFg = ensureReadable(palette.myText, palette.myBg);

  if (disabled) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.disabledText}>You cannot reply in this conversation</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {replyTo && (
        <View style={styles.replyStrip}>
          <Icon name="arrow-undo-outline" size={14} color={colors.accent} />
          <Text style={styles.replyText} numberOfLines={1}>
            Replying to{' '}
            {replyTo.body.type === 'text' ? replyTo.body.text : `a ${replyTo.kind} message`}
          </Text>
          <Pressable
            onPress={onCancelReply}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <Icon name="close" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {recording ? (
        <View style={styles.recordRow}>
          {locked ? (
            <>
              <View style={styles.recordingDot} />
              <Text style={styles.recordTime}>{formatSeconds(seconds)}</Text>
              <View style={styles.recordSpacer} />
              <Pressable
                onPress={() => void finishRecording(false)}
                style={styles.recordAction}
                accessibilityRole="button"
                accessibilityLabel="Send voice message"
              >
                <Icon name="checkmark" size={20} color={colors.accent} />
              </Pressable>
              <Pressable
                onPress={() => void finishRecording(true)}
                style={styles.recordAction}
                accessibilityRole="button"
                accessibilityLabel="Discard recording"
              >
                <Icon name="trash-outline" size={18} color={colors.danger} />
              </Pressable>
            </>
          ) : (
            <>
              <Icon name="chevron-back" size={16} color={colors.textMuted} />
              <Text style={styles.cancelHint}>Slide to cancel</Text>
              <View style={styles.recordSpacer} />
              <View style={styles.recordingDot} />
              <Text style={styles.recordTime}>{formatSeconds(seconds)}</Text>
              <Pressable
                onPress={() => {
                  lockedRef.current = true;
                  setLocked(true);
                }}
                style={styles.recordAction}
                accessibilityRole="button"
                accessibilityLabel="Lock recording"
              >
                <Icon name="lock-closed" size={17} color={colors.accent} />
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <View style={styles.inputRow}>
          <Pressable
            onPress={onAttach}
            style={styles.iconBtn}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Attach"
          >
            <Icon name="add" size={24} color={colors.textMuted} />
          </Pressable>

          <TextInput
            value={text}
            onChangeText={handleChange}
            placeholder="Message…"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            multiline
            maxLength={4000}
            accessibilityLabel="Message input"
          />

          {/* fixed 44×44 slot — mic and send overlay each other, never both */}
          <View style={styles.actionSlot}>
            <Animated.View
              style={[styles.layer, { opacity: swap.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}
              pointerEvents={hasText ? 'none' : 'auto'}
            >
              <View
                {...pan.panHandlers}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel="Hold to record a voice message"
              >
                <Icon name="mic" size={22} color={colors.accent} />
              </View>
            </Animated.View>

            <Animated.View
              style={[styles.layer, { opacity: swap }]}
              pointerEvents={hasText ? 'auto' : 'none'}
            >
              <Pressable
                onPress={handleSend}
                style={[styles.sendBtn, { backgroundColor: palette.myBg }]}
                accessibilityRole="button"
                accessibilityLabel="Send message"
              >
                <Icon name="arrow-up" size={19} color={accentFg} />
              </Pressable>
            </Animated.View>
          </View>
        </View>
      )}
    </View>
  );
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SLOT = 44;

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  disabledText: {
    textAlign: 'center',
    color: colors.textFaint,
    fontSize: 13,
    paddingVertical: spacing.sm,
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
  input: {
    flex: 1,
    minHeight: SLOT,
    maxHeight: 132,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: 11,
    paddingBottom: 11,
    color: colors.text,
    fontSize: type.body.fontSize,
  },
  iconBtn: { width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' },
  actionSlot: { width: SLOT, height: SLOT, justifyContent: 'center', alignItems: 'center' },
  layer: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
  },
  replyText: { flex: 1, fontSize: 12.5, color: colors.textMuted },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: spacing.sm, paddingBottom: 6 },
  recordRow: { flexDirection: 'row', alignItems: 'center', height: SLOT, gap: spacing.sm, paddingHorizontal: spacing.sm },
  recordSpacer: { flex: 1 },
  recordingDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
  recordTime: { fontSize: 14, fontWeight: '700', color: colors.text },
  cancelHint: { fontSize: 13, color: colors.textMuted },
  recordAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
