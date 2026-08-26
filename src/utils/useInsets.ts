import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Real Android status-bar height (edge-to-edge safe), used by headers that
// historically hardcoded ~50px. iOS returns the 20/44pt conventions.
export const TOP_INSET: number =
  Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 20;

// Safe accessor: returns real insets when SafeAreaProvider is mounted
// (Expo Go / rebuilt APK), and zeros when the native module is missing
// (old dev-client APKs) instead of throwing.
export function useInsets(): { top: number; bottom: number; left: number; right: number } {
  try {
    return useSafeAreaInsets();
  } catch {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
}
