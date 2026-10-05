/**
 * friendlyError — turns machine errors into sentences a person can act on.
 *
 * THE PROBLEM
 *
 * A user with no connection saw this on the login screen:
 *
 *     fetch failed: java.net.UnknownHostException: Unable to resolve host
 *     "fwouxamnmfdzwxpefoyb.supabase.co": No address associated with hostname
 *     You have 4 attempts remaining.
 *
 * That is a Java stack trace wearing a login form. It tells the user nothing they
 * can use, and the one true thing about it — "you are offline" — is the one thing
 * it does not say. Worse, it reads like the account is broken.
 *
 * WHY IT WAS EVERYWHERE
 *
 * The app surfaces errors as `setError(err.message)`, and there are roughly 200
 * such call sites across 21 files. Fixing them one at a time would be slow, would
 * miss some, and would decay — the next `setError(err.message)` anyone writes
 * would reintroduce the raw text.
 *
 * So the fix is at the SOURCE instead: installNetworkErrorTranslator() wraps the
 * global fetch, and any network failure comes back as an Error whose message is
 * already human. Every existing call site — and every future one — inherits it
 * without being touched, because `err.message` is now friendly by construction.
 * Same technique as the write guard and the getUser patch in supabase/client.ts.
 *
 * friendlyError() covers the second class: errors that are NOT network failures
 * and therefore never pass through fetch — Supabase auth verdicts like "Invalid
 * login credentials", rate limits, and RLS refusals. Those are mapped explicitly
 * at the handful of screens that show them.
 *
 * The real error is always logged, never swallowed. A friendly message on screen
 * must not mean a silent failure in the console.
 */

export const OFFLINE_MESSAGE =
  'No internet connection. Please check your connection and try again.';

/**
 * Signatures of a network-layer failure, lower-cased.
 *
 * Deliberately broad and matched as substrings: RN, iOS, Android, Hermes and
 * various proxies each phrase this differently, and the cost of over-matching is
 * only that an unknown error reads as a connection problem — which is a far
 * better failure than leaking a stack trace.
 */
const NETWORK_SIGNATURES = [
  // Our OWN offline message is in this list on purpose. The fetch translator below
  // replaces network failures with OFFLINE_MESSAGE, so by the time an error reaches
  // a caller its text may be ours rather than the platform's — and code that asks
  // "was this a network failure?" (the session guard does exactly that) must still
  // answer yes. Without these two entries the translator would hide the very signal
  // it created.
  'no internet connection',
  'check your connection',
  'unknownhostexception',
  'unable to resolve host',
  'no address associated with hostname',
  'network request failed',
  'fetch failed',
  'failed to fetch',
  'network error',
  'socketexception',
  'connection reset',
  'connection refused',
  'connectexception',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'network is unreachable',
  'unable to connect',
  'could not connect',
  'timed out',
  'timeout',
  'ssl',
  'certificate',
];

/** Supabase auth / PostgREST verdicts, matched on a lower-cased message. */
const MESSAGE_MAP: { match: string; say: string }[] = [
  // --- sign-in ---
  { match: 'invalid login credentials', say: 'Incorrect email or password. Please try again.' },
  { match: 'invalid credentials', say: 'Incorrect email or password. Please try again.' },
  { match: 'email not confirmed', say: 'Confirm your email first — check your inbox for the code, then try again.' },
  { match: 'user already registered', say: 'An account with this email already exists. Try logging in instead.' },
  { match: 'user already exists', say: 'An account with this email already exists. Try logging in instead.' },
  { match: 'email address not authorized', say: "We can't send to that address. Please try a different email." },
  { match: 'signup requires a valid password', say: 'Please choose a stronger password and try again.' },

  // --- password rules ---
  { match: 'password should be at least', say: 'Your password is too short. Use at least 6 characters.' },
  { match: 'password is too short', say: 'Your password is too short. Use at least 6 characters.' },
  { match: 'weak password', say: 'That password is too easy to guess. Please choose another.' },

  // --- tokens, codes, links ---
  { match: 'token has expired', say: 'That code has expired. Request a new one and try again.' },
  { match: 'invalid token', say: 'That code is not valid. Check it and try again.' },
  { match: 'otp_expired', say: 'That code has expired. Request a new one and try again.' },
  { match: 'token is invalid', say: 'That code is not valid. Check it and try again.' },

  // --- session ---
  { match: 'jwt expired', say: 'Your session expired. Please log in again.' },
  { match: 'refresh token', say: 'Your session expired. Please log in again.' },
  { match: 'session missing', say: 'Your session expired. Please log in again.' },

  // --- throttling ---
  { match: 'for security purposes', say: 'Too many attempts. Please wait a moment and try again.' },
  { match: 'rate limit', say: 'Too many attempts. Please wait a moment and try again.' },
  { match: 'too many requests', say: 'Too many attempts. Please wait a moment and try again.' },
  { match: 'email rate limit exceeded', say: 'Too many emails requested. Please wait a few minutes.' },

  // --- permissions / data ---
  { match: 'row-level security', say: "You don't have permission to do that." },
  { match: 'permission denied', say: "You don't have permission to do that." },
  { match: 'violates foreign key', say: 'That item no longer exists — please refresh and try again.' },
  { match: 'duplicate key', say: 'That already exists — try a different one.' },
  { match: 'does not exist', say: 'That is no longer available — please refresh and try again.' },
  { match: 'string too long', say: 'That is too long. Please shorten it and try again.' },
  { match: 'payload too large', say: 'That file is too large. Please choose a smaller one.' },
  { match: 'invalid input syntax', say: 'Something in that form was not valid. Please check it and try again.' },
];

