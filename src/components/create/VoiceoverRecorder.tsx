import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AudioModule, RecordingPresets, useAudioPlayer, useAudioRecorder } from 'expo-audio';
import { supabase } from '../../supabase/client';
import { colors, radius, shadows } from '../../theme';
import { uploadMedia } from '../../utils/upload';

// Hold-to-record voiceover. Records with expo-audio, uploads the clip to the
// media bucket and reports back the public URL. (Mixing the voiceover INTO
// the video file requires native ffmpeg — here it is stored and attached to
// the drop so playback can layer it later.)
type Props = {
  url: string | null;
  durationMs: number;
  onRecorded: (url: string, durationMs: number) => void;
  onRemove: () => void;
};

export default function VoiceoverRecorder({ url, durationMs, onRecorded, onRemove }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const playback = useAudioPlayer(url ? { uri: url } : null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const start = async () => {
    if (busy) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError('Allow microphone access to record a voiceover.');
        return;
      }
      setError(null);
      await recorder?.prepareToRecordAsync?.();
      recorder?.record();
      setRecording(true);
      setElapsed(0);
      timer.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (e: any) {
      setError(e?.message ?? 'Could not start recording.');
    }
  };

  const stop = async () => {
    if (!recording) return;
    setRecording(false);
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    const ms = elapsed * 1000;
    setBusy(true);
    try {
      const result: any = await recorder?.stop();
      const uri = result?.uri;
      if (!uri) throw new Error('No recording produced');
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in');
      const publicUrl = await uploadMedia(
        `voiceovers/${user.id}/vo-${Date.now()}.m4a`,
        uri,
        'audio/mp4'
      );
      onRecorded(publicUrl, ms > 0 ? ms : 3000);
    } catch (e: any) {
      setError(e?.message ?? 'Could not save voiceover.');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (s: number) => `0:${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;

  if (url) {
    return (
      <View style={styles.row}>
        <View style={styles.recorded}>
          <Text style={styles.recordedIcon}>🎙</Text>
          <Text style={styles.recordedText}>Voiceover · {fmt(Math.round(durationMs / 1000))}</Text>
          <Pressable
            style={styles.playBtn}
            onPress={() => {
              if (playback?.playing) playback.pause();
              else playback?.seekTo(0);
              playback?.play();
            }}
          >
            <Text style={styles.playText}>{playback?.playing ? '⏸' : '▶'}</Text>
          </Pressable>
        </View>
        <Pressable style={styles.removeBtn} onPress={onRemove} hitSlop={8}>
          <Text style={styles.removeText}>✕ Remove</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Pressable
        style={[styles.holdBtn, recording && styles.holdBtnActive]}
        onPressIn={start}
        onPressOut={stop}
        delayLongPress={100}
      >
        {busy ? (
          <ActivityIndicator color={colors.bg} size="small" />
        ) : (
          <Text style={styles.holdText}>{recording ? `🔴 Recording ${fmt(elapsed)}` : '🎙 Hold to record'}</Text>
        )}
      </Pressable>
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  holdBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    paddingVertical: 12,
    ...shadows.glow,
  },
  holdBtnActive: {
    backgroundColor: colors.danger,
  },
  holdText: {
    color: colors.bg,
    fontSize: 14,
    fontWeight: '800',
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    marginLeft: 12,
    flex: 1,
  },
  recorded: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recordedIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  recordedText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  playBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '800',
  },
  removeBtn: {
    marginLeft: 12,
  },
  removeText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
  },
});
