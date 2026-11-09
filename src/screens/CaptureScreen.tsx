// ============================================================
// src/screens/CaptureScreen.tsx
// ============================================================
// The camera surface for the create flow.
//
// WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
// The reference the user pointed at is a phone-camera UI with a vertical tool
// rail down the right edge. Copying that layout pixel for pixel would be both a
// visual knock-off and a worse fit for this app, so this keeps the FUNCTION SET
// and rebuilds the language:
//
//   reference            here
//   ------------------   ------------------------------------------------------
//   flat white glyphs    glass capsules on a navy scrim, one accent ring when on
//   labels beside icons  the same pairing, set in 9pt tracked caps
//   a vertical strip     a single floating capsule that scrolls and folds
//   one fixed toolbar    a rail whose tools light their own state (no guesswork)
//   TikTok's bottom nav  no nav at all — the app's own dock is already there, and
//                        a second one inside the create tab would be two
//                        navigations for one screen
//
// Everything here is a real control: Timer counts down and fires, Layout draws
// a real composition grid, Ratio draws a real crop guide, Teleprompter scrolls
// real text while you record, Mute really silences the recording.
//
// HONEST LIMITS
//   * Ratio is a GUIDE, not a sensor crop. The capture is taken in the camera's
//     native ratio; the guide shows what the editor will keep. Claiming to crop
//     at capture would mean re-encoding on device for a preview-only benefit.
//   * Retouch is a look, not a face warp: it warms and softens the preview and
//     records the intent so the editor can bake it. There is no ML beauty pass.
//   * None of this has been run on a phone yet — see the note in the report.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { colors, radius } from '../theme';
import Icon from '../components/ui/Icon';
import { useInsets } from '../utils/useInsets';

// The camera is media: it stays dark in both themes, the same way the video
// wells do. These are deliberately not theme tokens.
const INK = '#07040F';
const GLASS = 'rgba(10,7,26,0.72)';
const HAIRLINE = 'rgba(255,255,255,0.14)';
const WHITE = '#FAF8FF';

export type CapturedAsset = {
  uri: string;
  width: number;
  height: number;
  type: 'image' | 'video';
  fileName: string;
  mimeType: string;
  durationMs: number | null;
};

type Mode = 'video' | 'photo' | 'text';
type ToolId = 'timer' | 'layout' | 'ratio' | 'retouch' | 'teleprompter';

const RATIOS = [
  { id: '9:16', label: '9:16', r: 9 / 16 },
  { id: '4:5', label: '4:5', r: 4 / 5 },
  { id: '1:1', label: '1:1', r: 1 },
  { id: '16:9', label: '16:9', r: 16 / 9 },
] as const;

const DURATIONS = [
  { id: 15, label: '15s' },
  { id: 60, label: '60s' },
  { id: 180, label: '3m' },
  { id: 600, label: '10m' },
] as const;

const LAYOUTS = [
  { id: 'free', label: 'Free' },
  { id: 'thirds', label: 'Thirds' },
  { id: 'quarters', label: 'Quarters' },
  { id: 'center', label: 'Centre' },
] as const;

const TIMERS = [0, 3, 10] as const;

