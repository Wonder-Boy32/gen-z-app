import { createClient } from '@supabase/supabase-js';

// The ADMIN app uses the standard anon key + RLS. Every admin call goes
// through SECURITY DEFINER RPCs that enforce roles server-side — the anon
// key itself grants nothing on admin tables (grants revoked).
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anon) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in admin/.env');
}

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});
