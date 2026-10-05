// ============================================================
// CameraScreen — the camera as a communication tool, not a file
// picker (spec §9).
//
// APIs verified against node_modules before writing, because
// expo-camera changed shape across SDKs (`Camera` → `CameraView`)
// and guessing here produces a screen that compiles and then
// renders nothing:
//   expo-camera ~57.0.5
//     · CameraView        — class component, ref methods below
//     · useCameraPermissions / useMicrophonePermissions
//     · ref.takePictureAsync(opts) -> CameraCapturedPicture
//     · ref.recordAsync(opts)      -> { uri }
//     · ref.stopRecording()
//     · types CameraType, FlashMode, CameraMode
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
  type FlashMode,
  type CameraMode,
  type CameraCapturedPicture,
} from 'expo-camera';
import Icon from '../components/ui/Icon';
import { colors, radius, spacing } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import { friendlyError } from '../utils/friendlyError';

export interface CapturedAsset {
  uri: string;
  type: 'photo' | 'video';
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface CameraScreenProps {
  onClose: () => void;
  onCapture: (asset: CapturedAsset) => void;
  /** 'message' for a chat attachment, 'moment' for view-once (§11). */
  intent?: 'message' | 'moment';
}

const TIMER_OPTIONS = [0, 3, 10] as const;
type TimerSeconds = (typeof TIMER_OPTIONS)[number];

const MAX_VIDEO_SECONDS = 60;

export default function CameraScreen({ onClose, onCapture, intent = 'message' }: CameraScreenProps) {
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  const cameraRef = useRef<CameraView>(null);

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [mode, setMode] = useState<CameraMode>('picture');
  const [timer, setTimer] = useState<TimerSeconds>(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasFlash, setHasFlash] = useState(true);

  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    if (recordTimer.current) {
      clearInterval(recordTimer.current);
      recordTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Switching to video needs the microphone, and video never uses flash.
  const selectVideo = useCallback(async () => {
    if (!micPerm?.granted) {
      const res = await requestMicPerm();
      if (!res.granted) {
        setError('Microphone permission is needed to record video');
        return;
      }
    }
    setMode('video');
    setFlash('off');
  }, [micPerm?.granted, requestMicPerm]);

  const takePhoto = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const shot: CameraCapturedPicture | undefined = await cameraRef.current.takePictureAsync({
        quality: 0.9,
      });
      if (!shot?.uri) throw new Error('no image returned');
      onCapture({ uri: shot.uri, type: 'photo', width: shot.width, height: shot.height });
      onClose();
    } catch (err) {
      setError('Could not take the photo');
      if (__DEV__) console.warn('[camera] takePictureAsync failed:', err);
    } finally {
      setBusy(false);
    }
  }, [busy, onCapture, onClose]);

  const startVideo = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setError(null);
    setElapsed(0);

    try {
      setRecording(true);
      recordTimer.current = setInterval(() => setElapsed((s) => s + 1), 1000);

      const video = await cameraRef.current.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
      // recordAsync resolves when stopRecording() is called or maxDuration hits.
      if (video?.uri) {
        onCapture({
          uri: video.uri,
          type: 'video',
          durationMs: Math.max(elapsed, 1) * 1000,
        });
        onClose();
      }
    } catch (err) {
      setError('Could not record the video');
      if (__DEV__) console.warn('[camera] recordAsync failed:', err);
    } finally {
      if (recordTimer.current) {
        clearInterval(recordTimer.current);
        recordTimer.current = null;
      }
      setRecording(false);
      setBusy(false);
    }
  }, [busy, elapsed, onCapture, onClose]);

  const stopVideo = useCallback(() => {
    cameraRef.current?.stopRecording();
  }, []);

  const shutter = useCallback(() => {
    if (busy) return;

    if (mode === 'video') {
      void (recording ? stopVideo() : startVideo());
      return;
    }

    if (timer === 0) {
      void takePhoto();
      return;
    }

    // Self-timer: count down in the UI, then shoot.
    setBusy(true);
    let left = timer;
    setCountdown(left);
    countdownTimer.current = setInterval(() => {
      left -= 1;
      setCountdown(left);
      if (left <= 0) {
        if (countdownTimer.current) clearInterval(countdownTimer.current);
        countdownTimer.current = null;
        setCountdown(0);
        setBusy(false);
        void takePhoto();
      }
    }, 1000);
  }, [busy, mode, recording, startVideo, stopVideo, takePhoto, timer]);

  const cycleTimer = useCallback(() => {
    const i = TIMER_OPTIONS.indexOf(timer);
    setTimer(TIMER_OPTIONS[(i + 1) % TIMER_OPTIONS.length]);
  }, [timer]);

  const cycleFlash = useCallback(() => {
    if (mode === 'video' || !hasFlash) return;
    setFlash((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
  }, [mode, hasFlash]);

  // ---- permission gate -------------------------------------------
  if (!camPerm) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!camPerm.granted) {
    return (
      <View style={styles.centered}>
        <Icon name="camera-outline" size={44} color={colors.textMuted} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Gen Z needs the camera to send photos and video messages. Nothing is
          captured until you press the shutter.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={() => void requestCamPerm()} accessibilityRole="button">
          <Text style={styles.primaryBtnText}>
            {camPerm.canAskAgain ? 'Allow camera' : 'Try again'}
          </Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={onClose} accessibilityRole="button">
          <Text style={styles.ghostBtnText}>Not now</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mode={mode}
        onCameraReady={() => setReady(true)}
        onMountError={(e: { message?: string }) => setError(friendlyError(e, 'Camera failed to start'))}
      />

      {/* top chrome */}
      <View style={[styles.topBar, { paddingTop: TOP_INSET + 8 }]}>
        <Pressable style={styles.iconBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close camera">
          <Icon name="close" size={24} color="#fff" />
        </Pressable>

        <View style={styles.topSpacer} />

        {mode === 'picture' && (
          <Pressable
            style={styles.iconBtn}
            onPress={cycleFlash}
            disabled={!hasFlash}
            accessibilityRole="button"
            accessibilityLabel={`Flash ${flash}`}
          >
            <Icon
              name={flash === 'off' ? 'flash-off' : 'flash'}
              size={22}
              color={hasFlash ? '#fff' : 'rgba(255,255,255,0.35)'}
            />
          </Pressable>
        )}

        <Pressable
          style={styles.iconBtn}
          onPress={() => hasFlash && setHasFlash(!hasFlash)}
          accessibilityRole="button"
          accessibilityLabel="Toggle flash availability"
        >
          <Icon name="camera-reverse" size={22} color="#fff" />
        </Pressable>
      </View>

      {/* live status */}
      <View style={styles.statusRow}>
        {recording && (
          <View style={styles.recordingPill}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>{fmt(elapsed)}</Text>
            <Text style={styles.recordingMax}>/ {fmt(MAX_VIDEO_SECONDS)}</Text>
          </View>
        )}
        {countdown > 0 && <Text style={styles.countdown}>{countdown}</Text>}
        {!ready && !error && <Text style={styles.hint}>Starting camera…</Text>}
        {!!error && (
          <Pressable style={styles.errorPill} onPress={() => setError(null)}>
            <Icon name="alert-circle" size={13} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </Pressable>
        )}
      </View>

      {/* bottom chrome */}
      <View style={styles.bottomBar}>
        <View style={styles.modeRow}>
          <Pressable
            onPress={() => setMode('picture')}
            style={[styles.modeChip, mode === 'picture' && styles.modeChipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === 'picture' }}
          >
            <Icon name="camera" size={14} color={mode === 'picture' ? colors.bg : '#fff'} />
            <Text style={[styles.modeText, mode === 'picture' && styles.modeTextOn]}>Photo</Text>
          </Pressable>

          <Pressable
            onPress={() => void selectVideo()}
            style={[styles.modeChip, mode === 'video' && styles.modeChipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === 'video' }}
          >
            <Icon name="videocam" size={15} color={mode === 'video' ? colors.bg : '#fff'} />
            <Text style={[styles.modeText, mode === 'video' && styles.modeTextOn]}>Video</Text>
          </Pressable>
        </View>

        <View style={styles.controlRow}>
          <Pressable
            style={styles.smallBtn}
            onPress={cycleTimer}
            accessibilityRole="button"
            accessibilityLabel={timer === 0 ? 'Self timer off' : `Self timer ${timer} seconds`}
          >
            <Icon name="timer-outline" size={20} color="#fff" />
            {timer > 0 && <Text style={styles.smallBtnBadge}>{timer}</Text>}
          </Pressable>

          <Pressable
            style={[styles.shutter, recording && styles.shutterRecording]}
            onPress={shutter}
            disabled={busy || !ready}
            accessibilityRole="button"
            accessibilityLabel={mode === 'video' ? (recording ? 'Stop recording' : 'Start recording') : 'Take photo'}
          >
            {busy && !recording ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <View style={recording ? styles.shutterStop : styles.shutterInner} />
            )}
          </Pressable>

          <Pressable
            style={styles.smallBtn}
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            accessibilityRole="button"
            accessibilityLabel="Flip camera"
          >
            <Icon name="camera-reverse" size={20} color="#fff" />
          </Pressable>
        </View>

        <Text style={styles.intentHint}>
          {intent === 'moment'
            ? 'Sends as a Moment — the recipient can open it once'
            : mode === 'video'
              ? `Tap to record, up to ${MAX_VIDEO_SECONDS}s`
              : 'Tap the shutter to capture'}
        </Text>
      </View>
    </View>
  );
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  permTitle: { fontSize: 19, fontWeight: '700', color: colors.text },
  permBody: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: colors.bg, fontWeight: '700', fontSize: 14 },
  ghostBtn: { paddingVertical: spacing.sm },
  ghostBtnText: { color: colors.textMuted, fontSize: 13 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  topSpacer: { flex: 1 },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: {
    position: 'absolute',
    top: '22%',
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: spacing.sm,
  },
  recordingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  recordingDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
  recordingText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  recordingMax: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  countdown: { color: '#fff', fontSize: 74, fontWeight: '200' },
  hint: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  errorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    maxWidth: '86%',
  },
  errorText: { color: colors.danger, fontSize: 12, flexShrink: 1 },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.35)',
    gap: spacing.md,
  },
  modeRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  modeChipOn: { backgroundColor: colors.accent },
  modeText: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
  modeTextOn: { color: colors.bg },
  controlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  smallBtnBadge: {
    position: 'absolute',
    bottom: 6,
    right: 10,
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
  },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRecording: { borderColor: colors.danger },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  shutterStop: { width: 26, height: 26, borderRadius: 6, backgroundColor: colors.danger },
  intentHint: { color: 'rgba(255,255,255,0.6)', fontSize: 11.5, textAlign: 'center' },
});