const FALLBACK = 'Something went wrong. Please try again.';

/** Best-effort extraction of a message from anything throwable. */
function messageOf(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/** True when this looks like a connectivity problem rather than a server verdict. */
export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = messageOf(err).toLowerCase();
  if (msg && NETWORK_SIGNATURES.some((s) => msg.includes(s))) return true;

  // A thrown non-Error whose own NAME is the only clue (some RN paths do this).
  const name = typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '';
  if (name) {
    const n = name.toLowerCase();
    if (n === 'aborterror') return false; // a deliberate cancel is not a failure
    if (NETWORK_SIGNATURES.some((s) => n.includes(s))) return true;
  }
  return false;
}

/**
 * A user-facing sentence for any error.
 *
 * Pass a `fallback` when the caller has better context than we do — e.g. "Could
 * not send the report." — it is used when the error is genuinely unrecognised,
 * so we never show a generic line where a specific one was available.
 */
export function friendlyError(err: unknown, fallback: string = FALLBACK): string {
  if (!err) return fallback;

  if (isNetworkError(err)) {
    // Keep the real thing in the console for diagnosis; show the useful thing.
    console.warn('[genz] network error:', messageOf(err) || err);
    return OFFLINE_MESSAGE;
  }

  const raw = messageOf(err).toLowerCase();
  if (raw) {
    for (const { match, say } of MESSAGE_MAP) {
      if (raw.includes(match)) return say;
    }
  }

  // An already-friendly message should pass through rather than be flattened to
  // the generic fallback — most of our own thrown messages are written for users.
  const original = messageOf(err);
  if (original && isHumanReadable(original)) return original;

  return fallback;
}

/**
 * Rough guard against passing machine text through as if it were a sentence.
 *
 * This is the check that actually stops a Java stack trace reaching the screen
 * when it arrives by a path that never went through fetch.
 */
function isHumanReadable(text: string): boolean {
  if (text.length > 160) return false; // a sentence, not a dump
  if (/\.(java|kt|ts|js|tsx)\b/i.test(text)) return false; // a stack frame
  if (/\bat [\w$.]+\(/.test(text)) return false; // a stack trace
  if (/\b(java|org|com|io)\.\w+\.\w+/.test(text)) return false; // a package path
  if (/[{}<>]|=>/.test(text)) return false; // code, not prose
  if (/^\s*[A-Za-z0-9_.]*(Error|Exception)\b/.test(text)) return false; // "TypeError:"
  if (text.toLowerCase().includes('http') && text.includes('://')) return false;
  if (/^[a-z_]+$/.test(text)) return false; // a bare token like "network_error"
  // Needs at least one space with letters after the first word, i.e. reads as prose.
  return /\s\S/.test(text);
}

/**
 * Wrap the global fetch so network failures carry a human message.
 *
 * Idempotent and safe to call more than once: a second call is ignored, so
 * hot-reload cannot stack wrappers.
 */
export function installNetworkErrorTranslator(): void {
  const g = globalThis as unknown as { fetch?: (...a: any[]) => Promise<any>; __genzFetchPatched?: boolean };

  if (typeof g.fetch !== 'function' || g.__genzFetchPatched) return;
  const original = g.fetch.bind(globalThis);
  g.__genzFetchPatched = true;

  g.fetch = async (...args: any[]) => {
    try {
      return await original(...args);
    } catch (e) {
      // Re-throw with a friendly message so every existing `setError(err.message)`
      // shows a sentence without being edited. The original is logged first.
      if (isNetworkError(e)) {
        console.warn('[genz] network error:', messageOf(e) || e);
        throw new Error(OFFLINE_MESSAGE);
      }
      throw e;
    }
  };
}
