// ============================================================
// src/create/CreateFlow.tsx
// ============================================================
// The create flow. One page at a time, one switch, one back.
//
// The list of pages and what "back" means is in ./flow.ts — not here, and not
// inside any page. This file only does three things:
//
//   1. decides which page renders (a switch you can read in ten seconds)
//   2. mounts the camera first, with the launcher sheet over it
//   3. forwards three intents from elsewhere in the app (a sound, a reply, a
//      shared file) straight to the composer, skipping the camera
//
// If you find yourself adding a second piece of navigation state to this file,
// stop: it belongs in BACK_FROM in flow.ts, or the page is wrong.

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import CaptureScreen, { type CapturedAsset } from '../screens/CaptureScreen';
import GenzCamera from '../camera/GenzCamera';
import CreateDropScreen from '../screens/CreateDropScreen';
import SoundPickerModal, { type PickedSound } from '../components/create/SoundPickerModal';
import { colors } from '../theme';
import { useAndroidBack } from '../utils/useAndroidBack';
import LaunchSheet from './LaunchSheet';

/**
 * Which camera opens. Off by default on purpose.
 *
 * The VisionCamera screen has live GPU looks and landmark AR that the
 * expo-camera one cannot do, but it does not yet have TEXT mode or gallery
 * import. Defaulting it on would silently remove two features the app already
 * ships, so the swap is opt-in:
 *
 *   EXPO_PUBLIC_CAMERA_V2=0
 *
 * It now defaults ON: the two gaps that justified hiding it (gallery import and
 * TEXT mode) are closed, so it no longer withholds a feature the app ships.
 * Both screens read the same CapturedAsset shape, so nothing downstream knows
 * which one produced the file.
 */
const CAMERA_V2 = process.env.EXPO_PUBLIC_CAMERA_V2 !== '0';
import TextImagePage from './TextImagePage';
import { BACK_FROM, type CreatePage, type LauncherChoice } from './flow';

export type CreateIntent = {
  sound?: string;
  replyTo?: string;
  mediaUri?: string;
};

