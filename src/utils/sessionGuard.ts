import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase/client';
import { isNetworkError } from './friendlyError';

/**
 * sessionGuard — keeps a signed-in user signed in.
 *
 * The rule this enforces: once you are logged in, you STAY logged in until you
 * log out or delete your account. Nothing transient may send you back to the
 * welcome screen.
 *
 * The Supabase SDK does not guarantee that by itself. `_removeSession()` deletes
 * the stored session and emits SIGNED_OUT, and it has five separate triggers
 * (GoTrueClient.js L2447 `__loadSession`, L2642 `_getUser`, L3350 `_signOut`,
 * L3997 `_recoverAndRefresh`, L4175 `_callRefreshToken`). Removing the triggers
 * we can see is necessary but not sufficient: L3997 and L4175 both fire on a
 * server verdict, which we cannot control from the client.
 *
 * So we keep a small mirror of the current tokens and, when a sign-out arrives
 * that the user did NOT ask for, we try once to put the session back.
 *
 * A deliberate "Sign out" clears the mirror FIRST, so a user who logged out can
 * never be resurrected.
 *
 * The mirror lives in AsyncStorage — the same medium the SDK already stores the
 * session in — so this adds no new exposure.
 */

const MIRROR = 'genz_session_mirror';

type Tokens = { access_token?: string | null; refresh_token?: string | null };

/**
 * Synchronous "the user meant this" flag. Kept in memory so the sign-out handler
 * can branch on it on the same tick, with no await and no visible flash of the
 * welcome screen before we know whether the sign-out was intentional.
 */
let deliberate = false;

/** True when this app run has already tried — and failed — to restore a session. */
let restoreAttempted = false;

/**
 * Call immediately BEFORE any user-initiated sign-out. Drops the mirror so the
 * session cannot be revived, and marks the sign-out as intended.
 */
export function markDeliberateSignOut(): void {
  deliberate = true;
  AsyncStorage.removeItem(MIRROR).catch(() => {});
}

/** Whether the pending sign-out was requested by the user. Synchronous. */
export function isDeliberateSignOut(): boolean {
  return deliberate;
}

/**
 * Called after a sign-in so a later deliberate logout behaves normally — and to
 * RE-ARM the rescue.
 *
 * `restoreAttempted` used to latch on the first attempt and never clear, which
 * made the whole guard one-shot per app run: the first spontaneous sign-out was
 * rescued, and every later one in the same run dropped straight to the welcome
 * screen without even reading the mirror. A guard that saves you exactly once is
 * not the guarantee we promised the user. Cleared here because this runs on every
 * confirmed live session, so a successful rescue re-arms it.
 *
 * No loop risk: a FAILED restore deletes the mirror, so there is nothing left to
 * retry against.
 */
export function resetSignOutFlags(): void {
  deliberate = false;
  restoreAttempted = false;
}

/**
 * Record the current tokens. Fire-and-forget, and deliberately NOT async: it is
 * called from inside onAuthStateChange, where awaiting another SDK call can
 * deadlock on the auth lock.
 */
export function mirrorSession(session: Tokens | null | undefined): void {
  if (!session?.access_token || !session.refresh_token) return;
  AsyncStorage.setItem(
    MIRROR,
    JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    })
  ).catch(() => {});
}

/**
 * Try once to put back a session the user did not end.
 *
 * Returns true when a session was restored (the normal auth flow then drives the
 * UI back to the app). Returns false when there was nothing to restore or the
 * server rejected the tokens — in which case the caller should show the welcome
 * screen, because the credential really is gone.
 */
export async function restoreUnexpectedSignOut(): Promise<boolean> {
  if (restoreAttempted) return false;
  restoreAttempted = true;

  const raw = await AsyncStorage.getItem(MIRROR).catch(() => null);
  if (!raw) return false;

  try {
    const { access_token, refresh_token } = JSON.parse(raw) as Tokens;
    if (!access_token || !refresh_token) {
      await AsyncStorage.removeItem(MIRROR).catch(() => {});
      return false;
    }

    const { error } = await supabase.auth.setSession({ access_token, refresh_token });

    if (error) {
      // ---------------------------------------------------------------
      // "We could not reach the server" is NOT "the server said no".
      //
      // This branch used to delete the mirror on ANY error, which conflated the
      // two — and that made a bad situation permanently bad. The sequence: the
      // app is briefly offline, the SDK deletes the stored session, we try to
      // restore, and the restore ALSO fails because we are still offline. The
      // mirror was then destroyed, taking with it the user's only remaining
      // credential. When the connection came back there was nothing left to
      // restore, so the welcome screen became permanent until they logged in
      // again from scratch — which is exactly the "randomly takes me back and
      // won't let me back in" report.
      //
      // So: a connectivity failure keeps the mirror AND stays armed, so a later
      // launch, a later sign-out event, or the foreground retry in App.tsx can
      // still use it. Only a verdict from the server — invalid/expired refresh
      // token — means the credential is genuinely dead.
      // ---------------------------------------------------------------
      if (isNetworkError(error)) {
        restoreAttempted = false;
        return false;
      }

      await AsyncStorage.removeItem(MIRROR).catch(() => {});
      return false;
    }

    deliberate = false;
    restoreAttempted = false;
    return true;
  } catch (e) {
    // Same reasoning as above: a thrown fetch failure is a connectivity problem,
    // not a rejection. Never discard the credential over one.
    if (isNetworkError(e)) {
      restoreAttempted = false;
      return false;
    }
    await AsyncStorage.removeItem(MIRROR).catch(() => {});
    return false;
  }
}