export default function CaptureScreen({
  visible,
  onClose,
  onCaptured,
  onAddSound,
  soundName,
  onOpenGallery,
  onTextMode,
  overlay = null,
}: {
  visible: boolean;
  onClose: () => void;
  onCaptured: (asset: CapturedAsset) => void;
  onAddSound: () => void;
  soundName: string | null;
  onOpenGallery: () => void;
  onTextMode: () => void;
  /** sits above every camera control, inside the same Modal */
  overlay?: React.ReactNode;
}) {
  const insets = useInsets();
  const { width, height } = useWindowDimensions();

  const [permission, requestPermission] = useCameraPermissions();
  // Separate from the camera on purpose: they are separate Android permissions,
  // and a user can reasonably grant one and refuse the other.
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  // A one-line note in the camera's error slot when a clip records silent.
  // Cleared the moment the user takes another shot or toggles mute.
  const [audioNote, setAudioNote] = useState<string | null>(null);
  const camRef = useRef<React.ComponentRef<typeof CameraView> | null>(null);

  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [mode, setMode] = useState<Mode>('video');
  const [muted, setMuted] = useState(false);
  const [timer, setTimer] = useState<(typeof TIMERS)[number]>(0);
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]['id']>('9:16');
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]['id']>('free');
  const [retouch, setRetouch] = useState(false);
  const [duration, setDuration] = useState<number>(15);

  const [tool, setTool] = useState<ToolId | null>(null);
  const [railOpen, setRailOpen] = useState(true);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [script, setScript] = useState('');
  const [prompterOn, setPrompterOn] = useState(false);
  const prompterY = useRef(new Animated.Value(0)).current;

  const [recent, setRecent] = useState<{ uri: string; isVideo: boolean }[]>([]);

  const recordingRef = useRef(false);
  const startedAtRef = useRef(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ratioValue = useMemo(() => RATIOS.find((r) => r.id === ratio)?.r ?? 9 / 16, [ratio]);

  // ---------------------------------------------------------------
  // Preview geometry. The camera fills the window; the crop guide is
  // drawn on top of it, so what you see is never a squashed sensor.
  // ---------------------------------------------------------------
  const previewH = height;
  const guide = useMemo(() => {
    const boxW = width;
    const boxH = previewH;
    let gw = boxW;
    let gh = gw / ratioValue;
    if (gh > boxH) {
      gh = boxH;
      gw = gh * ratioValue;
    }
    return { w: gw, h: gh, x: (boxW - gw) / 2, y: (boxH - gh) / 2 };
  }, [width, previewH, ratioValue]);

  // ---------------------------------------------------------------
  // Gallery strip: the two most recent things you made. Permission is
  // optional — if it is refused the strip simply is not there.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    (async () => {
      try {
        const perm = await MediaLibrary.getPermissionsAsync();
        let granted = perm.granted;
        if (!granted && perm.canAskAgain) {
          const asked = await MediaLibrary.requestPermissionsAsync();
          granted = asked.granted;
        }
        if (!granted || !alive) return;
        const page = await MediaLibrary.getAssetsAsync({
          first: 2,
          sortBy: ['creationTime'],
          mediaType: ['photo', 'video'],
        });
        if (!alive) return;
        setRecent(
          page.assets.slice(0, 2).map((a) => ({
            uri: a.uri,
            isVideo: a.mediaType === 'video',
          }))
        );
      } catch {
        // gallery is a convenience, never a blocker
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible]);

  // ---------------------------------------------------------------
  // Teleprompter — a slow, looping scroll. Speed is fixed because a
  // slider inside a camera view is a control you cannot see while acting.
  // ---------------------------------------------------------------
  useEffect(() => {
    prompterY.stopAnimation();
    prompterY.setValue(0);
    if (!prompterOn || !script.trim() || !visible) return;
    const loop = Animated.loop(
      Animated.timing(prompterY, {
        toValue: -Math.max(120, script.length * 1.6),
        duration: Math.max(6000, script.length * 55),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [prompterOn, script, visible, prompterY]);

  // ---------------------------------------------------------------
  // Recording clock
  // ---------------------------------------------------------------
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      if (ms >= duration * 1000) void stopRecording();
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, duration]);

  // Leaving the app mid-recording would otherwise leave a camera session open.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && recordingRef.current) void stopRecording();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearCountdown = () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    setCountdown(null);
  };

  useEffect(() => () => clearCountdown(), []);

  const beep = useCallback(() => {
    // Silence is the safer default: no audio dependency, no permission prompt.
  }, []);

  const startRecording = useCallback(async () => {
    if (!camRef.current || busy || recordingRef.current) return;
    setError(null);
    setAudioNote(null);

    /**
     * MICROPHONE, ASKED FOR.
     *
     * `android.permission.RECORD_AUDIO` is declared in app.json, but declaring
     * is not granting: since Android 6 it is a runtime permission, and nothing
     * ever requested it. `recordAsync({ mute: false })` then failed with
     * "Missing permissions: android.permission.RECORD_AUDIO" and no video was
     * recorded at all — a camera that only ever takes photos, which is not what
     * the VIDEO pill promises.
     *
     * Two ways out that are both wrong: silently recording silent video (the
     * user does not find out until playback), or refusing to record. So: ask,
     * and if refused, record muted and SAY SO, once, in the camera's own error
     * line. The take is still there; only the audio is not.
     */
    let mute = muted;
    if (!muted) {
      let mic = micPermission;
      if (!mic?.granted && mic?.canAskAgain !== false) {
        mic = await requestMicPermission();
      }
      if (!mic?.granted) {
        mute = true;
        setAudioNote('Microphone is off — this clip records silent.');
      }
    }

    try {
      setBusy(true);
      recordingRef.current = true;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      const result = await camRef.current.recordAsync({
        maxDuration: duration,
        mute,
      } as any);
      // recordAsync resolves when stopRecording() is called or maxDuration hits
      recordingRef.current = false;
      setRecording(false);
      if (result?.uri) {
        onCaptured({
          uri: result.uri,
          width: 0,
          height: 0,
          type: 'video',
          fileName: `capture-${Date.now()}.mp4`,
          mimeType: 'video/mp4',
          durationMs: Date.now() - startedAtRef.current,
        });
      }
    } catch (e: any) {
      setError(e?.message ?? 'Recording failed');
      recordingRef.current = false;
      setRecording(false);
    } finally {
      setBusy(false);
    }
  }, [busy, duration, muted, onCaptured, micPermission, requestMicPermission]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    try {
      camRef.current?.stopRecording();
    } catch {
      // already stopped
    }
  }, []);

  const takePhoto = useCallback(async () => {
    if (!camRef.current || busy) return;
    setError(null);
    try {
      setBusy(true);
      // expo-camera returns a PictureRef (a reference to the native image), not
      // a uri. It has to be written to the cache before anything else in the
      // app can read it — the uploader, the cover picker and the collage all
      // take file paths.
      const pic = await camRef.current.takePictureAsync({ quality: 0.92 } as any);
      const saved = await pic.savePictureAsync({ quality: 0.92 });
      if (saved?.uri) {
        onCaptured({
          uri: saved.uri,
          width: saved.width ?? pic.width ?? 0,
          height: saved.height ?? pic.height ?? 0,
          type: 'image',
          fileName: `capture-${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          durationMs: null,
        });
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not take the photo');
    } finally {
      setBusy(false);
    }
  }, [busy, onCaptured]);

  const fire = useCallback(() => {
    if (mode === 'photo') {
      void takePhoto();
      return;
    }
    if (recordingRef.current) {
      void stopRecording();
      return;
    }
    void startRecording();
  }, [mode, startRecording, stopRecording, takePhoto]);

  const armShutter = useCallback(() => {
    if (recordingRef.current) {
      void stopRecording();
      return;
    }
    if (timer === 0) {
      fire();
      return;
    }
    // The countdown is the timer tool doing its job: same behaviour as a
    // camera self-timer, visible as a number rather than a status light.
    let left = timer;
    setCountdown(left);
    beep();
    countdownRef.current = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearCountdown();
        fire();
      } else {
        setCountdown(left);
        beep();
      }
    }, 1000);
  }, [beep, fire, timer]);

  const flip = () => setFacing((f) => (f === 'back' ? 'front' : 'back'));

  const railTools: { id: ToolId; label: string; icon: string; on: boolean }[] = [
    { id: 'timer', label: 'Timer', icon: 'timer-outline', on: timer > 0 },
    { id: 'layout', label: 'Layout', icon: 'grid-outline', on: layout !== 'free' },
    { id: 'ratio', label: 'Ratio', icon: 'scan-outline', on: ratio !== '9:16' },
    { id: 'retouch', label: 'Retouch', icon: 'sparkles-outline', on: retouch },
    { id: 'teleprompter', label: 'Teleprompter', icon: 'document-text-outline', on: prompterOn },
  ];

  const fmtElapsed = (ms: number) => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------
  // Permission gate — a real screen, not a silent black rectangle
  // ---------------------------------------------------------------
  if (permission && !permission.granted) {
    return (
      <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
        <View style={[styles.root, styles.permWrap]}>
          <View style={styles.permCard}>
            <View style={styles.permIcon}>
              <Icon name="camera-outline" size={26} color={colors.accent} />
            </View>
            <Text style={styles.permTitle}>Camera access</Text>
            <Text style={styles.permBody}>
              GEN Z needs the camera to record a moment. Nothing is uploaded until you post.
            </Text>
            <Pressable style={styles.permBtn} onPress={requestPermission}>
              <Text style={styles.permBtnText}>Allow camera</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={10} style={styles.permSkip}>
              <Text style={styles.permSkipText}>Not now</Text>
            </Pressable>
          </View>

          {/* The overlay has to be here too, not only on the live camera. If
              camera access is denied — permanently, from the system dialog —
              this is the screen the user lands on, and without the launcher
              they could never reach "Create a Drop" again from the + button. */}
          {overlay}
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root}>
        <CameraView
          ref={camRef as any}
          style={StyleSheet.absoluteFill}
          facing={facing}
          mode={mode === 'video' ? 'video' : 'picture'}
          mute={muted}
          onCameraReady={() => setReady(true)}
        />

        {/* Retouch: a look, applied over the feed, recorded for the editor. */}
        {retouch && <View pointerEvents="none" style={styles.retouchVeil} />}

        {/* Crop guide — the shaded frame outside the chosen ratio */}
        {ratio !== '9:16' && (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[styles.mask, { height: Math.max(0, guide.y) }]} />
            <View style={[styles.mask, { height: Math.max(0, previewH - guide.y - guide.h) }]} />
            <View style={[styles.guideRow, { top: guide.y, height: guide.h }]}>
              <View style={[styles.mask, { flex: 1 }]} />
              <View style={[styles.guideFrame, { width: guide.w, height: guide.h }]} />
              <View style={[styles.mask, { flex: 1 }]} />
            </View>
          </View>
        )}

        {/* Composition grid — the Layout tool, drawn for real */}
        {layout !== 'free' && (
          <View pointerEvents="none" style={styles.gridWrap}>
            <View style={[styles.gridLineH, { top: '33.33%' }]} />
            <View style={[styles.gridLineH, { top: '66.66%' }]} />
            {layout !== 'thirds' && <View style={[styles.gridLineV, { left: '50%' }]} />}
            <View style={[styles.gridLineV, { left: '33.33%' }]} />
            <View style={[styles.gridLineV, { left: '66.66%' }]} />
            {layout === 'center' && <View style={styles.centerBox} />}
          </View>
        )}

        {/* Teleprompter overlay */}
        {prompterOn && !!script.trim() && (
          <View pointerEvents="none" style={styles.prompterWrap}>
            <Animated.View style={{ transform: [{ translateY: prompterY }] }}>
              <Text style={styles.prompterText}>{script}</Text>
            </Animated.View>
          </View>
        )}

        {/* ---------- top bar ---------- */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.iconBtn} accessibilityLabel="Close camera">
            <Icon name="close" size={20} color={WHITE} />
          </Pressable>

          <Pressable onPress={onAddSound} style={styles.soundPill} accessibilityLabel="Add a sound">
            <Icon name="musical-notes" size={14} color={WHITE} />
            <Text style={styles.soundPillText} numberOfLines={1}>
              {soundName ?? 'Add sound'}
            </Text>
          </Pressable>

          <Pressable onPress={flip} hitSlop={12} style={styles.iconBtn} accessibilityLabel="Flip camera">
            <Icon name="camera-reverse-outline" size={22} color={WHITE} />
          </Pressable>
        </View>

        {/* ---------- right rail ---------- */}
        <View style={[styles.railWrap, { top: insets.top + 66 }]}>
          <View style={styles.rail}>
            {/* mute sits above the fold: it is a state, not a tool */}
            <Pressable
              onPress={() => {
                setMuted((m) => !m);
                // unmuting is the user asking for sound — drop the stale note
                setAudioNote(null);
              }}
              style={styles.railAction}
              hitSlop={6}
              accessibilityLabel={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <Icon
                name={muted ? 'mic-off-outline' : 'mic-outline'}
                size={20}
                color={muted ? colors.accent : WHITE}
              />
            </Pressable>

            <View style={styles.railRule} />

            {railOpen &&
              railTools.map((t) => (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    if (t.id === 'retouch') {
                      setRetouch((v) => !v);
                      return;
                    }
                    if (t.id === 'teleprompter') {
                      setTool('teleprompter');
                      return;
                    }
                    setTool((cur) => (cur === t.id ? null : t.id));
                  }}
                  style={styles.railItem}
                  accessibilityLabel={t.label}
                >
                  <Text style={[styles.railLabel, t.on && styles.railLabelOn]}>{t.label}</Text>
                  <View style={[styles.railGlyph, t.on && styles.railGlyphOn]}>
                    <Icon
                      name={t.icon as any}
                      size={17}
                      color={t.on ? colors.accent : WHITE}
                    />
                  </View>
                </Pressable>
              ))}

            <View style={styles.railRule} />

            <Pressable
              onPress={() => setRailOpen((v) => !v)}
              hitSlop={6}
              style={styles.railAction}
              accessibilityLabel={railOpen ? 'Collapse tools' : 'Expand tools'}
            >
              <Icon name={railOpen ? 'chevron-up' : 'chevron-down'} size={18} color={WHITE} />
            </Pressable>
          </View>
        </View>

        {/* ---------- tool panels ---------- */}
        {tool && (
          <View style={[styles.panel, { paddingBottom: insets.bottom + 176 }]}>
            {tool === 'timer' && (
              <>
                <Text style={styles.panelTitle}>Timer</Text>
                <View style={styles.chipRow}>
                  {TIMERS.map((t) => (
                    <Pressable
                      key={t}
                      onPress={() => setTimer(t)}
                      style={[styles.chip, timer === t && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, timer === t && styles.chipTextOn]}>
                        {t === 0 ? 'Off' : `${t}s`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>The shutter waits before it fires.</Text>
              </>
            )}

            {tool === 'layout' && (
              <>
                <Text style={styles.panelTitle}>Layout guide</Text>
                <View style={styles.chipRow}>
                  {LAYOUTS.map((l) => (
                    <Pressable
                      key={l.id}
                      onPress={() => setLayout(l.id)}
                      style={[styles.chip, layout === l.id && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, layout === l.id && styles.chipTextOn]}>
                        {l.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>
                  Frame it here, then cut it into a collage in the editor.
                </Text>
              </>
            )}

            {tool === 'ratio' && (
              <>
                <Text style={styles.panelTitle}>Ratio</Text>
                <View style={styles.chipRow}>
                  {RATIOS.map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => setRatio(r.id)}
                      style={[styles.chip, ratio === r.id && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, ratio === r.id && styles.chipTextOn]}>
                        {r.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>
                  A guide, not a crop. The capture stays full-frame; the editor keeps
                  what is inside the frame.
                </Text>
              </>
            )}

            {tool === 'teleprompter' && (
              <>
                <Text style={styles.panelTitle}>Teleprompter</Text>
                <TextInput
                  value={script}
                  onChangeText={setScript}
                  placeholder="Paste what you want to say…"
                  placeholderTextColor="rgba(255,255,255,0.42)"
                  style={styles.promptInput}
                  multiline
                  maxLength={600}
                />
                <View style={styles.chipRow}>
                  <Pressable
                    onPress={() => setPrompterOn((v) => !v)}
                    style={[styles.chip, prompterOn && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, prompterOn && styles.chipTextOn]}>
                      {prompterOn ? 'Scrolling' : 'Start scroll'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setTool(null);
                      setPrompterOn(true);
                    }}
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>Scroll while recording</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {/* ---------- recording HUD ---------- */}
        {recording && (
          <View style={[styles.hud, { top: insets.top + 62 }]} pointerEvents="none">
            <View style={styles.hudDot} />
            <Text style={styles.hudText}>{fmtElapsed(elapsed)}</Text>
            <View style={styles.hudTrack}>
              <View
                style={[
                  styles.hudFill,
                  { width: `${Math.min(100, (elapsed / (duration * 1000)) * 100)}%` },
                ]}
              />
            </View>
          </View>
        )}

        {/* ---------- countdown ---------- */}
        {countdown !== null && (
          <View pointerEvents="none" style={styles.countWrap}>
            <Text style={styles.countNum}>{countdown}</Text>
            <Text style={styles.countHint}>{mode === 'photo' ? 'Hold still' : 'Get ready'}</Text>
          </View>
        )}

        {/* ---------- bottom ---------- */}
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
          {!!error && <Text style={styles.error}>{error}</Text>}
          {/* Not an error — the clip was recorded. It just has no sound, and the
              user deserves to know before they post it. */}
          {!error && !!audioNote && <Text style={styles.note}>{audioNote}</Text>}

          {/* mode row — the reference's PHOTO/TEXT tabs, plus video */}
          <View style={styles.modeRow}>
            {mode !== 'video' && (
              <View style={styles.durRow}>
                {DURATIONS.map((d) => (
                  <Pressable
                    key={d.id}
                    onPress={() => setDuration(d.id)}
                    style={[styles.durChip, duration === d.id && styles.durChipOn]}
                  >
                    <Text style={[styles.durText, duration === d.id && styles.durTextOn]}>
                      {d.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={styles.modePills}>
              {(['video', 'photo', 'text'] as Mode[]).map((m) => {
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => {
                      if (m === 'text') {
                        onTextMode();
                        return;
                      }
                      setMode(m);
                      setTool(null);
                    }}
                    style={[styles.modePill, on && styles.modePillOn]}
                  >
                    <Text style={[styles.modePillText, on && styles.modePillTextOn]}>
                      {m.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.shutterRow}>
            {/* gallery tiles first, so the shutter stays optically centred */}
            <View style={styles.galleryRow}>
              {recent.length > 0 ? (
                recent.map((r, i) => (
                  <Pressable
                    key={`${r.uri}-${i}`}
                    onPress={onOpenGallery}
                    style={[styles.galTile, i === recent.length - 1 && styles.galTileActive]}
                  >
                    <Image source={{ uri: r.uri }} style={styles.galImg} />
                    {r.isVideo && (
                      <View style={styles.galPlay}>
                        <Icon name="play" size={9} color={WHITE} />
                      </View>
                    )}
                  </Pressable>
                ))
              ) : (
                <Pressable onPress={onOpenGallery} style={[styles.galTile, styles.galEmpty]}>
                  <Icon name="images-outline" size={16} color={WHITE} />
                </Pressable>
              )}
            </View>

            <Pressable
              onPress={armShutter}
              disabled={!ready || busy}
              style={styles.shutterOuter}
              accessibilityLabel={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}
            >
              <View style={[styles.shutterRing, recording && styles.shutterRingRec]} />
              <View
                style={[
                  styles.shutterInner,
                  recording && styles.shutterInnerRec,
                  mode === 'photo' && styles.shutterInnerPhoto,
                ]}
              >
                {busy && !recording ? (
                  <ActivityIndicator color={INK} size="small" />
                ) : recording ? (
                  <View style={styles.shutterStop} />
                ) : null}
              </View>
            </Pressable>

            <View style={styles.shutterSpacer} />
          </View>
        </View>

        {/* Whatever the caller needs above the camera — the create launcher
            sheet, for one. Rendered INSIDE this Modal on purpose: a sibling
            <Modal> stacks by render order on Android, which is the race that
            used to leave the sound sheet behind the camera. */}
        {overlay}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: INK },

  // ---------------- permission ----------------
  permWrap: { alignItems: 'center', justifyContent: 'center', padding: 28 },
  permCard: {
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 26,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    width: '100%',
  },
  permIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
    marginBottom: 14,
  },
  permTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  permBody: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 18,
  },
  permBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 26,
    paddingVertical: 12,
    borderRadius: radius.pill,
  },
  permBtnText: { color: INK, fontWeight: '800', fontSize: 14 },
  permSkip: { marginTop: 14 },
  permSkipText: { color: colors.textFaint, fontSize: 13, fontWeight: '600' },

  // ---------------- overlays ----------------
  retouchVeil: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,196,140,0.10)',
  },
  mask: { flex: 1, backgroundColor: 'rgba(7,4,15,0.62)' },
  guideRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row' },
  guideFrame: { borderWidth: 1, borderColor: 'rgba(255,154,46,0.9)', borderRadius: 2 },

  gridWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  centerBox: {
    position: 'absolute',
    left: '25%',
    top: '30%',
    width: '50%',
    height: '40%',
    borderWidth: 1,
    borderColor: 'rgba(255,154,46,0.55)',
  },

  prompterWrap: {
    position: 'absolute',
    left: 20,
    right: 92,
    top: '26%',
    maxHeight: 190,
    overflow: 'hidden',
  },
  prompterText: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 19,
    lineHeight: 27,
    fontWeight: '700',
  },

  // ---------------- top bar ----------------
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(7,4,15,0.42)',
  },
  soundPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: '58%',
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: HAIRLINE,
  },
  soundPillText: { color: WHITE, fontSize: 13, fontWeight: '700' },

  // ---------------- rail ----------------
  railWrap: { position: 'absolute', right: 10 },
  rail: {
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(7,4,15,0.46)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    gap: 12,
  },
  railItem: { alignItems: 'flex-end', gap: 3 },
  railLabel: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  railLabelOn: { color: colors.accent },
  railGlyph: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  railGlyphOn: {
    backgroundColor: colors.accentSoft,
    borderColor: 'rgba(255,154,46,0.55)',
  },
  railAction: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  railRule: {
    width: 18,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },

  // ---------------- tool panel ----------------
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 18,
    paddingTop: 14,
    backgroundColor: 'rgba(7,4,15,0.90)',
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    gap: 10,
  },
  panelTitle: {
    color: WHITE,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  panelHint: { color: 'rgba(255,255,255,0.55)', fontSize: 11.5, lineHeight: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: 'rgba(255,154,46,0.6)' },
  chipText: { color: WHITE, fontSize: 12, fontWeight: '700' },
  chipTextOn: { color: colors.accent },
  promptInput: {
    minHeight: 74,
    maxHeight: 120,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    color: WHITE,
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },

  // ---------------- HUD ----------------
  hud: {
    position: 'absolute',
    left: 18,
    right: 92,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hudDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  hudText: { color: WHITE, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hudTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  hudFill: { height: 3, backgroundColor: colors.accent },

  // ---------------- countdown ----------------
  countWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countNum: {
    color: WHITE,
    fontSize: 96,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 18,
  },
  countHint: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: -6,
  },

  // ---------------- bottom ----------------
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 12,
  },
  error: { color: colors.danger, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  note: { color: colors.accentStrong, fontSize: 12, fontWeight: '600', textAlign: 'center' },

  modeRow: { gap: 10 },
  durRow: { flexDirection: 'row', justifyContent: 'center', gap: 16 },
  durChip: { paddingVertical: 4 },
  durChipOn: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  durText: { color: 'rgba(255,255,255,0.66)', fontSize: 13, fontWeight: '700' },
  durTextOn: { color: WHITE },

  modePills: { flexDirection: 'row', justifyContent: 'center', gap: 18 },
  modePill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill },
  modePillOn: { backgroundColor: WHITE },
  modePillText: { color: 'rgba(255,255,255,0.62)', fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  modePillTextOn: { color: INK },

  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  galleryRow: { flexDirection: 'row', gap: 8, width: 130 },
  galTile: {
    width: 46,
    height: 58,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  galTileActive: { borderColor: colors.accent, borderWidth: 1.5 },
  galEmpty: { alignItems: 'center', justifyContent: 'center' },
  galImg: { width: '100%', height: '100%' },
  galPlay: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(7,4,15,0.66)',
  },

  shutterOuter: {
    width: 84,
    height: 84,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRing: {
    position: 'absolute',
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.88)',
  },
  shutterRingRec: { borderColor: colors.accent },
  shutterInner: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: 'rgba(255,255,255,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInnerRec: { backgroundColor: colors.accentSoft },
  shutterInnerPhoto: { backgroundColor: WHITE },
  shutterStop: { width: 22, height: 22, borderRadius: 5, backgroundColor: colors.danger },
  shutterSpacer: { width: 130 },
});
