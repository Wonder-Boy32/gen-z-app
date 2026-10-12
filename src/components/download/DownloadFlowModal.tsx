import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { colors, radius } from '../../theme';
import { TOP_INSET } from '../../utils/useInsets';
import { friendlyError } from '../../utils/friendlyError';
import { supabase } from '../../supabase/client';
import {
  fetchMediaToCache,
  genzDownloadStamp,
  mediaItemsOf,
  saveToGallery,
} from '../../utils/downloadMedia';

// Reads a LOCAL video file's duration via expo-video (seconds) — reliable,
// no ffmpeg needed. Returns null if it can't be determined quickly.
async function localVideoDurationSec(uri: string): Promise<number | null> {
  try {
    const { createVideoPlayer } = require('expo-video');
    const player = createVideoPlayer({ uri });
    const t0 = Date.now();
    let d: number | null = null;
    while (Date.now() - t0 < 6000) {
      const dur = player.duration;
      if (typeof dur === 'number' && dur > 0 && !Number.isNaN(dur)) {
        d = dur;
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    try {
      player.release();
    } catch {
      // ignore
    }
    return d;
  } catch {
    return null;
  }
}
import {
  bakeDownloadVideo,
  bakePhotoWatermark,
  downloadBakeReady,
} from '../../utils/videoProcessor';

// ============================================================
// DownloadFlowModal — TikTok-style save-to-gallery.
//   video:  ffmpeg bakes a corner GENZ watermark into a copy of the file.
//           No audio is ever added — downloading never re-scores the video,
//           so the creator's own sound is what the viewer hears.
//   photo:  ffmpeg bakes the corner watermark (original res);
//           falls back to an on-screen capture where ffmpeg
//           is unavailable (Expo Go)
// Respects the creator's Downloads OFF toggle (checked by the
// caller before opening).
// ============================================================

type Props = {
  post: {
    id: string;
    media_url: string | null;
    media_type: 'video' | 'image' | null;
    media_items?: { url: string; type: string }[] | null;
    sound_url?: string | null;
    profile?: { username: string } | null;
    // the post object does not always carry its profile join — FeedPost defends
    // against exactly the same thing by printing @unknown — so keep the author
    // id around to recover the handle from
    user_id?: string;
  };
  onClose: () => void;
};

type Phase = 'prep' | 'bake' | 'capture' | 'saving' | 'done';

// Corner pill shown on the saved media (logo + wordmark + @creator)
function WatermarkPill({ username }: { username: string }) {
  return (
    <View style={styles.pill}>
      <Image source={require('../../../assets/icon-navy.png')} style={styles.pillImg} />
      <Text style={styles.pillWord}>GEN Z</Text>
      {!!username && <Text style={styles.pillUser}>@{username}</Text>}
    </View>
  );
}

export default function DownloadFlowModal({ post, onClose }: Props) {
  const items = mediaItemsOf(post);
  // The @handle is the one part of the watermark the bake cannot draw for itself:
  // drawtext is not in the slim ffmpeg whitelist, so the ONLY way a username
  // reaches the saved video is this pill being captured with it.
  //
  // post.profile is optional and is sometimes missing on the post object, in
  // which case this used to silently fall back to '' and the pill was captured
  // with the mark and wordmark but no handle. Recover it from the author id.
  const [handle, setHandle] = useState(post.profile?.username ?? '');
  const handleSettled = useRef(!!post.profile?.username);

  useEffect(() => {
    if (post.profile?.username) {
      handleSettled.current = true;
      return;
    }
    let alive = true;
    (async () => {
      try {
        if (!post.user_id) return;
        const { data } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', post.user_id)
          .maybeSingle();
        const name = (data as { username?: string } | null)?.username;
        if (alive && name) setHandle(name);
      } catch {
        // no handle available — the pill still carries the mark and the wordmark
      } finally {
        if (alive) handleSettled.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, [post.profile?.username, post.user_id]);

  const username = post.profile?.username ?? handle;
  const [phase, setPhase] = useState<Phase>('prep');
  const [label, setLabel] = useState('Preparing…');
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState(0);
  // True when a video was saved WITHOUT the GEN Z mark: either every ffmpeg
  // plan failed, or the plan that worked cannot draw the mark. Surfaced rather
  // than hidden - the user should know what they actually got.
  const [unbranded, setUnbranded] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null); // cached photo ready for capture
  const shotRef = useRef<View>(null);
  const capturedOnce = useRef(false);
  // "GEN Z @creator" pill captured to a PNG and fed to the ffmpeg bake, so
  // baked videos/photos carry the creator's handle (not just the wordmark).
  const pillShotRef = useRef<View>(null);
  const pillFired = useRef(false);
  const pillUriRef = useRef<string | null>(null);
  const pillWaiters = useRef<Array<(uri: string | null) => void>>([]);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        for (let i = 0; i < items.length; i++) {
          if (dead) return;
          setIndex(i);
          const item = items[i];
          const total = items.length;
          const countLabel = total > 1 ? ` (${i + 1}/${total})` : '';

          if (item.type === 'video') {
            if (!downloadBakeReady()) {
              throw new Error(
                'Video downloads need the GENZ app build — the Expo Go preview has no video encoder. Install the latest GENZ APK and try again.'
              );
            }
            setPhase('bake');
            setLabel(`Adding GEN Z watermark${countLabel}…`);
            const local = await fetchMediaToCache(item.url, `video-${post.id}`);
            let music: string | null = null;
            if (post.sound_url) {
              try {
                music = await fetchMediaToCache(post.sound_url, 'music');
              } catch {
                music = null;
              }
            }
            // measure duration from the LOCAL file (reliable) — the bake needs it
            // for an exact -t cap when the picked track is looped to fit
            const durSec = await localVideoDurationSec(local);
            const wmShot = await waitPillShot();
            // The bake already walks a ladder of ffmpeg plans and ends with a
            // plain remux, so a throw here means even THAT failed. Save the
            // video the user asked for anyway and say what is missing, instead
            // of saving nothing.
            let out = local;
            let branded = false;
            let renameAs: string | undefined = genzDownloadStamp();
            try {
              const baked = await bakeDownloadVideo(local, music, durSec, wmShot);
              out = baked.uri;
              branded = baked.watermarked;
              // the bake already names its output GenZ_<date>_<hhmm>.mp4
              renameAs = undefined;
            } catch (e: any) {
              console.warn('[download] video bake failed - saving the original:', e?.message);
            }
            if (!branded) setUnbranded(true);
            setPhase('saving');
            setLabel('Saving to your phone…');
            await saveToGallery(out, renameAs);
            setSaved((s) => s + 1);
          } else {
            const local = await fetchMediaToCache(item.url, `photo-${post.id}`);
            let done = false;
            if (downloadBakeReady()) {
              try {
                setPhase('bake');
                setLabel(`Adding GEN Z watermark${countLabel}…`);
                const wmShot = await waitPillShot();
                const out = await bakePhotoWatermark(local, wmShot);
                setPhase('saving');
                setLabel('Saving to your phone…');
                await saveToGallery(out);
                done = true;
                setSaved((s) => s + 1);
              } catch (e: any) {
                // ffmpeg bake failed → fall back to the on-screen capture
                // path (works everywhere, incl. Expo Go)
                console.warn('[download] photo bake failed, capture fallback:', e?.message);
              }
            }
            if (!done) {
              // view-shot fallback (no encoder / bake failed)
              capturedOnce.current = false;
              setPreviewUri(local);
              setPhase('capture');
              // wait for the preview child to capture (it calls finishPhoto)
              await new Promise<void>((res, rej) => {
                const t = setInterval(() => {
                  if (capturedOnce.current) {
                    clearInterval(t);
                    res();
                  }
                }, 150);
                setTimeout(() => {
                  clearInterval(t);
                  rej(new Error('Could not capture the photo — try again.'));
                }, 8000);
              });
              setSaved((s) => s + 1);
            }
          }
        }
        if (dead) return;
        setPhase('done');
      } catch (e: any) {
        if (dead) return;
        const msg =
          typeof e?.message === 'string' && e.message
            ? e.message
            : 'Download failed — try again.';
        setPhase('prep');
        Alert.alert('Download failed', msg, [
          { text: 'OK', onPress: onClose },
        ]);
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishPhotoCapture = async (shotUri: string) => {
    capturedOnce.current = true;
    setPhase('saving');
    setLabel('Saving to your phone…');
    await saveToGallery(shotUri, genzDownloadStamp());
  };

  // Resolves with the captured pill PNG uri, or null only if the capture really
  // failed. Cached per modal session.
  //
  // This used to bail out early with `if (!username) return resolve(null)`, so a
  // post whose profile never reached this component got NO branded watermark at
  // all: the bake silently fell back to the bundled flat wordmark (white, no
  // logo, no handle). That is the "username missing + not my colour or logo"
  // report. The pill carries the GEN Z mark and the orange wordmark regardless of
  // whether we know the handle, so the branding must never be conditional on the
  // username — WatermarkPill already appends @handle only when it has one.
  const waitPillShot = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (pillUriRef.current) return resolve(pillUriRef.current);
      const done = (uri: string | null) => {
        pillWaiters.current = pillWaiters.current.filter((w) => w !== done);
        clearTimeout(timer);
        if (uri) pillUriRef.current = uri;
        resolve(uri);
      };
      // 6s rather than 3.5s: the pill contains an Image, and a cold asset decode
      // on a slow Android device can easily miss a short window
      const timer = setTimeout(() => done(null), 6000);
      pillWaiters.current.push(done);
    });

  const busy = phase === 'prep' || phase === 'bake' || phase === 'saving';
  const showShot = phase === 'capture' && !!previewUri;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={10}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        {showShot && previewUri ? (
          <ShotView
            uri={previewUri}
            username={username}
            innerRef={shotRef}
            onShot={finishPhotoCapture}
            onShotError={(e: any) => {
              capturedOnce.current = true;
              Alert.alert('Download failed', friendlyError(e, 'Could not save the photo. Please try again.'), [
                { text: 'OK', onPress: onClose },
              ]);
            }}
          />
        ) : (
          <View style={styles.center}>
            <View style={styles.card}>
              {busy ? (
                <ActivityIndicator size="large" color={colors.accent} />
              ) : (
                <Text style={styles.doneIcon}>✓</Text>
              )}
              <Text style={styles.cardText}>
                {phase === 'done'
                  ? saved > 0
                    ? `Saved ${saved} ${saved === 1 ? 'file' : 'files'} to your phone`
                    : 'Saved to your phone'
                  : label}
              </Text>
              {phase === 'done' && unbranded && (
                <Text style={styles.cardNote}>
                  Saved without the GEN Z mark - this video couldn't be watermarked.
                </Text>
              )}
              {phase === 'done' && (
                <Pressable style={styles.doneBtn} onPress={onClose}>
                  <Text style={styles.doneBtnText}>Done</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {(phase === 'prep' || phase === 'bake' || phase === 'capture') && (
          <View
            ref={pillShotRef}
            collapsable={false}
            style={styles.pillShot}
            onLayout={() => {
              if (pillFired.current) return;
              pillFired.current = true;
              setTimeout(async () => {
                // wait — bounded — for the handle lookup to land, so the pill is
                // captured WITH @name rather than racing the request
                for (let i = 0; i < 10 && !handleSettled.current; i++) {
                  await new Promise((r) => setTimeout(r, 150));
                }
                // one retry, and a slightly later first attempt: the original
                // fired at 200ms with no second chance, so a single failed
                // capture permanently downgraded the watermark to the flat asset
                let shot: string | null = null;
                for (let attempt = 0; attempt < 2 && !shot; attempt++) {
                  try {
                    shot = await captureRef(pillShotRef.current, {
                      format: 'png',
                      quality: 1,
                      result: 'tmpfile',
                    });
                  } catch {
                    shot = null;
                    await new Promise((r) => setTimeout(r, 250));
                  }
                }
                pillWaiters.current.forEach((w) => w(shot));
                pillWaiters.current = [];
              }, 350);
            }}
          >
            <WatermarkPill username={username} />
          </View>
        )}
      </View>
    </Modal>
  );
}

// Renders the cached photo + watermark pill and captures the composite.
function ShotView({
  uri,
  username,
  innerRef,
  onShot,
  onShotError,
}: {
  uri: string;
  username: string;
  innerRef: React.RefObject<View | null>;
  onShot: (shotUri: string) => void;
  onShotError: (e: any) => void;
}) {
  const fired = useRef(false);
  return (
    <View
      ref={innerRef}
      collapsable={false}
      style={styles.shotWrap}
      onLayout={() => {
        if (fired.current) return;
        fired.current = true;
        setTimeout(async () => {
          try {
            const shot = await captureRef(innerRef.current, {
              format: 'jpg',
              quality: 0.92,
              result: 'tmpfile',
            });
            onShot(shot);
          } catch (e) {
            onShotError(e);
          }
        }, 120);
      }}
    >
      <Image source={{ uri }} style={styles.shotImg} resizeMode="contain" />
      <View style={styles.shotPill}>
        <WatermarkPill username={username} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,6,15,0.92)',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: TOP_INSET + 12,
    right: 16,
    zIndex: 30,
    backgroundColor: colors.overlay,
    borderRadius: 999,
    padding: 10,
  },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  center: { alignItems: 'center' },
  card: {
    minWidth: 220,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 26,
  },
  doneIcon: { color: '#34D399', fontSize: 44, fontWeight: '900', marginBottom: 8 },
  cardText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 14,
  },
  cardNote: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 17,
  },
  doneBtn: {
    marginTop: 18,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 26,
    paddingVertical: 10,
  },
  doneBtnText: { color: '#fff', fontWeight: '800' },
  shotWrap: {
    width: '92%',
    alignSelf: 'center',
    aspectRatio: 3 / 4,
    backgroundColor: '#000',
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  shotImg: { width: '100%', height: '100%' },
  shotPill: { position: 'absolute', bottom: 14, right: 12 },
  pillShot: {
    position: 'absolute',
    bottom: 46,
    right: 18,
    zIndex: 50,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(7,11,24,0.55)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillImg: { width: 20, height: 20, borderRadius: 6 },
  pillWord: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 1.5, marginLeft: 6 },
  pillUser: { color: '#fff', fontSize: 13, fontWeight: '700', marginLeft: 8, opacity: 0.95 },
});
