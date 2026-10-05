// ============================================================
// src/utils/useAndroidBack.ts
// ============================================================
// Route the Android hardware/gesture back control into IN-APP navigation.
//
// THE BUG THIS FIXES
// The whole app had no BackHandler registered anywhere (a repo-wide search for
// "BackHandler" returned nothing). With no listener, Android applies its
// default for the back control: finish the current ACTIVITY. So from any
// in-app screen — a chat thread, the anonymous inbox, a profile — pressing
// back dropped the user straight out to the phone's launcher instead of going
// up one level. That is exactly the reported behaviour.
//
// HOW BACK RESOLUTION WORKS
// BackHandler invokes listeners in REVERSE registration order, newest first.
// So a screen that mounted later (a chat thread) gets the press before the
// screen that mounted earlier (the tab host). Returning TRUE consumes the
// press; returning FALSE lets the next listener try. Only when every listener
// declines does Android close the app — which is the behaviour we want at the
// root, and only at the root.
//
// Modals are deliberately NOT handled here: React Native's own <Modal> already
// wires onRequestClose to the back control, so adding a handler would double up.
//
// USAGE
//   useAndroidBack(() => { if (open) { close(); return true; } return false; });
//
//   `enabled` exists so a screen can stand down while it is not the thing on
//   screen without the caller having to conditionally call the hook (which
//   would break the rules of hooks).

import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

export function useAndroidBack(handler: () => boolean, enabled: boolean = true): void {
  // Held in a ref so the caller does NOT have to memoise `handler`. Re-subscribing
  // on every render would work but churns listeners, and an unstable handler is
  // an easy mistake to make at a call site.
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });

  useEffect(() => {
    if (Platform.OS !== 'android' || !enabled) return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => ref.current());
    return () => sub.remove();
  }, [enabled]);
}
