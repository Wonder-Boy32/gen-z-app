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
//   * Ratio cannot change what the sensor records — one stream, one shape. So the
//     guide is drawn live AND the ratio travels to the exporter, which
//     centre-crops the file to exactly that frame (processDropVideo `crop`).
//     The post therefore ships in the shape the user framed, which is the part
//     that matters; the temp clip on disk is still full-frame.
//   * Retouch is a look, not a face warp: it warms and softens the preview and
//     records the level so the exporter bakes the same eq chain. No ML pass.
//   * Split screen: a phone camera exposes one stream at a time, so a live split
//     cannot be recorded. It is not offered as a chip; the panel says so and
//     points at the route that does work (separate clips, combined in the editor).
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
import SoundTrack from '../components/SoundTrack';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../theme';
import Icon from '../components/ui/Icon';
import { useInsets } from '../utils/useInsets';
import { concatClips } from '../utils/videoProcessor';

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
  /**
   * 0 off, 1 soft, 2 strong — the viewfinder's retouch, carried to the
   * composer so it is applied for real at export (videoProcessor maps it to an
   * eq chain). A look that only existed as an overlay on the preview would be
   * a lie by the time the post was published.
   */
  retouch?: 0 | 1 | 2;
  /**
   * Width / height of the frame the user chose (9/16, 1, 16/9 …). The sensor
   * records its own shape, so this is what lets the export crop to the frame
   * instead of the Ratio tool being decoration.
   */
  aspect?: number;
};

// There is no camera "mode" any more. The viewfinder shoots video; PHOTO opens
// the phone's library and TEXT leaves for the text page. Both of those are
// destinations, not shutter settings — modelling them as a mode is what made
// the duration chips appear in front of a photo shutter, and what made PHOTO
// look like it was going to take a picture instead of opening your photos.
/** the two launchers that sit beside VIDEO at the bottom of the viewfinder */
type Launcher = 'photo' | 'text';
type ToolId = 'timer' | 'layout' | 'ratio' | 'retouch' | 'teleprompter' | 'flash';

const RATIOS = [
  { id: '9:16', label: '9:16', r: 9 / 16 },
  { id: '4:5', label: '4:5', r: 4 / 5 },
  { id: '1:1', label: '1:1', r: 1 },
  { id: '16:9', label: '16:9', r: 16 / 9 },
] as const;

