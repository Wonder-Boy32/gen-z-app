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
import CreateDropScreen from '../screens/CreateDropScreen';
import { colors } from '../theme';
import { useAndroidBack } from '../utils/useAndroidBack';
import LaunchSheet from './LaunchSheet';
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
  const [text, setText] = useState<string | null>(null);
  // which sheet the composer should open on arrival, if any
  const [openOnMount, setOpenOnMount] = useState<'gallery' | 'sound' | null>(null);
  // "Continue your draft"
  const [resume, setResume] = useState(false);

  const hasIntent = !!(intent?.sound || intent?.replyTo || intent?.mediaUri);

  /**
   * Every open starts from the same place. An intent from elsewhere in the app
   * (a sound page, a Drop reply, a shared file) is the one thing that skips the
   * camera, because the user has already said what they want.
   */
  useEffect(() => {
    if (!visible) return;
    setCapture(null);
    setText(null);
    setOpenOnMount(null);
    setResume(false);
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
    setText(null);
    setOpenOnMount(null);
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
    setPage('compose');
  };

  const composeWith = (what: 'gallery' | 'sound') => {
    setOpenOnMount(what);
    setPage('compose');
  };

  if (!visible) return null;

  return (
    <View style={styles.root}>
      {page === 'camera' && (
        <CaptureScreen
          visible
          onClose={onClose}
          onCaptured={captureThen}
          onAddSound={() => composeWith('sound')}
          soundName={null}
          onOpenGallery={() => composeWith('gallery')}
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
          onNext={(t) => {
            setText(t);
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
          initialText={text}
          openOnMount={openOnMount}
          resumeDraft={resume}
          initialSound={intent?.sound ?? null}
          initialMediaUri={intent?.mediaUri ?? null}
          replyToDropId={intent?.replyTo ?? null}
          onExit={() => setPage('camera')}
          onPosted={onPosted}
        />
      )}
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
    // in-flight upload's progress pill cannot float over the viewfinder
    zIndex: 90,
    backgroundColor: colors.bg,
  },
});
