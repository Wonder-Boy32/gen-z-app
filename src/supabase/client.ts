import { createClient } from '@supabase/supabase-js';

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
  },
});

// ------------------------------------------------------------------
// Write guard: Supabase's server rejects UPDATE/DELETE without a WHERE
// clause (code 21000 — "UPDATE requires a WHERE clause"). postgrest-js
// silently DROPS filters whose value is undefined, which can leave a
// request filter-less and trigger that server error. This wrapper
// detects the case BEFORE the request goes out and logs the exact
// table + call stack so the culprit is impossible to miss.
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
// Request logger (diagnostic). Prints every Supabase REST/storage call
// with its method, URL and response status so a failing request can be
// identified from the Metro terminal in one reproduction.
// ------------------------------------------------------------------
const _fetch = globalThis.fetch?.bind(globalThis);
if (_fetch) {
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const res: any = await _fetch(input, init);
    if (typeof url === 'string' && (url.includes('/rest/v1/') || url.includes('/storage/v1/'))) {
      let body = '';
      try {
        const c = res.clone();
        body = (await c.text()).slice(0, 220);
      } catch {
        // body not readable — fine
      }
      console.log(`[genz-net] ${method} ${url.replace(/key=.*/g, 'key=***')} -> ${res.status} ${body.slice(0, 140)}`);
    }
    return res;
  };
}