const DURATIONS = [
  { id: 15, label: '15s' },
  { id: 30, label: '30s' },
  { id: 60, label: '1m' },
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
  onPickedMedia,
  onTextMode,
  overlay = null,
  sound = null,
}: {
  visible: boolean;
  onClose: () => void;
  onCaptured: (asset: CapturedAsset) => void;
  onAddSound: () => void;
  soundName: string | null;
  /**
   * The chosen track, so the camera can play it while you record.
   *
   * It is heard, not captured: recordAsync takes the microphone, and playing a
   * track into that microphone records the speaker as well as the room — the
   * post would then carry the sound twice. So the take is muted while a sound
   * is attached, and the sound reaches the post the way every other one does,
   * through the composer. (See the note in startRecording.)
   */
  sound?: { url?: string | null; start?: number; end?: number } | null;
  /**
   * What came back from the phone's library.
   *
   * The camera opens the library itself and hands the result straight to the
   * flow, which is the whole point of the PHOTO pill: tap it and you are in
   * your photos, pick as many as you like, and you land in the composer with
   * them attached. Nothing in between.
   */
  onPickedMedia: (assets: CapturedAsset[]) => void;
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
  const [muted, setMuted] = useState(false);
  const [timer, setTimer] = useState<(typeof TIMERS)[number]>(0);
  const [ratio, setRatio] = useState<(typeof RATIOS)[number]['id']>('9:16');
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]['id']>('free');
  // 0 = off, 1 = soft, 2 = strong. Not a boolean any more: "beauty on" with no
  // way to say how much is a control you set once and never touch again.
  const [retouch, setRetouch] = useState<0 | 1 | 2>(0);
  const [duration, setDuration] = useState<number>(15);

  const [tool, setTool] = useState<ToolId | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  // Rear sensor only. Front cameras have no torch on Android, so the button
  // says so instead of silently doing nothing.
  const [torch, setTorch] = useState(false);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------- multi-clip session ----------
  //
  // One tap of the shutter used to be the whole video. Now a session is a list
  // of clips: record, stop, record again, and the previous clips stay. They are
  // separate files until Finish, where they are joined (see `finish` and
  // concatClips) — a post is one video, but a take is not always one shot.
  const [clips, setClips] = useState<{ uri: string; ms: number }[]>([]);
  // how many ms the clips already hold, so the duration cap covers the whole
  // session rather than each clip separately
  const [committedMs, setCommittedMs] = useState(0);
  const [finishing, setFinishing] = useState(false);

  const [script, setScript] = useState('');
  const [prompterOn, setPrompterOn] = useState(false);
  // Readable is a choice: the same script needs a bigger size on a short phone
  // and a slower crawl when it is long.
  const [prompterSpeed, setPrompterSpeed] = useState(1);
  const [prompterSize, setPrompterSize] = useState(18);
  const prompterY = useRef(new Animated.Value(0)).current;

  // Pulse under the shutter while a clip is being recorded.
  const pulse = useRef(new Animated.Value(0)).current;

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
  // Teleprompter — a looping scroll, with the two things that decide whether
  // you can actually read it: how fast it moves and how big the text is.
  //
  // The speed multiplies the auto duration, so "slow" is slower relative to the
  // script's own length rather than a fixed number of pixels per second that
  // reads differently on every phone.
  // ---------------------------------------------------------------
  useEffect(() => {
    prompterY.stopAnimation();
    prompterY.setValue(0);
    if (!prompterOn || !script.trim() || !visible) return;
    const loop = Animated.loop(
      Animated.timing(prompterY, {
        // bigger text makes the block taller, so it has further to travel
        toValue: -Math.max(120, script.length * (prompterSize / 11)),
        duration:
          Math.max(6000, script.length * 55) / Math.max(0.4, prompterSpeed),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [prompterOn, script, visible, prompterY, prompterSpeed, prompterSize]);

  // The breath under the shutter while a clip is running.
  useEffect(() => {
    if (!recording) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [recording, pulse]);

  // ---------------------------------------------------------------
  // Recording clock
  //
  // `capMs` is the whole SESSION, not this clip: duration × 1000 is what the
  // user chose, and it is spent by every clip in the take. Elapsed is this
  // clip's clock; committedMs is what the earlier clips used.
  // ---------------------------------------------------------------
  const capMs = duration * 1000;
  const remainingMs = Math.max(0, capMs - committedMs);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      if (committedMs + ms >= capMs) void stopRecording();
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, capMs, committedMs]);

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

    // The cap belongs to the session. Hitting it mid-take must not start a new
    // clip that the same rule would immediately cut off.
    if (capMs - committedMs < 500) {
      setError('That is the whole take — delete a clip or pick a longer length.');
      return;
    }

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

    // A track is audible in the room while you perform to it, so an open
    // microphone would record the speaker on top of the room and the post
    // would carry the sound twice — once from the take, once attached. The
    // take therefore stays muted and the track reaches the post as an
    // attachment, the same route every other sound takes.
    if (sound?.url) {
      mute = true;
      if (!muted) setAudioNote('Recording to your sound — the clip takes the track, not your mic.');
    }

    try {
      setBusy(true);
      recordingRef.current = true;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      const result = await camRef.current.recordAsync({
        // what is LEFT of the chosen length, so clip 2 cannot overrun what
        // clip 1 did not use
        maxDuration: Math.max(1, Math.round((capMs - committedMs) / 1000)),
        mute,
      } as any);
      // recordAsync resolves when stopRecording() is called or maxDuration hits
      recordingRef.current = false;
      setRecording(false);
      const ms = Date.now() - startedAtRef.current;
      if (result?.uri) {
        // A clip JOINS the session instead of ending it. This is the whole
        // difference between a camera that shoots a take and one that shoots a
        // single shot.
        setClips((prev) => [...prev, { uri: result.uri as string, ms }]);
        setCommittedMs((prev) => prev + ms);
        setElapsed(0);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Recording failed');
      recordingRef.current = false;
      setRecording(false);
    } finally {
      setBusy(false);
    }
  }, [busy, capMs, committedMs, muted, micPermission, requestMicPermission, sound?.url]);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    try {
      camRef.current?.stopRecording();
    } catch {
      // already stopped
    }
  }, []);

  /**
   * PHOTO — the phone's library, directly.
   *
   * This is expo-image-picker's system picker, not the composer's "Add media"
   * sheet: the pill is pressed on the viewfinder, so the viewfinder has to be
   * what answers it. Multi-select is on because a photo post is a strip of up
   * to six, and picking them one at a time from a modal was three taps to do
   * what Android's own picker does in one.
   */
  const openLibrary = useCallback(
    async (kind: 'images' | 'any') => {
      if (busy) return;
      setError(null);
      try {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError('Photo access is off — allow it to pick from your library.');
          return;
        }
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: kind === 'images' ? ['images'] : ['images', 'videos'],
          allowsMultipleSelection: true,
          // the composer keeps a strip of six; asking for more only to drop
          // the extras on arrival would be a lie
          selectionLimit: 6,
          quality: 0.9,
        });
        if (res.canceled || res.assets.length === 0) return;
        onPickedMedia(
          res.assets.map((a) => ({
            uri: a.uri,
            width: a.width ?? 0,
            height: a.height ?? 0,
            type: a.type === 'video' ? 'video' : 'image',
            fileName: a.fileName ?? `library-${Date.now()}`,
            mimeType: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
            durationMs: a.duration ?? null,
          }))
        );
      } catch (e: any) {
        setError(e?.message ?? 'Could not open your photos');
      }
    },
    [busy, onPickedMedia]
  );

  const fire = useCallback(() => {
    if (recordingRef.current) {
      void stopRecording();
      return;
    }
    void startRecording();
  }, [startRecording, stopRecording]);

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

  /**
   * Flip, but not mid-take.
   *
   * Switching the sensor while recordAsync is resolving tears the recording
   * session out from under the recorder — the clip comes back empty or the call
   * rejects. Refusing the tap and saying why is the honest version of
   * "preserve recording state".
   */
  const flip = () => {
    if (recordingRef.current) {
      setError('Stop recording before you flip the camera.');
      return;
    }
    setTorch(false); // the torch lives on the rear sensor
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
  };

  /** A take belongs to one visit. Leaving the camera drops the clips. */
  const resetSession = () => {
    setClips([]);
    setCommittedMs(0);
    setElapsed(0);
    setError(null);
  };

  const closeCamera = () => {
    resetSession();
    onClose();
  };

  /** Throw away the clip you just shot. The session keeps its earlier clips. */
  const deleteLastClip = () => {
    if (recordingRef.current || clips.length === 0) return;
    const last = clips[clips.length - 1];
    setClips((prev) => prev.slice(0, -1));
    setCommittedMs((prev) => Math.max(0, prev - last.ms));
    setElapsed(0);
    setError(null);
  };

  /**
   * Done. One clip is handed over as it is; several are joined into one file
   * first, because a post is one video and the composer edits one video.
   *
   * The join needs ffmpeg (a dev/production build). If it is missing — Expo Go,
   * or a device where the native module did not link — saying so is better than
   * silently posting the first clip and losing the rest.
   */
  const finish = async () => {
    if (recordingRef.current || finishing || clips.length === 0) return;
    setError(null);
    if (clips.length === 1) {
      const only = clips[0];
      resetSession();
      onCaptured({
        uri: only.uri,
        width: 0,
        height: 0,
        type: 'video',
        fileName: `capture-${Date.now()}.mp4`,
        mimeType: 'video/mp4',
        durationMs: only.ms,
        retouch,
        aspect: ratioValue,
      });
      return;
    }
    setFinishing(true);
    try {
      const merged = await concatClips(clips.map((c) => c.uri));
      const ms = clips.reduce((sum, c) => sum + c.ms, 0);
      resetSession();
      onCaptured({
        uri: merged ?? clips[0].uri,
        width: 0,
        height: 0,
        type: 'video',
        fileName: `capture-${Date.now()}.mp4`,
        mimeType: 'video/mp4',
        durationMs: ms,
        retouch,
        aspect: ratioValue,
      });
    } catch (e: any) {
      setError(
        `Could not join the ${clips.length} clips on this build. Delete some and keep one, or update the app.`
      );
    } finally {
      setFinishing(false);
    }
  };

  /**
   * Ratio, layout and length are composition settings for the TAKE, not for a
   * clip. Changing them while clips exist would stitch two different shapes
   * into one export, so they lock — and say why, rather than being a dead tap.
   * Pausing between clips is not pausing the camera: the viewfinder stays live,
   * the timer keeps its place, and recording simply resumes.
   */
  const takeLocked = clips.length > 0;
  const lockedNudge = () =>
    setError('Locked for this take — delete the clips to change ratio, layout or length.');

  const railTools: { id: ToolId; label: string; icon: string; on: boolean }[] = [
    { id: 'timer', label: 'Timer', icon: 'timer-outline', on: timer > 0 },
    { id: 'layout', label: 'Layout', icon: 'grid-outline', on: layout !== 'free' },
    { id: 'ratio', label: 'Ratio', icon: 'scan-outline', on: ratio !== '9:16' },
    { id: 'retouch', label: 'Retouch', icon: 'sparkles-outline', on: retouch > 0 },
    { id: 'teleprompter', label: 'Prompt', icon: 'document-text-outline', on: prompterOn },
    { id: 'flash', label: 'Flash', icon: 'flash-outline', on: torch },
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
      <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={closeCamera}>
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
            <Pressable onPress={closeCamera} hitSlop={10} style={styles.permSkip}>
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
          mode="video"
          mute={muted}
          // torch is a rear-sensor property; asking for it on the selfie camera
          // throws on some devices and is ignored on the rest
          enableTorch={torch && facing === 'back'}
          onCameraReady={() => setReady(true)}
        />

        {/* Retouch. The veil is the preview of a grade that is handed to the
            composer and applied at export (videoProcessor 'retouch-soft' /
            'retouch-strong'), so what you see here is what ships. Nothing is
            claimed when the level is off. */}
        {retouch > 0 && (
          <View
            pointerEvents="none"
            style={[styles.retouchVeil, { opacity: retouch === 2 ? 1 : 0.6 }]}
          />
        )}

        {/* The chosen sound, playing in sync with the take — so you can perform
            to it rather than guess. Same component the feed and the preview use,
            so the window/loop rules cannot drift between them. Renders nothing. */}
        <SoundTrack
          url={sound?.url ?? null}
          start={sound?.start ?? 0}
          end={sound?.end ?? null}
          active={recording}
        />

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
              <Text
                style={[
                  styles.prompterText,
                  { fontSize: prompterSize, lineHeight: Math.round(prompterSize * 1.45) },
                ]}
              >
                {script}
              </Text>
            </Animated.View>
          </View>
        )}

        {/* ---------- top bar ---------- */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={closeCamera} hitSlop={12} style={styles.iconBtn} accessibilityLabel="Close camera">
            <Icon name="close" size={20} color={WHITE} />
          </Pressable>

          {/* The chosen sound, at the top where you can see it while you shoot.
              It turns accent-coloured and says "playing" for exactly as long as
              the track is actually running (i.e. while recording), so the state
              on screen is the state you can hear. */}
          <Pressable
            onPress={onAddSound}
            style={[styles.soundPill, !!sound?.url && styles.soundPillOn]}
            accessibilityLabel={soundName ? `Sound: ${soundName}. Change sound` : 'Add a sound'}
          >
            <Icon
              name={recording && sound?.url ? 'volume-high' : 'musical-notes'}
              size={14}
              color={recording && sound?.url ? colors.accent : WHITE}
            />
            <Text style={styles.soundPillText} numberOfLines={1}>
              {soundName ?? 'Add sound'}
            </Text>
            {recording && !!sound?.url && <Text style={styles.soundPillLive}>playing</Text>}
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

            {/* Scrollable on a short screen: six tools plus the collapse handle
                is taller than a 640dp viewfinder once the top bar and the
                shutter row are accounted for, and a tool you cannot reach is a
                tool that does not exist. */}
            {railOpen && (
              <ScrollView
                style={styles.railScroll}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.railScrollInner}
              >
                {railTools.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => setTool((cur) => (cur === t.id ? null : t.id))}
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
              </ScrollView>
            )}

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
                      onPress={() => (takeLocked ? lockedNudge() : setLayout(l.id))}
                      style={[
                        styles.chip,
                        layout === l.id && styles.chipOn,
                        takeLocked && styles.lockedDim,
                      ]}
                    >
                      <Text style={[styles.chipText, layout === l.id && styles.chipTextOn]}>
                        {l.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>
                  Real guides, drawn over the live preview so you can place the
                  frame before you shoot.
                </Text>
                {/* The spec asks for a split-screen/grid RECORDING mode "where
                    technically supported". A phone camera exposes one sensor
                    stream at a time, so a live split cannot be recorded here —
                    and offering a chip that quietly recorded a single frame
                    would be the exact thing the spec forbids. Split screen is
                    still reachable honestly: shoot the pieces as separate clips
                    and combine them in the editor. */}
                <Text style={styles.panelSub}>Split screen</Text>
                <Text style={styles.panelHint}>
                  Live split capture needs two camera streams at once and this
                  camera exposes one. Record the pieces as separate clips and
                  combine them in the editor — that route is real.
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
                      onPress={() => (takeLocked ? lockedNudge() : setRatio(r.id))}
                      style={[
                        styles.chip,
                        ratio === r.id && styles.chipOn,
                        takeLocked && styles.lockedDim,
                      ]}
                    >
                      <Text style={[styles.chipText, ratio === r.id && styles.chipTextOn]}>
                        {r.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>
                  The preview frames it and the export is cropped to it — the file
                  you post is this shape, not just a mask over the sensor.
                </Text>
              </>
            )}

            {tool === 'retouch' && (
              <>
                <Text style={styles.panelTitle}>Retouch</Text>
                <View style={styles.chipRow}>
                  {([0, 1, 2] as const).map((lvl) => (
                    <Pressable
                      key={lvl}
                      onPress={() => setRetouch(lvl)}
                      style={[styles.chip, retouch === lvl && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, retouch === lvl && styles.chipTextOn]}>
                        {lvl === 0 ? 'Off' : lvl === 1 ? 'Soft' : 'Strong'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelHint}>
                  Warmth, brightness and a light sharpen. Previewed here and applied
                  for real when you export — not painted on and forgotten.
                </Text>
              </>
            )}

            {tool === 'flash' && (
              <>
                <Text style={styles.panelTitle}>Flash</Text>
                <View style={styles.chipRow}>
                  <Pressable
                    onPress={() => setTorch((v) => !v)}
                    style={[styles.chip, torch && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, torch && styles.chipTextOn]}>
                      {torch ? 'Torch on' : 'Torch off'}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.panelHint}>
                  {facing === 'front'
                    ? 'The selfie camera has no torch — switch to the rear camera to use it.'
                    : 'The torch stays on for the whole take, so it can be used as a light.'}
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
                <Text style={styles.panelSub}>Speed</Text>
                <View style={styles.chipRow}>
                  {[
                    { v: 0.6, l: 'Slow' },
                    { v: 1, l: 'Normal' },
                    { v: 1.6, l: 'Fast' },
                  ].map((s) => (
                    <Pressable
                      key={s.l}
                      onPress={() => setPrompterSpeed(s.v)}
                      style={[styles.chip, prompterSpeed === s.v && styles.chipOn]}
                    >
                      <Text
                        style={[styles.chipText, prompterSpeed === s.v && styles.chipTextOn]}
                      >
                        {s.l}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.panelSub}>Text size</Text>
                <View style={styles.chipRow}>
                  {[
                    { v: 15, l: 'S' },
                    { v: 18, l: 'M' },
                    { v: 23, l: 'L' },
                  ].map((s) => (
                    <Pressable
                      key={s.l}
                      onPress={() => setPrompterSize(s.v)}
                      style={[styles.chip, prompterSize === s.v && styles.chipOn]}
                    >
                      <Text
                        style={[styles.chipText, prompterSize === s.v && styles.chipTextOn]}
                      >
                        {s.l}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() => {
                      setTool(null);
                      setPrompterOn(true);
                    }}
                    style={[styles.chip, prompterOn && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, prompterOn && styles.chipTextOn]}>
                      {prompterOn ? 'Scrolling — tap to stop' : 'Start scroll'}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {/* ---------- recording HUD ----------
            A session, not a shot: the clock and the bar measure the clips that
            are already safe PLUS the one being recorded, against the length the
            user chose. The thin marks under the bar are where each earlier clip
            ended, so "how much do I have left" is one glance. */}
        {(recording || clips.length > 0) && (
          <View style={[styles.hud, { top: insets.top + 62 }]} pointerEvents="none">
            <View style={styles.hudTopRow}>
              <View style={[styles.hudDot, !recording && styles.hudDotIdle]} />
              <Text style={styles.hudText}>
                {fmtElapsed(Math.min(capMs, committedMs + (recording ? elapsed : 0)))}
                <Text style={styles.hudTextDim}> / {fmtElapsed(capMs)}</Text>
              </Text>
              {clips.length > 0 && (
                <Text style={styles.hudClips}>
                  {clips.length} {clips.length === 1 ? 'clip' : 'clips'}
                </Text>
              )}
            </View>
            <View style={styles.hudTrack}>
              <View
                style={[
                  styles.hudFill,
                  {
                    width: `${Math.min(
                      100,
                      ((committedMs + (recording ? elapsed : 0)) / capMs) * 100
                    )}%`,
                  },
                ]}
              />
            </View>
            {clips.length > 0 && (
              <View style={styles.segRow}>
                {clips.map((c, i) => (
                  <View
                    key={`${c.uri}-${i}`}
                    style={[styles.seg, { flex: Math.max(0.2, c.ms) }]}
                  />
                ))}
                {recording && <View style={[styles.seg, styles.segLive, { flex: Math.max(0.2, elapsed) }]} />}
              </View>
            )}
          </View>
        )}

        {/* Between takes: the take is safe on disk, say so, because a stopped
            camera with a full bar looks like nothing happened. */}
        {!recording && clips.length > 0 && (
          <View style={[styles.resumeHint, { bottom: insets.bottom + 214 }]} pointerEvents="none">
            <Text style={styles.resumeHintText}>
              Tap the shutter to keep recording — or Next when you are done.
            </Text>
          </View>
        )}

        {/* ---------- countdown ---------- */}
        {countdown !== null && (
          <View pointerEvents="none" style={styles.countWrap}>
            <Text style={styles.countNum}>{countdown}</Text>
            <Text style={styles.countHint}>Get ready</Text>
          </View>
        )}

        {/* ---------- bottom ---------- */}
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
          {!!error && <Text style={styles.error}>{error}</Text>}
          {/* Not an error — the clip was recorded. It just has no sound, and the
              user deserves to know before they post it. */}
          {!error && !!audioNote && <Text style={styles.note}>{audioNote}</Text>}

          {/* Recording length. This is a VIDEO setting — 15s/60s/3m/10m is how
              long the take runs, and it means nothing at all next to a photo,
              which is why it is not shown in front of the library any more. */}
          <View style={styles.durRow}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => (takeLocked ? lockedNudge() : setDuration(d.id))}
                style={[
                  styles.durChip,
                  duration === d.id && styles.durChipOn,
                  takeLocked && styles.lockedDim,
                ]}
                accessibilityLabel={`Record up to ${d.label}`}
              >
                <Text style={[styles.durText, duration === d.id && styles.durTextOn]}>
                  {d.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* VIDEO is the viewfinder you are looking through. PHOTO and TEXT are
              destinations: one opens your library, the other leaves for the
              text page. They are actions wearing a tab's clothes, and they sit
              deliberately unselected because there is nothing to be selected —
              pressing them leaves this screen. */}
          <View style={styles.modePills}>
            <View style={[styles.modePill, styles.modePillOn]}>
              <Text style={[styles.modePillText, styles.modePillTextOn]}>VIDEO</Text>
            </View>
            {(['photo', 'text'] as Launcher[]).map((l) => (
              <Pressable
                key={l}
                onPress={() => {
                  setTool(null);
                  if (l === 'text') onTextMode();
                  else void openLibrary('images');
                }}
                style={styles.modePill}
                accessibilityLabel={l === 'photo' ? 'Pick photos from your library' : 'Create a text drop'}
              >
                <Text style={styles.modePillText}>{l.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.shutterRow}>
            {/* gallery tiles first, so the shutter stays optically centred */}
            <View style={styles.galleryRow}>
              {recent.length > 0 ? (
                recent.map((r, i) => (
                  <Pressable
                    key={`${r.uri}-${i}`}
                    onPress={() => void openLibrary('any')}
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
                <Pressable onPress={() => void openLibrary('any')} style={[styles.galTile, styles.galEmpty]}>
                  <Icon name="images-outline" size={16} color={WHITE} />
                </Pressable>
              )}
            </View>

            <Pressable
              onPress={armShutter}
              disabled={!ready || busy}
              style={styles.shutterOuter}
              accessibilityLabel={
                recording ? 'Stop recording' : clips.length > 0 ? 'Record another clip' : 'Start recording'
              }
            >
              <View style={[styles.shutterRing, recording && styles.shutterRingRec]} />
              <Animated.View
                style={[
                  styles.shutterInner,
                  recording && styles.shutterInnerRec,
                  // a slow breath under the button while it is live: the only
                  // thing on this screen that says "this is still running"
                  // without you reading a number
                  {
                    transform: [
                      {
                        scale: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.12],
                          extrapolate: 'clamp',
                        }),
                      },
                    ],
                  },
                ]}
              >
                {busy && !recording ? (
                  <ActivityIndicator color={INK} size="small" />
                ) : recording ? (
                  <View style={styles.shutterStop} />
                ) : null}
              </Animated.View>
            </Pressable>

            {/* Right column: undo the last clip, and get out with the take. */}
            <View style={styles.shutterSpacer}>
              {clips.length > 0 && !recording && (
                <>
                  <Pressable
                    onPress={deleteLastClip}
                    hitSlop={8}
                    style={styles.clipBtn}
                    accessibilityLabel="Delete the last clip"
                  >
                    <Icon name="backspace-outline" size={18} color={WHITE} />
                  </Pressable>
                  <Pressable
                    onPress={() => void finish()}
                    disabled={finishing}
                    style={[styles.nextBtn, finishing && styles.nextBtnBusy]}
                    accessibilityLabel="Use this take"
                  >
                    {finishing ? (
                      <ActivityIndicator size="small" color={INK} />
                    ) : (
                      <>
                        <Text style={styles.nextText}>Next</Text>
                        <Icon name="arrow-forward" size={15} color={INK} />
                      </>
                    )}
                  </Pressable>
                </>
              )}
            </View>
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
  // a track is attached: the pill earns a hairline of accent so the viewfinder
  // reads "you are performing to something" at a glance
  soundPillOn: { borderColor: colors.accent },
  soundPillText: { color: WHITE, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  soundPillLive: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

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
  // The tool column scrolls inside the rail so six tools never run into the
  // shutter row on a short screen.
  railScroll: { maxHeight: 356, flexGrow: 0 },
  railScrollInner: { alignItems: 'center', gap: 12 },
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
  /** composition settings lock once a take has clips in it — visible, not inert */
  lockedDim: { opacity: 0.45 },
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
    gap: 6,
  },
  hudTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hudDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  // between takes: the take exists, the camera is just not running
  hudDotIdle: { backgroundColor: 'rgba(255,255,255,0.5)' },
  hudText: { color: WHITE, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hudTextDim: { color: 'rgba(255,255,255,0.5)', fontWeight: '700' },
  hudClips: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  hudTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  hudFill: { height: 3, backgroundColor: colors.accent },
  // one mark per clip, width proportional to its length
  segRow: { flexDirection: 'row', gap: 3, height: 3 },
  seg: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.55)' },
  segLive: { backgroundColor: colors.accent },

  resumeHint: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  resumeHintText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },

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

  shutterStop: { width: 22, height: 22, borderRadius: 5, backgroundColor: colors.danger },
  shutterSpacer: {
    width: 130,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 8,
  },
  clipBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 96,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  nextBtnBusy: { opacity: 0.7 },
  nextText: { color: INK, fontSize: 14, fontWeight: '800' },
  panelSub: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 4,
  },
});
