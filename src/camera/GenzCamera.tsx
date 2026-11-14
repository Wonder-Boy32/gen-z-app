/**
 * GENZ CAMERA — the VisionCamera/Skia screen.
 *
 * Deliberately NOT a rewrite of CaptureScreen. It implements the same prop
 * contract so CreateFlow can swap between them, which means the old screen stays
 * the fallback until this one is proven on a device.
 *
 * What is genuinely real here:
 *   - Live filtering. <SkiaCamera> hands each frame to a worklet already wrapped
 *     as a GPU texture; we draw it through the SkSL look shader. The preview is
 *     the shader's output, not a tinted View.
 *   - Photos with the look baked in. takeSnapshot() returns the composited
 *     canvas, so the file contains the filtered pixels.
 *   - Front camera by default, flip, torch, native-style pinch zoom, grid.
 *
 * What is NOT real here, stated so nobody is misled later:
 *   - Recording is a CameraVideoOutput, which encodes raw sensor frames. The
 *     look is applied to the preview and to photos, NOT to the .mp4. Baking AR
 *     into video needs a native encoder stage.
 *   - No AR overlays yet. Face landmarks are wired in the next increment; this
 *     file does not draw ears or glasses it cannot align.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
} from '@shopify/react-native-skia';
import { SkiaCamera, type SkiaCameraRef } from 'react-native-vision-camera-skia';
import {
  useCameraPermission,
  useMicrophonePermission,
  useVideoOutput,
} from 'react-native-vision-camera';
import { File, Paths } from 'expo-file-system';

import Icon from '../components/ui/Icon';
import { colors } from '../theme';
import { useFaceDetectorOutput } from 'react-native-vision-camera-face-detector';
import { LOOKS, LOOK_SHADER, findLook, uniformsFor, type LookId } from './looks';
import type { CapturedAsset } from '../screens/CaptureScreen';
import { buildLensArt, drawFaceLens, packFace, FACE_STRIDE, type ArEffect } from './arOverlay';

const WHITE = '#FFFFFF';
const INK = '#060A16';

const AR_ITEMS: { id: ArEffect; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'dog', label: 'Dog' },
  { id: 'shades', label: 'Shades' },
  { id: 'bunny', label: 'Bunny' },
];

export interface GenzCameraProps {
  visible: boolean;
  onClose: () => void;
  /** Same asset shape CaptureScreen emits, so CreateFlow needs no adapter. */
  onCaptured: (asset: CapturedAsset) => void;
  onPickedMedia?: () => void;
  onAddSound?: () => void;
  soundName?: string | null;
  overlay?: React.ReactNode;
}

