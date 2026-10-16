import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Session } from '@supabase/supabase-js';
import { supabase } from './src/supabase/client';
import WelcomeScreen from './src/screens/WelcomeScreen';
import AuthScreen from './src/screens/AuthScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import HomeScreen from './src/screens/HomeScreen';
import { colors, subscribeTheme } from './src/theme';
import { initPush, onNotificationTap, clearBadge, deviceLabel } from './src/utils/push';
import { reportSignin } from './src/utils/signinAlert';
import { primeCache, peek, put, drop, cacheKey } from './src/utils/fastCache';
import {
  mirrorSession,
  isDeliberateSignOut,
  resetSignOutFlags,
  restoreUnexpectedSignOut,
} from './src/utils/sessionGuard';

/** The slice of the profile row the shell needs to pick a screen. */
type Profile = { username: string; avatar_url: string | null };

// usernames auto-generated at signup look like "prefix-1a2b3c" — until the user
// picks their own in onboarding, we show onboarding.
const TEMP_USERNAME = /^[a-z0-9._-]+-[0-9a-f]{6}$/;

// The SafeAreaProvider is mounted UNCONDITIONALLY.
//
// It used to sit behind a hasSafeAreaNative() probe of
// NativeModules.RNCSafeAreaProvider / UIManager.getViewManagerConfig — and that
// probe is a FALSE NEGATIVE under the new architecture (newArchEnabled: true),
// where the Fabric view manager is not reachable that way. So on a real build
// the provider was never mounted, every useSafeAreaInsets() call threw, and our
// own useInsets() swallowed the throw and handed back { top: 0, bottom: 0 }.
//
// The consequence was app-wide and invisible: no screen had a real top inset
// (which is why headers had drifted into hardcoded 18-20px values), and the tab
// bar had no bottom inset to clear the gesture bar.
//
// The guard was there to protect obsolete dev-client APKs that did not bundle
// the native view at all. Every build we ship now includes it —
// react-native-safe-area-context is a dependency — and Expo Go always has it,
// so the guard protects nothing and costs every layout its insets.
//
// initialMetrics seeds the provider from metrics captured natively at launch, so
// children get correct insets on the FIRST frame instead of rendering once at
// zero and then jumping.
export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [session, setSession] = useState<Session | null>(null);

  // Re-render the whole app when the theme palette changes.
  //
  // A counter rather than the mode itself: the value is never READ, only
  // changed, so the state slot is destructured as a hole. That keeps the
  // unused-variable rule satisfied while still forcing React to re-render this
  // component — and with it the entire non-memoised subtree, which re-reads
  // `colors.*` and the rewritten style containers as it re-renders.
  //
  // Deliberately NOT a remount via key={mode}: remounting AppInner would restart
  // its session bootstrap, and a null session renders the welcome screen on that
  // first pass — the exact "it keeps taking me back to that screen" flash this
  // app has already been fixed for once. A re-render refreshes colours and
  // leaves the session untouched.
  const [, forceThemeRender] = useState(0);
  useEffect(() => subscribeTheme(() => forceThemeRender((n) => n + 1)), []);

  const [profile, setProfile] = useState<{ username: string; avatar_url: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  // logged-out entry: Instagram-style welcome first → Explore goes to signup
  const [authView, setAuthView] = useState<'welcome' | 'login' | 'signup'>('welcome');

  // The uid this shell has ALREADY put on screen. Supabase re-announces the
  // session it just reloaded from storage as a SIGNED_IN event, so the event
  // name alone cannot tell "the user just signed in" apart from "we recovered
  // the session we already had". This ref is what makes that distinction.
  const shownUidRef = useRef<string | null>(null);

  // The last auth event that was NOT a sign-out, so a spontaneous sign-out can
  // report what it arrived after (a failed refresh, for instance).
  const lastAuthEventRef = useRef<string>('none');

  const fetchProfile = useCallback(async (uid: string) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', uid)
        .maybeSingle();

      const p = (data as Profile | null) ?? null;
      setProfile(p);

      // Cached PER USER ID. A shared device must never show one account's
      // username to another, so the uid is part of the key rather than the cache
      // being a single global slot.
      if (p) void put(cacheKey.profile(uid), p);
      else void drop(cacheKey.profile(uid));
    } catch {
      // A dropped connection must not become an unhandled rejection, and it must
      // never leave the caller's loading gate stuck open.
    }
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { session: s },
      } = await supabase.auth.getSession();
      setSession(s);
      mirrorSession(s);

      if (!s) {
        // Nothing in storage — but that is NOT proof the user is logged out.
        //
        // The SDK's destructive paths (_getUser / _recoverAndRefresh /
        // _callRefreshToken) DELETE the persisted session when a network check
        // fails. If that happened on a previous run and the app was then closed,
        // the user comes back to a welcome screen they never asked for, even
        // though the mirror still holds tokens the server would accept.
        //
        // So before declaring anyone logged out, make ONE attempt to put the
        // session back. A user who genuinely logged out cannot land here: a
        // deliberate sign-out erases the mirror first, so there is nothing to
        // restore and this returns immediately.
        //
        // On success setSession() emits SIGNED_IN and the handler below drives the
        // UI; we stay on the loader rather than flashing the welcome screen.
        const rescued = await restoreUnexpectedSignOut();
        if (rescued) return;

        setLoading(false);
        return;
      }

      // Cold start for an already signed-in user: this uid is the identity on
      // screen from here on, so a later recovery event for the same uid counts
      // as housekeeping rather than a fresh sign-in.
      shownUidRef.current = s.user.id;

      // Hydrate BEFORE making the gate decision.
      //
      // primeCache() awaits one small AsyncStorage read; peek() is then
      // synchronous. With a cache hit we render Home on the first frame with no
      // spinner, and — because the feed list exists immediately — the first
      // video starts buffering at frame one instead of after a round-trip.
      await primeCache([cacheKey.profile(s.user.id)]);
      const cachedProfile = peek<Profile>(cacheKey.profile(s.user.id));
      if (cachedProfile) setProfile(cachedProfile);

      // Refresh behind the user. Never block on it when we already have data.
      void fetchProfile(s.user.id);
      setLoading(!cachedProfile);
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      // Leave a trace BEFORE anything else. A spontaneous sign-out used to be
      // completely invisible — no log, no message — which is why this bug was so
      // hard to pin down. The note is flushed to the security log on the next
      // signed-in mount, where it appears in the in-app security activity list.
      if (_event === 'SIGNED_OUT') {
        void AsyncStorage.setItem(
          'genz_last_signout',
          JSON.stringify({
            at: new Date().toISOString(),
            app_state: AppState.currentState,
            after: lastAuthEventRef.current,
          })
        ).catch(() => {});
      } else {
        lastAuthEventRef.current = _event;
      }

      // Keep the recovery mirror on the token that is actually in use — refresh
      // tokens rotate, and a stale mirror cannot be restored.
      mirrorSession(s);

      setSession(s);

      if (!s) {
        shownUidRef.current = null;
        setProfile(null);

        // A sign-out the user did not ask for must not end the session. Hold the
        // UI and try to put it back rather than dropping to the welcome screen.
        // The restore runs on a later tick on purpose: calling back into the SDK
        // from inside onAuthStateChange can deadlock on the auth lock, which is
        // why it is deferred with setTimeout(0) instead of awaited here.
        if (_event === 'SIGNED_OUT' && !isDeliberateSignOut()) {
          setLoading(true);
          setTimeout(() => {
            void (async () => {
              const restored = await restoreUnexpectedSignOut();
              // On success setSession() emits SIGNED_IN and the normal flow
              // returns the user to the app; only a failed restore shows welcome.
              if (!restored) {
                setAuthView('welcome');
                setLoading(false);
              }
            })();
          }, 0);
          return;
        }

        setAuthView('welcome'); // logged-out users always land on the welcome page
        setLoading(false);
        return;
      }

      // A live session: forget any previous deliberate-logout marker.
      resetSignOutFlags();

      // Only a CHANGE OF IDENTITY may take over the screen.
      //
      // The gate exists for one reason: setSession() is synchronous but
      // fetchProfile() is not awaited, so without it the order is
      //     setSession(s)            -> session becomes non-null immediately
      //     <HomeScreen />  mounts   -> with profile === null
      //     fetchProfile resolves    -> tree re-renders, and because
      //                                 needsOnboarding requires !!profile it
      //                                 may even swap to <OnboardingScreen />
      // and the user watches the home page load TWICE.
      //
      // But the gate must never be opened by an event that is not a sign-in.
      // supabase-js emits SIGNED_IN from _recoverAndRefresh() every time it
      // reloads the persisted session — so on a cold start (or any restart of
      // a backgrounded app) the old `_event === 'SIGNED_IN'` test fired for a
      // user who was ALREADY signed in, blanked the entire app to the loader,
      // and then had to wait on a network round-trip to come back. Because
      // colors.bg and the splash background are both #060A16, that loader is
      // indistinguishable from the splash screen — the "it keeps throwing me
      // back to the splash screen" report.
      //
      // So: a genuine sign-in is a uid we are not already showing. Recovery,
      // TOKEN_REFRESHED and USER_UPDATED are housekeeping — refresh the profile
      // in the background and leave the UI alone.
      const isNewIdentity = shownUidRef.current !== s.user.id;

      if (_event === 'SIGNED_IN' && isNewIdentity) {
        shownUidRef.current = s.user.id;
        setLoading(true);
        // Tell the account's other devices that this sign-in happened, with the
        // device name and where it came from. Fired here and nowhere else: this
        // branch already excludes recovery, TOKEN_REFRESHED, USER_UPDATED and
        // cold starts, which are exactly the events that must never produce a
        // "new sign-in" warning. Deliberately not awaited — a security notice
        // must not delay the user getting into their own app.
        void reportSignin();
        void fetchProfile(s.user.id).finally(() => setLoading(false));
        return;
      }

      // Cold start (INITIAL_SESSION) is already covered by getSession() above.
      // One extra profile read is cheaper than racing two of them.
      void fetchProfile(s.user.id);
    });
    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  // Watchdog: no loading gate may outlive this window.
  //
  // fetchProfile() issues a network request with no timeout of its own, so a
  // stalled connection used to hold `loading` true forever — a full-screen
  // splash-coloured view that never resolved, which is the other half of the
  // "it just sits on the splash screen" symptom. Whatever we have after this
  // long is what the user sees.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(t);
  }, [loading]);

  // online status heartbeat — update last_seen_at while the app is open
  //
  // This used to resolve the user with supabase.auth.getUser(). getUser() is NOT
  // a harmless read: it is an authoritative session check, and the SDK calls
  // _removeSession() — deleting the stored session and emitting SIGNED_OUT, i.e.
  // straight back to the welcome screen — when the server reports the session is
  // no longer active, or when the token it reads comes back empty
  // (GoTrueClient.js L2639-2642). Running that on a 60-second timer is why the
  // app threw the user out "after a moment, without pressing anything": any
  // transient hiccup became a forced logout. The uid is already in state, so ask
  // the SDK nothing.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return; // signed out — nothing to heartbeat

    const touch = async () => {
      try {
        await supabase
          .from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', uid);
      } catch {}
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
  }, [session?.user?.id]);

  // Foreground / reconnect rescue.
  //
  // The last gap in "once you're logged in, you stay logged in". Sequence: the
  // app is briefly offline, the SDK deletes the stored session, our rescue also
  // fails because we are STILL offline. Previously the only things that could
  // put the session back were a restart or a fresh SIGNED_OUT event — so someone
  // who simply waited and reconnected sat on the welcome screen holding a
  // perfectly good credential in the mirror.
  //
  // So while there is no session: try on mount, try whenever the app returns to
  // the foreground, and try on a slow timer for the case where the user never
  // backgrounds it. All three are cheap — with no mirror this is one AsyncStorage
  // read and an early return — and none of them can resurrect a real logout,
  // because a deliberate sign-out erases the mirror first.
  //
  // The effect re-runs the moment `session` becomes non-null, which tears all of
  // this down.
  useEffect(() => {
    if (session) return;
    let stopped = false;

    const tryRescue = async () => {
      if (stopped) return;
      const restored = await restoreUnexpectedSignOut().catch(() => false);
      // On success setSession() emits SIGNED_IN and the handler above drives the
      // UI; holding the loader avoids a flash of the welcome screen.
      if (!stopped && restored) setLoading(true);
    };

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void tryRescue();
    });
    const interval = setInterval(() => {
      void tryRescue();
    }, 20000);
    void tryRescue();

    return () => {
      stopped = true;
      sub.remove();
      clearInterval(interval);
    };
  }, [session]);

  // session heartbeat → "Where you're logged in" + new-login security alerts
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return; // same reasoning as above: never getUser() on a heartbeat

    const note = async () => {
      try {
        // Real device name rather than the old "Android · android", which told
        // the user nothing when they were checking "Where you're logged in".
        const dev = deviceLabel();
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

  // Report a recorded spontaneous sign-out once we have a session again.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;

    (async () => {
      try {
        const raw = await AsyncStorage.getItem('genz_last_signout').catch(() => null);
        if (!raw) return;
        await AsyncStorage.removeItem('genz_last_signout').catch(() => {});
        await supabase.rpc('security_log', {
          p_event: 'client_session_ended',
          p_meta: JSON.parse(raw),
        });
      } catch {}
    })();
  }, [session?.user?.id]);

  // Supabase's documented React Native requirement: the token refresh ticker must
  // be stopped while the app is backgrounded and restarted on resume. auth-js
  // does NOT wire this for you — its AppState snippet exists only as a doc
  // comment (GoTrueClient.js L4397/L4431) — so the ticker otherwise runs on a
  // frozen timer and the app can return holding a token nobody refreshed.
  useEffect(() => {
    const sync = (state: string) => {
      if (state === 'active') void supabase.auth.startAutoRefresh();
      else void supabase.auth.stopAutoRefresh();
    };
    sync(AppState.currentState);
    const sub = AppState.addEventListener('change', sync);
    return () => {
      sub.remove();
      void supabase.auth.stopAutoRefresh();
    };
  }, []);

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
