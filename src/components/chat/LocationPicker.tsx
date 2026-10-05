import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { colors, radius, spacing } from '../../theme';
import Icon from '../ui/Icon';

/**
 * Location sharing (spec §21).
 *
 * Pure presentation + capture. This component NEVER talks to Supabase: it
 * resolves a fix, builds a `LocationPayload`, hands it to the parent through
 * `onSend`, and closes. The parent owns persistence, message creation, expiry
 * and any server-side live-sharing bookkeeping.
 *
 * expo-location 57.0.20 — symbols used (verified against
 * node_modules/expo-location/build/Location.d.ts):
 *   requestForegroundPermissionsAsync, hasServicesEnabledAsync,
 *   getLastKnownPositionAsync, getCurrentPositionAsync, watchPositionAsync
 *   types: Location.LocationObject, Location.LocationSubscription,
 *          Location.Accuracy.Balanced
 */

export interface LocationPayload {
  lat: number;
  lng: number;
  label?: string;
  liveUntil?: string; // ISO timestamp; only for live sharing
}

type Mode = 'now' | 'live';

type Permission = 'checking' | 'granted' | 'denied';

type Fix = {
  lat: number;
  lng: number;
  accuracy: number | null;
};

const DURATIONS: { key: string; label: string; ms: number }[] = [
  { key: '15m', label: '15 minutes', ms: 15 * 60 * 1000 },
  { key: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { key: '8h', label: '8 hours', ms: 8 * 60 * 60 * 1000 },
];

const FIX_TIMEOUT_MS = 15000;

/** Local 12-hour clock — avoids relying on Intl being present in Hermes. */
function clock(date: Date): string {
  const h = date.getHours();
  const m = date.getMinutes();
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Never let a native call hang the sheet open forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out getting your location.')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function errorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

export default function LocationPicker({
  visible,
  onClose,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  onSend: (payload: LocationPayload) => void;
}) {
  const [permission, setPermission] = useState<Permission>('checking');
  const [fix, setFix] = useState<Fix | null>(null);
  const [mode, setMode] = useState<Mode>('now');
  const [durationKey, setDurationKey] = useState<string>('15m');
  const [error, setError] = useState<string | null>(null);

  // Guards state updates after the sheet has been closed mid-flight.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyFix = useCallback((loc: Location.LocationObject) => {
    if (!mounted.current) return;
    setFix({
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy,
    });
  }, []);

  /** Permission + first fix. Safe to call again from the Retry button. */
  const acquire = useCallback(async () => {
    setError(null);
    setPermission('checking');
    setFix(null);

    try {
      const res = await Location.requestForegroundPermissionsAsync();
      if (!res.granted) {
        if (!mounted.current) return;
        // `canAskAgain === false` means the OS will no longer show a prompt.
        setPermission('denied');
        setError(
          res.canAskAgain
            ? 'Location permission is needed to share where you are.'
            : 'Location is blocked for this app. Open your phone Settings → Apps → Gen Z → Permissions and allow Location, then tap Retry.'
        );
        return;
      }

      if (!mounted.current) return;
      setPermission('granted');

      const servicesOn = await Location.hasServicesEnabledAsync();
      if (!servicesOn) {
        if (!mounted.current) return;
        setError('Turn on Location Services in your phone settings, then tap Retry.');
        return;
      }

      // Cheap instant paint from the last known fix (may be null or stale).
      const last = await Location.getLastKnownPositionAsync();
      if (last) applyFix(last);

      const current = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        FIX_TIMEOUT_MS
      );
      applyFix(current);
    } catch (err) {
      if (!mounted.current) return;
      // Keep whatever last-known fix we already had, if any.
      setError(errorText(err, 'Could not get a location fix. Tap Retry.'));
    }
  }, [applyFix]);

  // On open: reset to a clean state and start acquiring.
  useEffect(() => {
    if (!visible) return;
    setMode('now');
    setDurationKey('15m');
    setError(null);
    setFix(null);
    acquire();
  }, [visible, acquire]);

  // While granted and open, keep the fix (and the accuracy readout) fresh.
  useEffect(() => {
    if (!visible || permission !== 'granted') return;
    let active = true;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 10000, distanceInterval: 25 },
          (loc) => {
            if (active) applyFix(loc);
          }
        );
        if (active) subscription = sub;
        else sub.remove();
      } catch {
        // Watching is an enhancement; the single fix above is enough to send.
      }
    })();

    return () => {
      active = false;
      subscription?.remove();
      subscription = null;
    };
  }, [visible, permission, applyFix]);

  const selectedDuration = DURATIONS.find((d) => d.key === durationKey) ?? DURATIONS[0];
  const liveUntilPreview = new Date(Date.now() + selectedDuration.ms);

  const handleSend = useCallback(() => {
    if (!fix) return;
    const payload: LocationPayload = { lat: fix.lat, lng: fix.lng };
    if (mode === 'live') {
      payload.liveUntil = new Date(Date.now() + selectedDuration.ms).toISOString();
    }
    // Parent owns persistence — no database write happens here.
    onSend(payload);
    onClose();
  }, [fix, mode, selectedDuration.ms, onSend, onClose]);

  const busy = permission === 'checking' || (permission === 'granted' && !fix);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close location picker"
        />

        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Share location</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close location picker"
            >
              <Icon name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
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

            {/* ── Permission denied ─────────────────────────── */}
            {permission === 'denied' ? (
              <View style={styles.stateCard}>
                <Icon name="location-outline" size={26} color={colors.textMuted} />
                <Text style={styles.stateTitle}>Location is off for Gen Z</Text>
                <Text style={styles.stateBody}>
                  Enable it in Settings → Apps → Gen Z → Permissions → Location, then come back and
                  tap Retry. We never track you in the background.
                </Text>
                <Pressable
                  style={styles.retryBtn}
                  onPress={acquire}
                  accessibilityRole="button"
                  accessibilityLabel="Retry getting location permission"
                >
                  <Icon name="refresh" size={16} color={colors.bg} />
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {/* ── Acquiring the first fix ───────────────────── */}
            {busy ? (
              <View style={styles.stateCard}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.stateTitle}>
                  {permission === 'checking' ? 'Checking permission…' : 'Finding you…'}
                </Text>
              </View>
            ) : null}

            {/* ── Coordinates + accuracy ────────────────────── */}
            {permission === 'granted' && fix ? (
              <View style={styles.coordCard}>
                <View style={styles.coordTop}>
                  <Icon name="navigate" size={18} color={colors.accent} />
                  <Text style={styles.coordText}>
                    {fix.lat.toFixed(6)}, {fix.lng.toFixed(6)}
                  </Text>
                </View>
                <View style={styles.accuracyRow}>
                  <Icon name="radio-outline" size={13} color={colors.textMuted} />
                  <Text style={styles.accuracyText}>
                    {typeof fix.accuracy === 'number'
                      ? `Accurate to about ±${Math.round(fix.accuracy)} m`
                      : 'Accuracy unavailable on this device'}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* ── Mode ──────────────────────────────────────── */}
            {permission === 'granted' && fix ? (
              <>
                <Text style={styles.sectionHeading}>How long</Text>
                <View style={styles.modeRow}>
                  <Pressable
                    style={[styles.modeBtn, mode === 'now' && styles.modeBtnActive]}
                    onPress={() => setMode('now')}
                    accessibilityRole="button"
                    accessibilityLabel="Send current location, one time"
                    accessibilityState={{ selected: mode === 'now' }}
                  >
                    <Icon
                      name="pin"
                      size={16}
                      color={mode === 'now' ? colors.bg : colors.textMuted}
                    />
                    <Text style={[styles.modeText, mode === 'now' && styles.modeTextActive]}>
                      Send current
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.modeBtn, mode === 'live' && styles.modeBtnActive]}
                    onPress={() => setMode('live')}
                    accessibilityRole="button"
                    accessibilityLabel="Start live location sharing"
                    accessibilityState={{ selected: mode === 'live' }}
                  >
                    <Icon
                      name="pulse"
                      size={16}
                      color={mode === 'live' ? colors.bg : colors.textMuted}
                    />
                    <Text style={[styles.modeText, mode === 'live' && styles.modeTextActive]}>
                      Live location
                    </Text>
                  </Pressable>
                </View>

                {mode === 'now' ? (
                  <Text style={styles.helperText}>
                    Sends a single point. It stays where you put it — it never follows you.
                  </Text>
                ) : (
                  <>
                    <View style={styles.chips}>
                      {DURATIONS.map((d) => {
                        const selected = d.key === durationKey;
                        return (
                          <Pressable
                            key={d.key}
                            style={[styles.chip, selected && styles.chipActive]}
                            onPress={() => setDurationKey(d.key)}
                            accessibilityRole="button"
                            accessibilityLabel={`Share live location for ${d.label}`}
                            accessibilityState={{ selected }}
                          >
                            <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                              {d.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {/* Visible "Stop sharing" while live is armed. */}
                    <View style={styles.liveBar}>
                      <View style={styles.liveInfo}>
                        <View style={styles.liveDot} />
                        <Text style={styles.liveText}>
                          Sharing until {clock(liveUntilPreview)}
                        </Text>
                      </View>
                      <Pressable
                        style={styles.stopBtn}
                        onPress={() => setMode('now')}
                        accessibilityRole="button"
                        accessibilityLabel="Stop sharing live location"
                      >
                        <Text style={styles.stopText}>Stop sharing</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </>
            ) : null}
          </ScrollView>

          {/* ── Actions ─────────────────────────────────────── */}
          <View style={styles.actions}>
            <Pressable
              style={styles.cancelBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel location sharing"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.sendBtn, !fix && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!fix}
              accessibilityRole="button"
              accessibilityLabel={
                mode === 'live'
                  ? `Send live location for ${selectedDuration.label}`
                  : 'Send current location'
              }
              accessibilityState={{ disabled: !fix }}
            >
              <Icon name="paper-plane" size={16} color={fix ? colors.bg : colors.textFaint} />
              <Text style={[styles.sendText, !fix && styles.sendTextDisabled]}>
                {mode === 'live' ? `Share for ${selectedDuration.label}` : 'Send location'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    // StyleSheet.absoluteFillObject is absent from this project's RN typings
    // (only absoluteFill exists), so the four edges are written out.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    maxHeight: '86%',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surfaceAlt,
    marginBottom: spacing.md,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontSize: 13,
    fontWeight: '500',
  },
  stateCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  stateTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  stateBody: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  retryText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '700',
  },
  coordCard: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  coordTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  coordText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  accuracyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  accuracyText: {
    color: colors.textMuted,
    fontSize: 12,
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
  modeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
  },
  modeBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  modeText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  modeTextActive: {
    color: colors.bg,
  },
  helperText: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
    marginHorizontal: spacing.xs,
  },
  chips: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.accent,
  },
  liveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  liveInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  liveText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  stopBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  stopText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  sendBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  sendBtnDisabled: {
    backgroundColor: colors.surfaceAlt,
  },
  sendText: {
    color: colors.bg,
    fontSize: 14,
    fontWeight: '700',
  },
  sendTextDisabled: {
    color: colors.textFaint,
  },
});
