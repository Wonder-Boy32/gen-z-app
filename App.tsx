import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Session } from '@supabase/supabase-js';
import { supabase } from './src/supabase/client';
import AuthScreen from './src/screens/AuthScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import HomeScreen from './src/screens/HomeScreen';
import { colors } from './src/theme';

// usernames auto-generated at signup look like "prefix-1a2b3c" — until the user
// picks their own in onboarding, we show onboarding.
const TEMP_USERNAME = /^[a-z0-9._-]+-[0-9a-f]{6}$/;

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ username: string; avatar_url: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

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
      else setProfile(null);
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

  const needsOnboarding = !!session && !!profile && TEMP_USERNAME.test(profile.username);

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!session) return <AuthScreen />;

  if (needsOnboarding) {
    return <OnboardingScreen onDone={() => session && fetchProfile(session.user.id)} />;
  }

  return <HomeScreen />;
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
