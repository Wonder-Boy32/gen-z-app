import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { colors } from '../../theme';
import Icon from '../ui/Icon';
import Avatar from '../Avatar';
import { TOP_INSET } from '../../utils/useInsets';
import { getRingtoneUri } from '../../utils/ringtone';

export type CallState = {
  dir: 'out' | 'in';
  kind: 'audio' | 'video';
  status: 'ringing' | 'active' | 'declined' | 'ended';
  callId: string;
} | null;

type Props = {
  state: CallState;
  name: string;
  avatarUrl: string | null;
  soundOn: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onEnd: () => void;
};

function fmt(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function CallScreen({ state, name, avatarUrl, soundOn, onAccept, onDecline, onEnd }: Props) {
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [ringUri, setRingUri] = useState<string | null>(null);
  const ring = useAudioPlayer(ringUri);
  const pulse = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = state?.status === 'active';
  const ringing = state?.status === 'ringing';

  // load the generated ringtone once
  useEffect(() => {
    let alive = true;
    getRingtoneUri()
      .then((uri) => {
        if (alive) setRingUri(uri);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // ringtone + vibration while ringing (respect per-chat sound setting)
  useEffect(() => {
    if (!ringing || !soundOn) {
      ring.pause();
      return;
    }
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        if (ringUri) {
          ring.loop = true;
          await ring.play();
        }
      } catch {}
      try {
        Vibration.vibrate([500, 400, 500, 400, 500, 400, 500, 400], true);
      } catch {}
    })();
    // vibration fallback if audio failed silently
    const t = setTimeout(() => {
      try {
        Vibration.vibrate([600, 300, 600, 300, 600, 300], true);
      } catch {}
    }, 3000);
    return () => {
      if (t) clearTimeout(t);
      ring.pause();
      Vibration.cancel();
    };
  }, [ringing, soundOn, ringUri, ring]);

  // call timer while active
  useEffect(() => {
    if (active) {
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [active]);

  // pulsing ring around the avatar while ringing / active
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  if (!state) return null;

  const isIncoming = state.dir === 'in' && ringing;

  const statusText =
    state.status === 'ringing'
      ? state.dir === 'out'
        ? 'Ringing…'
        : 'Incoming call…'
      : state.status === 'declined'
        ? 'Call declined'
        : state.status === 'ended'
          ? 'Call ended'
          : fmt(seconds);

  const kindLabel = state.kind === 'video' ? 'Video call' : 'Audio call';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onEnd} statusBarTranslucent>
      <View style={styles.container}>
        {/* faint color glow backdrop */}
        <View style={styles.glowTop} />
        <View style={styles.glowBottom} />

        <Text style={styles.kindLabel}>{kindLabel}</Text>

        <View style={styles.avatarZone}>
          <Animated.View
            style={[
              styles.pulseRing,
              {
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }],
              },
            ]}
          />
          <Avatar url={avatarUrl} name={name} size={120} ring />
        </View>

        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.status, state.status === 'declined' || state.status === 'ended' ? styles.statusEnded : null]}>
          {statusText}
        </Text>

        {state.status === 'ringing' && state.dir === 'out' && (
          <View style={styles.hintRow}>
            <Text style={styles.hint}>Waiting for the other person to answer…</Text>
          </View>
        )}

        {(state.status === 'active' || (state.status === 'ringing' && state.dir === 'out')) && (
          <View style={styles.controls}>
            <ControlBtn icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} onPress={() => setMuted((m) => !m)} active={muted} />
            <ControlBtn icon={speaker ? 'volume-high' : 'volume-medium'} label="Speaker" onPress={() => setSpeaker((s) => !s)} active={speaker} />
            {state.kind === 'video' && (
              <ControlBtn icon={flipped ? 'camera-reverse-outline' : 'camera-outline'} label="Flip" onPress={() => setFlipped((f) => !f)} active={flipped} />
            )}
          </View>
        )}

        <View style={styles.endZone}>
          {isIncoming ? (
            <View style={styles.incomingRow}>
              <Pressable style={[styles.roundBtn, styles.declineBtn]} onPress={onDecline}>
                <Icon name="call" size={28} color={colors.bg} style={styles.declineIcon} />
              </Pressable>
              <Pressable style={[styles.roundBtn, styles.acceptBtn]} onPress={onAccept}>
                <Icon name="call" size={28} color={colors.bg} />
              </Pressable>
            </View>
          ) : (
            <Pressable style={[styles.roundBtn, styles.endBtn]} onPress={onEnd}>
              <Icon name="call" size={28} color={colors.bg} style={styles.declineIcon} />
            </Pressable>
          )}
          {!isIncoming && state.status !== 'ended' && state.status !== 'declined' && (
            <Text style={styles.endHint}>{state.status === 'ringing' ? 'Cancel' : 'End call'}</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ControlBtn({
  icon,
  label,
  onPress,
  active,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable style={styles.controlBtn} onPress={onPress}>
      <View style={[styles.controlCircle, active && styles.controlCircleActive]}>
        <Icon name={icon} size={24} color={active ? colors.bg : colors.text} />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070B18',
    alignItems: 'center',
    paddingTop: TOP_INSET + 30,
    paddingBottom: 60,
  },
  glowTop: {
    position: 'absolute',
    top: -120,
    right: -100,
    width: 340,
    height: 340,
    borderRadius: 170,
    backgroundColor: 'rgba(193,59,255,0.10)',
  },
  glowBottom: {
    position: 'absolute',
    bottom: -140,
    left: -120,
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(139,123,255,0.10)',
  },
  kindLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  avatarZone: {
    marginTop: 70,
    marginBottom: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 170,
    height: 170,
    borderRadius: 85,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  name: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    paddingHorizontal: 40,
    textAlign: 'center',
  },
  status: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  statusEnded: {
    color: colors.danger,
  },
  hintRow: {
    marginTop: 14,
    paddingHorizontal: 30,
  },
  hint: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
  },
  controls: {
    flexDirection: 'row',
    gap: 26,
    marginTop: 'auto',
    marginBottom: 24,
  },
  controlBtn: {
    alignItems: 'center',
    gap: 6,
  },
  controlCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  controlCircleActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  controlLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },
  endZone: {
    marginTop: 14,
    alignItems: 'center',
  },
  incomingRow: {
    flexDirection: 'row',
    gap: 60,
  },
  roundBtn: {
    width: 66,
    height: 66,
    borderRadius: 33,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtn: {
    backgroundColor: colors.danger,
  },
  acceptBtn: {
    backgroundColor: colors.success,
  },
  declineBtn: {
    backgroundColor: colors.danger,
  },
  declineIcon: {
    transform: [{ rotate: '135deg' }],
  },
  endHint: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 8,
  },
});
