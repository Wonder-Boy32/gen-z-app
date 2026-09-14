// ============================================================
// Verification (Get Verified) — client data layer
//
// Deliberately a SEPARATE module from genzplus.ts, mirroring the separation in
// the database (supabase/verification_requests.sql): buying GenZ+ must never
// produce a verification badge.
//
// This module only SUBMITS an application and reads its status. It cannot grant
// verification — public.verification_requests has no update policy, so approval
// only happens through the admin console (admin_center.sql).
// ============================================================

import { supabase } from '../supabase/client';

export type VerificationStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type VerificationState = {
  status: VerificationStatus;
  submittedAt: string | null;
  reviewNote: string | null;
};

const NONE: VerificationState = { status: 'none', submittedAt: null, reviewNote: null };

export async function fetchVerificationState(): Promise<VerificationState> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return NONE;

  // An approved badge on the profile outranks whatever the queue says.
  const { data: prof } = await supabase
    .from('profiles')
    .select('verified')
    .eq('id', uid)
    .maybeSingle();

  const { data, error } = await supabase
    .from('verification_requests')
    .select('status, created_at, review_note')
    .eq('user_id', uid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prof?.verified) {
    return { status: 'approved', submittedAt: data?.created_at ?? null, reviewNote: null };
  }
  if (error || !data) return NONE;

  return {
    status: (data.status as VerificationStatus) ?? 'none',
    submittedAt: data.created_at ?? null,
    reviewNote: data.review_note ?? null,
  };
}

export const VERIFICATION_MIN_REASON = 20;

export async function submitVerificationRequest(input: {
  displayName?: string;
  reason: string;
  links?: string;
}): Promise<{ ok: boolean; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return { ok: false, message: 'Please sign in again and retry.' };

  const reason = input.reason.trim();
  if (reason.length < VERIFICATION_MIN_REASON) {
    return {
      ok: false,
      message: `Please give at least ${VERIFICATION_MIN_REASON} characters so a reviewer can assess it.`,
    };
  }

  const { error } = await supabase.from('verification_requests').insert({
    user_id: uid,
    display_name: input.displayName?.trim() || null,
    reason,
    links: input.links?.trim() || null,
    status: 'pending',
  });

  if (error) {
    // Partial unique index: one open application per user.
    if (error.code === '23505') {
      return { ok: false, message: 'You already have an application under review.' };
    }
    return { ok: false, message: error.message };
  }

  return { ok: true, message: 'Application received. Our team will review it.' };
}