export default function GenzCamera({
  visible,
  onClose,
  onCaptured,
  onPickedMedia,
  onAddSound,
  soundName,
  overlay = null,
}: GenzCameraProps) {
  const insets = useSafeAreaInsets();

  const cameraPermission = useCameraPermission();
  const micPermission = useMicrophonePermission();

  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [torch, setTorch] = useState(false);
  const [look, setLook] = useState<LookId>('none');
  const [grid, setGrid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [ar, setAr] = useState<ArEffect>('none');

  const camRef = useRef<SkiaCameraRef>(null);
  const videoOutput = useVideoOutput({ enableAudio: true });
  const recorderRef = useRef<Awaited<ReturnType<typeof videoOutput.createRecorder>> | null>(null);
  const startedAtRef = useRef(0);
  // True when the last press became a hold, so onPress does not fire a photo.
  const heldRef = useRef(false);
  // Last laid-out size of the preview, used for video assets: the recorder path
  // returns a file, not dimensions, and a 0x0 asset breaks aspect maths downstream.
  const layoutRef = useRef({ width: 0, height: 0 });

  // Uniforms ride a shared value so the frame worklet reads current values
  // without re-creating the callback on every look change (which would drop the
  // whole Skia render loop and show as a stutter at exactly the wrong moment).
  const uniforms = useSharedValue<number[]>(uniformsFor(findLook('none'), 1, 1));
  const activeLook = useMemo(() => findLook(look), [look]);

  // Paint is created once. Allocating it per frame would churn the GPU heap at
  // 30fps and stutter on a mid-range device.
  const paint = useMemo(() => Skia.Paint(), []);

  // ---- AR overlays -------------------------------------------------------
  // Face data crosses from the detector's thread to the render worklet through
  // a shared value, as a flat number array. Objects and HybridObjects cannot
  // cross that boundary safely.
  const faces = useSharedValue<number[]>([]);
  const arRef = useSharedValue<ArEffect>('none');

  // Lens art is built once on the JS thread. Building Paths per frame on the
  // GPU thread would allocate at 30fps and stall the preview.
  const art = useMemo(() => buildLensArt(Skia), []);

  // Paints are coloured on the JS thread; the worklet only draws with them.
  const paintFur = useMemo(() => Skia.Paint(), []);
  const paintFurDark = useMemo(() => Skia.Paint(), []);
  const paintPink = useMemo(() => Skia.Paint(), []);
  const paintDark = useMemo(() => Skia.Paint(), []);
  const paintGlass = useMemo(() => Skia.Paint(), []);
  const paintWhite = useMemo(() => Skia.Paint(), []);

  useEffect(() => {
    arRef.value = ar;
    paintFur.setColor(Skia.Color('#8A5A34'));
    paintFurDark.setColor(Skia.Color('#E8D3BC'));
    paintPink.setColor(Skia.Color('#FF9FAB'));
    paintDark.setColor(Skia.Color('#241B16'));
    paintGlass.setColor(Skia.Color('#101018'));
    paintWhite.setColor(Skia.Color('#FFFFFF'));
  }, [ar, arRef, paintFur, paintFurDark, paintPink, paintDark, paintGlass, paintWhite]);

  const faceDetectorOutput = useFaceDetectorOutput({
    // Fast is the right trade here: this runs per frame on a phone, and the
    // accurate model costs enough to drop the preview on mid-range hardware.
    performanceMode: 'fast',
    onFacesDetected: (detected) => {
      const first = detected?.[0];
      if (!first) {
        if (faces.value.length) faces.value = [];
        return;
      }
      // One face, stored flat. Wrapping it again would make it number[][] and
      // the worklet reads it as a flat block.
      faces.value = packFace(first as any) ?? [];
    },
    onError: () => {
      // A detection failure must not take the camera down with it.
    },
  });

  useEffect(() => {
    uniforms.value = uniformsFor(activeLook, 1080, 1920);
  }, [activeLook, uniforms]);

  // Ask once, as soon as the screen is useful — never mount a session before
  // the grant, because a session created pre-grant is never retried.
  const askedRef = useRef(false);
  useEffect(() => {
    if (!visible || askedRef.current) return;
    askedRef.current = true;
    if (!cameraPermission.hasPermission && cameraPermission.canRequestPermission) {
      void cameraPermission.requestPermission();
    }
  }, [visible, cameraPermission]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 100);
    return () => clearInterval(id);
  }, [recording]);

  const capturePhoto = useCallback(async () => {
    if (busy || recording) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = camRef.current?.takeSnapshot();
      if (!snapshot) throw new Error('The camera has not produced a frame yet.');
      const info = snapshot.getImageInfo();
      const base64 = snapshot.encodeToBase64();
      const fileName = `genz-${Date.now()}.png`;
      const file = new File(Paths.cache, fileName);
      file.write(base64, { encoding: 'base64' });
      onCaptured({
        uri: file.uri,
        width: info.width,
        height: info.height,
        type: 'image',
        fileName,
        mimeType: 'image/png',
        durationMs: null,
        aspect: info.height > 0 ? info.width / info.height : undefined,
      });
    } catch (e: any) {
      setError(e?.message ?? 'Could not capture the photo.');
    } finally {
      setBusy(false);
    }
  }, [busy, recording, onCaptured]);

  const toggleRecord = useCallback(async () => {
    if (busy) return;
    if (recording) {
      try {
        await recorderRef.current?.stopRecording();
      } catch {
        // already stopped
      }
      setRecording(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rec = await videoOutput.createRecorder({});
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      await rec.startRecording(
        (path) => {
          setRecording(false);
          if (!path) return;
          const { width, height } = layoutRef.current;
          onCaptured({
            uri: path.startsWith('file://') ? path : `file://${path}`,
            width,
            height,
            type: 'video',
            fileName: path.split(/[\\/]/).pop() || `genz-${Date.now()}.mp4`,
            mimeType: 'video/mp4',
            durationMs: Date.now() - startedAtRef.current,
            aspect: height > 0 ? width / height : undefined,
          });
        },
        (e) => {
          setRecording(false);
          setError(e?.message ?? 'Recording failed.');
        },
      );
    } catch (e: any) {
      setRecording(false);
      setError(e?.message ?? 'Could not start recording.');
    } finally {
      setBusy(false);
    }
  }, [busy, recording, videoOutput, onCaptured]);

  const zoom = useSharedValue(1);
  const startZoom = useSharedValue(1);
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .onStart(() => {
          'worklet';
          startZoom.value = zoom.value;
        })
        .onUpdate((e) => {
          'worklet';
          zoom.value = Math.min(8, Math.max(1, startZoom.value * e.scale));
        }),
    [zoom, startZoom],
  );

  if (!visible) return null;

  if (!cameraPermission.hasPermission) {
    return (
      <View style={[styles.root, styles.center]}>
        <Icon name="camera-outline" size={30} color={colors.accent} />
        <Text style={styles.gateTitle}>Camera access</Text>
        <Text style={styles.gateBody}>
          {cameraPermission.canRequestPermission
            ? 'GEN Z needs the camera to show your live preview.'
            : 'Camera access is blocked. Enable it in your phone settings, then reopen the camera.'}
        </Text>
        <Pressable
          style={styles.gateBtn}
          onPress={() => void cameraPermission.requestPermission()}
        >
          <Text style={styles.gateBtnText}>Allow camera</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.gateSkip}>Not now</Text>
        </Pressable>
      </View>
    );
  }

  const filterUnavailable = LOOK_SHADER === null;

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinch}>
        <View
          style={StyleSheet.absoluteFill}
          onLayout={(e) => {
            layoutRef.current = {
              width: Math.round(e.nativeEvent.layout.width),
              height: Math.round(e.nativeEvent.layout.height),
            };
          }}
        >
          <SkiaCamera
            ref={camRef}
            style={StyleSheet.absoluteFill}
            device={facing}
            isActive
            outputs={[videoOutput, faceDetectorOutput]}
            zoom={zoom}
            torchMode={torch && facing === 'back' ? 'on' : 'off'}
            onStarted={() => {
              setReady(true);
              setError(null);
            }}
            onError={(e) => setError(e?.message ?? 'The camera could not start.')}
            onFrame={(frame, render) => {
              'worklet';
              render(({ canvas, frameTexture }) => {
                if (LOOK_SHADER === null) {
                  canvas.drawImage(frameTexture, 0, 0);
                  return;
                }
                const imageShader = frameTexture.makeShaderOptions(
                  TileMode.Clamp,
                  TileMode.Clamp,
                  FilterMode.Linear,
                  MipmapMode.None,
                );
                const shader = LOOK_SHADER.makeShaderWithChildren(uniforms.value, [imageShader]);
                paint.setShader(shader);
                canvas.drawImage(frameTexture, 0, 0, paint);

                // Overlays draw AFTER the graded frame, in the same canvas, so
                // they land in the photo snapshot rather than floating in a
                // separate View above the preview.
                if (arRef.value !== 'none' && faces.value.length >= FACE_STRIDE) {
                  drawFaceLens(
                    canvas as any,
                    art,
                    faces.value,
                    frame.width,
                    frame.height,
                    arRef.value,
                    paintFur,
                    paintFurDark,
                    paintPink,
                    paintDark,
                    paintGlass,
                    paintWhite,
                  );
                }
              });
              frame.dispose();
            }}
          />
        </View>
      </GestureDetector>

      {!ready && !error && (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>Starting camera…</Text>
        </View>
      )}

      {!!error && (
        <View style={styles.loading} pointerEvents="none">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {grid && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={[styles.gridLine, { top: '33.33%' }]} />
          <View style={[styles.gridLine, { top: '66.66%' }]} />
          <View style={[styles.gridCol, { left: '33.33%' }]} />
          <View style={[styles.gridCol, { left: '66.66%' }]} />
        </View>
      )}

      {/* top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onClose} style={styles.round} accessibilityLabel="Close the camera">
          <Icon name="close" size={20} color={WHITE} />
        </Pressable>
        <Pressable onPress={onAddSound} style={styles.soundPill} accessibilityLabel="Add a sound">
          <Icon name="musical-notes" size={14} color={WHITE} />
          <Text style={styles.soundText} numberOfLines={1}>
            {soundName ?? 'Add sound'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
          style={styles.round}
          accessibilityLabel="Flip camera"
        >
          <Icon name="camera-reverse-outline" size={20} color={WHITE} />
        </Pressable>
      </View>

      {/* right rail */}
      <View style={[styles.rail, { top: insets.top + 78 }]}>
        <Pressable
          onPress={() => setTorch((t) => !t)}
          disabled={facing === 'front'}
          style={[styles.railBtn, torch && styles.railBtnOn, facing === 'front' && styles.railBtnOff]}
          accessibilityLabel="Toggle flash"
        >
          <Icon name={torch ? 'flash' : 'flash-off'} size={17} color={torch ? INK : WHITE} />
        </Pressable>
        <Pressable
          onPress={() => setGrid((g) => !g)}
          style={[styles.railBtn, grid && styles.railBtnOn]}
          accessibilityLabel="Toggle grid"
        >
          <Icon name="grid-outline" size={17} color={grid ? INK : WHITE} />
        </Pressable>
      </View>

      {/* AR row. Small, above the looks: effects are a second decision, not a
          competing one, and they compose with whatever look is chosen. */}
      <View style={[styles.arRow, { bottom: insets.bottom + 196 }]}>
        {AR_ITEMS.map((a) => {
          const on = a.id === ar;
          return (
            <Pressable
              key={a.id}
              onPress={() => setAr(a.id)}
              style={styles.lensWrap}
              accessibilityRole="button"
              accessibilityLabel={`${a.label} lens`}
              accessibilityState={{ selected: on }}
            >
              <View style={[styles.lensThumb, on && styles.lensThumbOn]}>
                <Icon
                  name={
                    (a.id === 'none'
                      ? 'ban-outline'
                      : a.id === 'dog'
                        ? 'paw'
                        : a.id === 'shades'
                          ? 'glasses-outline'
                          : 'happy-outline') as any
                  }
                  size={20}
                  color={on ? INK : WHITE}
                />
              </View>
              <Text style={[styles.lensText, on && styles.lensTextOn]}>{a.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* carousel */}
      <View style={[styles.tray, { paddingBottom: insets.bottom + 138 }]}>
        {filterUnavailable ? (
          <Text style={styles.filtersOff}>
            Filters are unavailable — this device&apos;s GPU rejected the shader. The camera still records.
          </Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.trayRow}>
            {LOOKS.map((l) => {
              const on = l.id === look;
              return (
                <Pressable key={l.id} onPress={() => setLook(l.id)} style={styles.swatchWrap}>
                  <View style={[styles.swatch, { backgroundColor: l.swatch }, on && styles.swatchOn]} />
                  <Text style={[styles.swatchText, on && styles.swatchTextOn]}>{l.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* shutter */}
      <View style={[styles.shutterRow, { paddingBottom: insets.bottom + 26 }]}>
        <Pressable onPress={onPickedMedia} style={styles.round} accessibilityLabel="Import from gallery">
          <Icon name="images-outline" size={19} color={WHITE} />
        </Pressable>

        <Pressable
          onPress={() => {
            // RN fires onPress on release even after a long press, so the hold
            // has to be consumed here or every recording would end with a
            // stray photo.
            if (heldRef.current) {
              heldRef.current = false;
              return;
            }
            if (recording) void toggleRecord();
            else void capturePhoto();
          }}
          onLongPress={() => {
            heldRef.current = true;
            void toggleRecord();
          }}
          delayLongPress={260}
          disabled={busy || !ready}
          style={styles.shutterOuter}
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Stop recording' : 'Take a photo, or hold to record'}
        >
          <View style={[styles.shutterInner, recording && styles.shutterRec]} />
        </Pressable>

        <View style={styles.timerBox}>
          {recording && <Text style={styles.timerText}>{fmt(elapsed)}</Text>}
        </View>
      </View>

      {overlay}
    </View>
  );
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: INK },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },

  gateTitle: { color: WHITE, fontSize: 19, fontWeight: '800', marginTop: 6 },
  gateBody: { color: 'rgba(255,255,255,0.72)', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  gateBtn: {
    marginTop: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  gateBtnText: { color: INK, fontWeight: '800', fontSize: 14 },
  gateSkip: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 6 },

  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  errorText: { color: '#FF8896', fontSize: 13, textAlign: 'center', paddingHorizontal: 28 },

  gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.22)' },
  gridCol: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.22)' },

  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    gap: 10,
  },
  round: {
    width: 42,
    height: 42,
    borderRadius: 999,
    backgroundColor: 'rgba(6,10,22,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soundPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 190,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 999,
    backgroundColor: 'rgba(6,10,22,0.62)',
  },
  soundText: { color: WHITE, fontSize: 13, fontWeight: '700', maxWidth: 150 },

  rail: { position: 'absolute', right: 12, gap: 10 },
  railBtn: {
    width: 42,
    height: 42,
    borderRadius: 999,
    backgroundColor: 'rgba(6,10,22,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  railBtnOn: { backgroundColor: colors.accent },
  railBtnOff: { opacity: 0.35 },

  arRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  // Circular lens thumbnails, the way Snapchat's lens tray reads: art first,
  // name underneath, selected state as a ring rather than a filled pill.
  lensWrap: { alignItems: 'center', gap: 5, width: 58 },
  lensThumb: {
    width: 46,
    height: 46,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6,10,22,0.6)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  lensThumbOn: { backgroundColor: colors.accent, borderColor: WHITE },
  lensText: { color: 'rgba(255,255,255,0.72)', fontSize: 9.5, fontWeight: '700' },
  lensTextOn: { color: WHITE },

  tray: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  trayRow: { paddingHorizontal: 14, gap: 12, alignItems: 'center' },
  swatchWrap: { alignItems: 'center', gap: 6, width: 62 },
  swatch: { width: 44, height: 44, borderRadius: 999, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: colors.accent },
  swatchText: { color: 'rgba(255,255,255,0.72)', fontSize: 10, fontWeight: '700' },
  swatchTextOn: { color: WHITE },
  filtersOff: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: 26,
  },

  shutterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 26,
  },
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 999, backgroundColor: WHITE },
  shutterRec: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#FF3B5C' },
  timerBox: { width: 42, alignItems: 'flex-end' },
  timerText: { color: WHITE, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
});









