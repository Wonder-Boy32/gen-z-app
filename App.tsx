import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, NativeModules, Platform, StyleSheet, UIManager, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { Session } from '@supabase/supabase-js';
import { supabase } from './src/supabase/client';
import WelcomeScreen from './src/screens/WelcomeScreen';
import AuthScreen from './src/screens/AuthScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import HomeScreen from './src/screens/HomeScreen';
import { colors } from './src/theme';
import { initPush, onNotificationTap, clearBadge } from './src/utils/push';

// usernames auto-generated at signup look like "prefix-1a2b3c" — until the user
// picks their own in onboarding, we show onboarding.
const TEMP_USERNAME = /^[a-z0-9._-]+-[0-9a-f]{6}$/;

// Old dev-client builds don't ship the RNCSafeAreaProvider native view
// manager — using it there crashes with "Can't find ViewManager
// 'RNCSafeAreaProvider'". Fall back to plain rendering (insets = 0) until
// the APK is rebuilt with react-native-safe-area-context included.
function hasSafeAreaNative(): boolean {
  // Expo Go always bundles react-native-safe-area-context, but on the new
  // architecture its view manager is not visible via NativeModules — check
  // the runtime environment first.
  if (Constants?.executionEnvironment === 'storeClient') return true;
  try {
    return !!(NativeModules?.RNCSafeAreaProvider || UIManager?.getViewManagerConfig?.('RNCSafeAreaProvider'));
  } catch {
    return false;
  }
}

const HAS_SAFE_AREA = hasSafeAreaNative();

export default function App() {
  return HAS_SAFE_AREA ? (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  ) : (
    <AppInner />
  );
}

function AppInner() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ username: string; avatar_url: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  // logged-out entry: Instagram-style welcome first → Explore goes to signup
  const [authView, setAuthView] = useState<'welcome' | 'login' | 'signup'>('welcome');

  const fetchProfile = useCallback(async (uid: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('username, avatar_url')
      .eq('id', uid)
      .maybeSingle();
    setProfile((data as { username: string; avatar_url: string | null } | null) ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { session: s },
      } = await supabase.auth.getSession();
      setSession(s);
      if (s) await fetchProfile(s.user.id);
      setLoading(false);
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) fetchProfile(s.user.id);
      else {
        setProfile(null);
        setAuthView('welcome'); // logged-out users always land on the welcome page
      }
    });
    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  // online status heartbeat — update last_seen_at while the app is open
  useEffect(() => {
    const touch = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', user.id);
      }
    };
    touch();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') touch();
    });
    const interval = setInterval(touch, 60000);
    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  // session heartbeat → "Where you're logged in" + new-login security alerts
  useEffect(() => {
    const note = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      try {
        const dev = `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} · ${Platform.OS}`;
        const key = await AsyncStorage.getItem('genz_session_key').catch(() => null);
        const sk = key ?? `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        if (!key) AsyncStorage.setItem('genz_session_key', sk).catch(() => {});
        await supabase.rpc('security_note_session', {
          p_device: dev,
          p_app: 'Gen Z',
          p_session_key: sk,
        });
      } catch {}
    };
    note();
  }, [session?.user?.id]);

  // ---- real notifications: permission, device token, tap routing ----
  // Bumping this asks HomeScreen -> FeedScreen to surface the Activity screen
  // when someone taps a notification in the phone's notification bar.
  const [activitySignal, setActivitySignal] = useState(0);

  useEffect(() => {
    if (!session?.user?.id) return;
    // asks permission, creates the Android channels and registers this device.
    // A no-op on a native build that predates expo-notifications.
    void initPush();
    return onNotificationTap(() => setActivitySignal((n) => n + 1));
  }, [session?.user?.id]);

  // signed out: this phone should not keep a badge from the last account
  useEffect(() => {
    if (session) return;
    void clearBadge();
  }, [session]);

  const needsOnboarding = !!session && !!profile && TEMP_USERNAME.test(profile.username);

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!session) {
    if (authView === 'welcome') {
      return (
        <WelcomeScreen
          onExplore={() => setAuthView('signup')}
          onLogin={() => setAuthView('login')}
        />
      );
    }
    return <AuthScreen key={authView} initialMode={authView === 'signup' ? 'signup' : 'login'} />;
  }

  if (needsOnboarding) {
    return <OnboardingScreen onDone={() => session && fetchProfile(session.user.id)} />;
  }

  return <HomeScreen openActivitySignal={activitySignal} />;
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
