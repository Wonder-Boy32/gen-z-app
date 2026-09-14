// ============================================================
// GenZ+ — client data layer
//
// Entitlement is ALWAYS read from the database. There is deliberately no local
// "isPremium" flag to flip: public.genzplus_members has RLS enabled with no
// client write policy (supabase/genzplus.sql), so the only thing that can make
// someone GenZ+ is a server-verified payment. Everything here is a *cache of the
// server's answer*, never a substitute for it.
//
// PAYMENT FLOW (supabase/genzplus_opay.sql): the user transfers ₦20,000 to the
// OPay account from fetchPaymentConfig(), submits the transfer reference with
// submitPaymentClaim(), and an ADMIN confirms it. The client cannot approve its
// own claim — genzplus_payments has no update policy.
// ============================================================

import { supabase } from '../supabase/client';

export const GENZPLUS_PRICE_NAIRA = 20000;
export const GENZPLUS_PRICE_LABEL = '₦20,000';
export const GENZPLUS_PERIOD_MONTHS = 2;
export const GENZPLUS_PERIOD_LABEL = 'every 2 months';
export const GENZPLUS_MIN_REFERENCE = 6;

/** Hermes-safe: no Intl dependency, so this cannot render differently per device. */
export function formatNaira(kobo: number): string {
  const naira = Math.max(0, Math.round(kobo / 100));
  return '₦' + naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Hermes-safe date formatting (avoids toLocaleDateString's ICU dependence). */
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - Date.now()) / 86400000);
}

// ------------------------------------------------------------
// entitlement
// ------------------------------------------------------------

export type GenZPlusEntitlement = {
  active: boolean;
  plan: string;
  purchasedAt: string | null;
  expiresAt: string | null;
};

const INACTIVE: GenZPlusEntitlement = {
  active: false,
  plan: '2months',
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
    plan: data.plan ?? '2months',
    purchasedAt: data.purchased_at ?? null,
    expiresAt: data.expires_at ?? null,
  };
}

// ------------------------------------------------------------
// payment instructions (server-stored, so they can change without a release)
// ------------------------------------------------------------

export type PaymentConfig = {
  provider: string;
  accountName: string | null;
  accountNumber: string;
  amountKobo: number;
  amountLabel: string;
  periodMonths: number;
  instructions: string | null;
};

export async function fetchPaymentConfig(): Promise<PaymentConfig | null> {
  const { data, error } = await supabase
    .from('payment_config')
    .select('provider, account_name, account_number, amount_kobo, period_months, instructions')
    .maybeSingle();

  if (error || !data) return null;

  const kobo = Number(data.amount_kobo ?? GENZPLUS_PRICE_NAIRA * 100);
  return {
    provider: data.provider ?? 'opay',
    accountName: data.account_name ?? null,
    accountNumber: data.account_number ?? '',
    amountKobo: kobo,
    amountLabel: formatNaira(kobo),
    periodMonths: Number(data.period_months ?? GENZPLUS_PERIOD_MONTHS),
    instructions: data.instructions ?? null,
  };
}

// ------------------------------------------------------------
// the payer's claim
// ------------------------------------------------------------

export type PaymentClaimStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type PaymentClaim = {
  status: PaymentClaimStatus;
  reference: string | null;
  submittedAt: string | null;
  reviewNote: string | null;
};

const NO_CLAIM: PaymentClaim = { status: 'none', reference: null, submittedAt: null, reviewNote: null };

export async function fetchPaymentClaim(): Promise<PaymentClaim> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return NO_CLAIM;

  const { data, error } = await supabase
    .from('genzplus_payments')
    .select('status, reference, created_at, review_note')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return NO_CLAIM;

  return {
    status: (data.status as PaymentClaimStatus) ?? 'none',
    reference: data.reference ?? null,
    submittedAt: data.created_at ?? null,
    reviewNote: data.review_note ?? null,
  };
}

/**
 * Record that the user has sent the transfer. This does NOT activate anything —
 * it puts a claim in the review queue. Only an admin confirming the payment can
 * grant GenZ+.
 */
export async function submitPaymentClaim(input: {
  reference: string;
  amountKobo?: number;
  note?: string;
}): Promise<{ ok: boolean; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return { ok: false, message: 'Please sign in again and retry.' };

  const reference = input.reference.trim();
  if (reference.length < GENZPLUS_MIN_REFERENCE) {
    return {
      ok: false,
      message: `Enter the transfer reference from your OPay receipt (at least ${GENZPLUS_MIN_REFERENCE} characters).`,
    };
  }

  const { error } = await supabase.from('genzplus_payments').insert({
    user_id: uid,
    reference,
    amount_kobo: input.amountKobo ?? GENZPLUS_PRICE_NAIRA * 100,
    note: input.note?.trim() || null,
    status: 'pending',
  });

  if (error) {
    // 23505 = either the one-pending-claim index or the unique reference index.
    if (error.code === '23505') {
      return {
        ok: false,
        message:
          'That reference has already been submitted, or you already have a payment under review.',
      };
    }
    return { ok: false, message: error.message };
  }

  return { ok: true, message: 'Payment submitted. GenZ+ activates once we confirm it.' };
}

// ------------------------------------------------------------
// future automated-provider seam — NOT used by the current OPay flow.
// Pairs with genzplus_initiate(), which is inert in SQL until a provider with a
// real API (OPay merchant, Paystack/Flutterwave) is wired up. Kept so the
// automated path has both halves ready.
// ------------------------------------------------------------

export type PurchaseOutcome =
  | { status: 'ready'; checkoutUrl: string }
  | { status: 'unavailable'; message: string }
  | { status: 'already_active' }
  | { status: 'failed'; message: string };

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