export default function CreateFlow({
  visible,
  intent = null,
  hasDraft = false,
  onClose,
  onPosted,
  onSeeLive,
}: {
  visible: boolean;
  intent?: CreateIntent | null;
  /** shows "Continue your draft" in the sheet */
  hasDraft?: boolean;
  /** leave the flow entirely, back to whichever tab was underneath */
  onClose: () => void;
  onPosted: () => void;
  /** "See what's happening now" — the flow gets out of the way */
  onSeeLive: () => void;
}) {
  const [page, setPage] = useState<CreatePage>('camera');
  const [sheet, setSheet] = useState(false);
  const [capture, setCapture] = useState<CapturedAsset | null>(null);
  // photos chosen from the phone's library on the camera. Plural on purpose:
  // a photo post is a strip, and one pill press can pick six.
  const [picked, setPicked] = useState<CapturedAsset[] | null>(null);
  const [text, setText] = useState<string | null>(null);
  // the card colour picked on the text page, carried to the composer so the
  // Drop posts in the colour it was written in
  const [textBg, setTextBg] = useState<string | null>(null);
  // There is no "which sheet should the composer open on arrival" state any
  // more. The camera answers its own tools (sound sheet at this root, PHOTO in
  // the phone's library), so nothing has to be carried into the composer to be
  // acted on once it gets there.
  // "Continue your draft"
  const [resume, setResume] = useState(false);
  // The sound belongs to the FLOW, not to the camera page.
  //
  // It used to live only in the composer, so picking one from the camera meant
  // navigating into the composer — which is not where the user was, and not
  // where they wanted to be. A sound chosen on the viewfinder is part of what
  // you are about to shoot, so it is held above both pages and carried across.
  const [sound, setSound] = useState<PickedSound | null>(null);
  const [soundOpen, setSoundOpen] = useState(false);

  const hasIntent = !!(intent?.sound || intent?.replyTo || intent?.mediaUri);

  /**
   * Every open starts from the same place. An intent from elsewhere in the app
   * (a sound page, a Drop reply, a shared file) is the one thing that skips the
   * camera, because the user has already said what they want.
   */
  useEffect(() => {
    if (!visible) return;
    setCapture(null);
    setPicked(null);
    setText(null);
    setTextBg(null);
    setResume(false);
    setSound(null);
    setSoundOpen(false);
    setPage(hasIntent ? 'compose' : 'camera');
    setSheet(!hasIntent);
  }, [visible, hasIntent]);

  /**
   * Leaving the composer discards what was carried INTO it.
   *
   * Without this, the payload outlives the page: back out of a photo post, pick
   * "Create a Drop", and the old capture would be re-ingested into a text drop
   * on the next mount. The capture is an input to one visit, not a setting.
   */
  const resetCarried = () => {
    setCapture(null);
    setPicked(null);
    setText(null);
    setTextBg(null);
    setResume(false);
  };

  const back = useCallback(() => {
    const to = BACK_FROM[page];
    if (page === 'compose') resetCarried();
    if (to) setPage(to);
    else onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, onClose]);

  /**
   * The text page is a plain view, so Android back needs an owner. The camera
   * handles its own press (it is a Modal with onRequestClose) and the composer
   * runs its own internal back — it is mounted last, so BackHandler reaches it
   * first. This handler deliberately declines on both of those pages.
   */
  useAndroidBack(() => {
    if (page !== 'text') return false;
    back();
    return true;
  });

  /**
   * Back, while the launcher sheet is over the camera.
   *
   * The sheet is a plain view, not a Modal, so nothing closes it for free — and
   * without this the press fell through to the camera and shut the whole
   * viewfinder while the sheet was still on screen. Registered only while the
   * sheet is up, so it is the newest listener and runs first.
   */
  useAndroidBack(() => {
    setSheet(false);
    return true;
  }, sheet);

  /**
   * A switch with a `never` default, not an if-chain: add a fourth row to the
   * launcher and this stops compiling until it is handled. An unhandled choice
   * would silently do nothing, which is the worst possible outcome for a button.
   */
  const choose = (choice: LauncherChoice) => {
    setSheet(false);
    switch (choice) {
      case 'post':
        // already there — dismissing the sheet IS the action
        return;
      case 'live':
        onSeeLive();
        return;
      case 'resume':
        setResume(true);
        setPage('compose');
        return;
      case 'drop':
        // the text page starts empty by definition
        setCapture(null);
        setText(null);
    setTextBg(null);
        setPage('text');
        return;
      default: {
        const unhandled: never = choice;
        throw new Error(`unhandled launcher choice: ${String(unhandled)}`);
      }
    }
  };

  const captureThen = (a: CapturedAsset) => {
    setCapture(a);
    setPicked(null);
    setPage('compose');
  };

  /**
   * The library answered. That IS the navigation: the photos come back from the
   * phone's picker and the composer opens with them already attached, so the
   * only page the user ever sees after choosing is the one they were going to
   * any way.
   */
  const pickedThen = (assets: CapturedAsset[]) => {
    if (assets.length === 0) return;
    setCapture(null);
    setPicked(assets);
    setPage('compose');
  };

  if (!visible) return null;

  return (
    <View style={styles.root}>
      {page === 'camera' && CAMERA_V2 && (
        <GenzCamera
          visible
          onClose={onClose}
          onCaptured={captureThen}
          onAddSound={() => setSoundOpen(true)}
          soundName={sound?.name ?? null}
          onPickedMedia={pickedThen}
          onTextMode={() => {
            setSheet(false);
            setPage('text');
          }}
          overlay={
            sheet ? (
              <LaunchSheet
                hasDraft={hasDraft}
                onChoose={choose}
                onDismiss={() => setSheet(false)}
              />
            ) : null
          }
        />
      )}
      {page === 'camera' && !CAMERA_V2 && (
        <CaptureScreen
          // The camera STAYS MOUNTED under the sound sheet and comes back to
          // the same page. It used to be hidden here (`visible={!soundOpen}`),
          // which tore the sensor session down and rebuilt it on every add-sound
          // trip — the preview came back black often enough to look broken.
          // Adding a sound is something you do *to* the camera, not a way to
          // leave it, and the sheet is its own Modal above everything.
          visible
          onClose={onClose}
          onCaptured={captureThen}
          onAddSound={() => setSoundOpen(true)}
          soundName={sound?.name ?? null}
          sound={sound}
          onPickedMedia={pickedThen}
          onTextMode={() => {
            setSheet(false);
            setPage('text');
          }}
          overlay={
            sheet ? (
              <LaunchSheet
                hasDraft={hasDraft}
                onChoose={choose}
                onDismiss={() => setSheet(false)}
              />
            ) : null
          }
        />
      )}

      {page === 'text' && (
        <TextImagePage
          onBack={back}
          onNext={(t, bg) => {
            setText(t);
            setTextBg(bg);
            setPage('compose');
          }}
        />
      )}

      {page === 'compose' && (
        <CreateDropScreen
          // Landing on the compose step, never the old hub: the launcher is the
          // hub now, and it already knows what the user came for.
          initialStep="create"
          initialCapture={capture}
          initialAssets={picked}
          initialText={text}
          initialTextBg={textBg}
          resumeDraft={resume}
          // a sound picked on the camera travels with the clip into the composer
          initialSoundPicked={sound}
          initialSound={intent?.sound ?? null}
          initialMediaUri={intent?.mediaUri ?? null}
          replyToDropId={intent?.replyTo ?? null}
          onExit={() => setPage('camera')}
          onPosted={onPosted}
        />
      )}

      {/* The sound sheet, at the flow root rather than inside the camera.
          Which page it was opened from does not matter: the answer to a sound
          is always the camera with that sound on it. */}
      <SoundPickerModal
        visible={soundOpen}
        initial={sound}
        onClose={() => setSoundOpen(false)}
        onSelect={(s) => {
          setSound(s);
          setSoundOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // above Explore (60) and the anon overlay (50), and above UploadBar so an
    // in-flight upload's progress pill cannot float over the viewfinder.
    //
    // Deliberately NO `elevation` here. An elevated, opaque ancestor can be
    // composited above a child SurfaceView on Android, which is a way to make a
    // working camera preview look black. zIndex orders the siblings, which is
    // all this overlay needs.
    zIndex: 90,
    backgroundColor: colors.bg,
  },
});

