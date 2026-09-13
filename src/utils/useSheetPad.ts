// ============================================================
// useSheetPad — the bottom padding a sheet must use so the Android keyboard
// never covers its contents.
//
// WHY THIS EXISTS: this defect was found and fixed by hand five times
// (CommentsModal, CreateDropScreen create + preview, SoundPickerModal, and the
// whole app at once here). Each time the cause was identical:
//
//   On Android a react-native <Modal> is its OWN window. It does not resize for
//   the IME, so the keyboard simply overlays the sheet and the input underneath
//   disappears. Nothing corrects it for you: app.json has no
//   softwareKeyboardLayoutMode and there is no react-native-keyboard-controller
//   in this project.
//
// The related trap, also fixed everywhere now:
//   behavior={Platform.OS === 'ios' ? 'padding' : undefined}
//   RN 0.86's KeyboardAvoidingView has no defaultProps, so `undefined` falls
//   through to its `default:` branch and renders a plain View. It even listens to
//   keyboardDidShow and then throws the measurement away. It does nothing.
//
// USAGE — pass the sheet's existing resting padding so nothing changes while the
// keyboard is closed (zero visual regression), then use the return value:
//
//   const sheetPad = useSheetPad(30);
//   <View style={[styles.sheet, { paddingBottom: sheetPad }]}>
//
// If the sheet adds safe-area insets itself, pass that expression through
// unchanged, e.g. useSheetPad(16 + insets.bottom).
//
// One mechanism per platform: listeners are attached on Android only, so iOS
// behaviour is untouched.
// ============================================================

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useSheetPad(restingPad: number): number {
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKbHeight(e?.endCoordinates?.height ?? 0)
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // With the IME open the nav bar sits behind it, so the full reported height is
  // the distance the sheet has to clear. Closed: exactly what the sheet used before.
  return Platform.OS === 'android' && kbHeight > 0 ? kbHeight : restingPad;
}
