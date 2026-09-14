// ============================================================
// GenZ+ — client data layer
//
// Entitlement is ALWAYS read from the database. There is deliberately no local
// "isPremium" flag to flip: public.genzplus_members has RLS enabled with no
// client write policy (see supabase/genzplus.sql), so the only thing that can
// make someone GenZ+ is a server-verified payment. Everything this module
// returns is a *cache of the server's answer*, never a substitute for it.
// ============================================================

import { supabase } from '../supabase/client';

// ₦20,000. Kept in one place so the screen, the confirmation step and any
// future receipt copy cannot drift apart.
export const GENZPLUS_PRICE_NAIRA = 20000;
export const GENZPLUS_PRICE_LABEL = '₦20,000';

export type GenZPlusEntitlement = {
  active: boolean;
  plan: string;
  purchasedAt: string | null;
  expiresAt: string | null;
};

const INACTIVE: GenZPlusEntitlement = {
  active: false,
  plan: 'lifetime',
  purchasedAt: null,
  expiresAt: null,
};

export async function fetchGenZPlusEntitlement(): Promise<GenZPlusEntitlement> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return INACTIVE;

  const { data, error } = await supabase
    .from('genzplus_members')
    .select('active, plan, purchased_at, expires_at')
    .eq('user_id', uid)
    .maybeSingle();

  // No row, or the query failed (e.g. the migration has not been run yet):
  // treat as not premium rather than guessing. The secure default is "no".
  if (error || !data) return INACTIVE;

  const notExpired = !data.expires_at || new Date(data.expires_at).getTime() > Date.now();
  return {
    active: !!data.active && notExpired,
    plan: data.plan ?? 'lifetime',
    purchasedAt: data.purchased_at ?? null,
    expiresAt: data.expires_at ?? null,
  };
}

export type PurchaseOutcome =
  | { status: 'ready'; checkoutUrl: string }
  | { status: 'unavailable'; message: string }
  | { status: 'already_active' }
  | { status: 'failed'; message: string };

/**
 * Asks the server to start a GenZ+ purchase.
 *
 * The server reads the provider key from Supabase Vault and returns a checkout
 * URL; the client never sees a secret and never decides whether payment
 * succeeded. Until a provider is configured AND its initialize call is
 * implemented (the seam marked in supabase/genzplus.sql), this returns
 * `unavailable` with the server's reason — it does not fake a success and it
 * cannot charge anyone.
 */
export async function beginGenZPlusPurchase(): Promise<PurchaseOutcome> {
  const { data, error } = await supabase.rpc('genzplus_initiate');

  if (error) return { status: 'failed', message: error.message };

  const res = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    detail?: string;
    checkout_url?: string;
  };

  if (res.ok && res.checkout_url) return { status: 'ready', checkoutUrl: res.checkout_url };
  if (res.error === 'already_active') return { status: 'already_active' };
  if (res.error === 'not_configured' || res.error === 'provider_not_implemented') {
    return { status: 'unavailable', message: res.detail ?? 'GenZ+ is not available yet.' };
  }
  return { status: 'failed', message: res.detail ?? res.error ?? 'Could not start the purchase.' };
}
