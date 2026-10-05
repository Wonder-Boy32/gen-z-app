import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installNetworkErrorTranslator } from '../utils/friendlyError';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY from your Supabase project.'
  );
}

// ------------------------------------------------------------------
// Install the network-error translator BEFORE the client exists.
//
// Order matters: supabase-js resolves its fetch lazily, so patching the global
// first means even the initial session recovery goes through the translator —
// and every request the app ever makes inherits a human message on failure.
//
// This is the whole reason the fix is one line here rather than ~200 edits.
// Without it, a user with no connection sees a raw
// "java.net.UnknownHostException: Unable to resolve host ..." on the login form
// (exactly what was reported) because the app surfaces `err.message` verbatim.
// With it, that same failure arrives as "No internet connection. Please check
// your connection and try again." — and no call site had to change.
// ------------------------------------------------------------------
installNetworkErrorTranslator();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // explicit persistent storage — without AsyncStorage the SDK silently
    // falls back to in-memory and the user is "logged out" on every restart
    storage: AsyncStorage,
  },
});

// ------------------------------------------------------------------
// Write guard: Supabase's server rejects UPDATE/DELETE without a WHERE
// clause (code 21000). postgrest-js silently DROPS filters whose value
// is undefined, which can leave a request filter-less and trigger that
// server error (or worse, update all rows). This wrapper detects the
// case BEFORE the request goes out and logs the exact table + call
// stack so the culprit is impossible to miss.
// ------------------------------------------------------------------
const _from = supabase.from.bind(supabase);

function wrapFilterBuilder(method: 'update' | 'delete', table: string, builder: any) {
  const origThen = builder.then.bind(builder);
  builder.then = (onFulfilled?: any, onRejected?: any) => {
    try {
      const u = new URL(String(builder.url));
      const whereParams = [...u.searchParams.keys()].filter(
        (k) => !['select', 'columns', 'order', 'limit', 'offset', 'on_conflict'].includes(k)
      );
      if (whereParams.length === 0) {
        const err = new Error(
          `[genz-guard] ${method.toUpperCase()} without WHERE clause on table "${table}" — request URL: ${u.toString()}`
        );
        console.error(err.message, '\n', err.stack);
        return Promise.reject(err);
      }
    } catch {
      // builder.url not inspectable — let the server decide
    }
    return origThen(onFulfilled, onRejected);
  };
  return builder;
}

(supabase as any).from = (table: string) => {
  const q = _from(table);
  const origUpdate = q.update.bind(q);
  const origDelete = q.delete.bind(q);
  q.update = (values?: any, opts?: any) => wrapFilterBuilder('update', table, origUpdate(values, opts));
  q.delete = (opts?: any) => wrapFilterBuilder('delete', table, origDelete(opts));
  return q;
};

// ------------------------------------------------------------------
// getUser() IS DESTRUCTIVE. Do not use it to find out who is signed in.
//
// Every action in this app opens with the same two lines — 81 of them:
//
//     const { data: { user } } = await supabase.auth.getUser();
//     if (!user) return;
//
// getUser() is not a lookup, it is an authoritative NETWORK check, and when it
// comes back with AuthSessionMissingError the SDK calls _removeSession():
// @supabase/auth-js GoTrueClient.js L2639-2642 (inside _getUser), and
// _removeSession is defined at L4268. That DELETES the persisted session from
// AsyncStorage and emits SIGNED_OUT — the App.tsx branch that renders the
// welcome screen.
//
// So one failed "who am I?" on a flaky connection or an aging token did not
// merely fail the action: the `if (!user) return;` swallowed the error while the
// SDK threw the user out of the app. Hence "whenever I do anything, it takes me
// back to that page".
//
// getSession() reads the session we already hold and has no such side effect. On
// a client (as opposed to a server) the stored session IS the source of truth for
// who is signed in, and genuine revocation is still handled where it belongs — by
// the refresh path, which signs the user out once the server actually refuses the
// token.
//
// Patched here, once, rather than at 81 call sites: one definition, and no call
// site can reintroduce the destructive behaviour by accident. Same approach as
// the write guard above.
// ------------------------------------------------------------------
const _sdkGetUser = supabase.auth.getUser.bind(supabase.auth);

/** Escape hatch: a real server-verified check, for any flow that truly needs it. */
export function verifyUserWithServer() {
  return _sdkGetUser();
}

(supabase.auth as any).getUser = async (jwt?: string) => {
  // An explicit jwt means a caller is deliberately verifying a token, so leave
  // the SDK's real behaviour alone. The SDK's own internals pass one where it
  // matters; the app's 81 call sites never do.
  if (jwt) return _sdkGetUser(jwt);

  const { data, error } = await supabase.auth.getSession();
  if (error) return { data: { user: null }, error };
  return { data: { user: data.session?.user ?? null }, error: null };
};
