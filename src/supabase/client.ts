import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.example to .env and fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY from your Supabase project.'
  );
}

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
