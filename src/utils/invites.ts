import { Share } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase/client';
import { friendlyError } from './friendlyError';

/**
 * invites — the client half of the invite loop.
 *
 * Pairs with supabase/invite_tooling.sql. Everything here goes through the
 * SECURITY DEFINER functions in that migration, so the client never writes to
 * invite_redemptions directly and cannot enumerate other people's codes.
 *
 * The loop this exists to close:
 *   inviter opens the sheet -> shares a code -> invitee installs, signs up,
 *   enters (or deep-links) the code -> redemption row -> inviter sees the count
 *
 * The count matters as much as the mechanism. The feed is empty because there
 * are no people; the only way to know whether invites are working is to be able
 * to see who actually arrived.
 */

/** Set when a code arrives before there is a session to redeem it against. */
const PENDING_KEY = 'genz_pending_invite_code';

export type InviteStats = { code: string | null; joined: number };

export type RedeemResult = {
  ok: boolean;
  reason?: string;
  inviter?: string | null;
  /** A sentence safe to show the user. */
  message: string;
};

/**
 * Every failure redeem_invite() can return, in words a person can act on.
 *
 * Kept on the client because these are UI copy, and because redeem_invite()
 * deliberately returns reasons rather than raising: each one is an ordinary
 * situation (a typo, a second attempt, your own code), not an error to collapse
 * into a generic failure.
 */
const REASON_TEXT: Record<string, string> = {
  not_authenticated: 'Log in first, then enter the code.',
  empty: 'Enter an invite code to continue.',
  unknown_code: "That code doesn't match anyone. Check it and try again.",
  already_redeemed: "You've already joined through someone's invite.",
  self: "That's your own code — share it with a friend instead.",
};

function normaliseCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

/** The caller's code and how many people arrived through it. */
export async function getMyInviteStats(): Promise<InviteStats> {
  const { data, error } = await supabase.rpc('my_invite_stats');
  if (error || !data) return { code: null, joined: 0 };
  const d = data as { code?: string | null; joined?: number };
  return {
    code: typeof d.code === 'string' ? d.code : null,
    joined: typeof d.joined === 'number' ? d.joined : 0,
  };
}

/**
 * Fetch the caller's code, allocating one on first call.
 *
 * Idempotent and safe to call on every open — the server returns the existing
 * code when there is one, so this cannot mint duplicates.
 */
export async function ensureMyInviteCode(): Promise<string | null> {
  const { data, error } = await supabase.rpc('ensure_invite_code');
  if (error) {
    console.warn('[genz] ensure_invite_code failed:', friendlyError(error));
    return null;
  }
  return typeof data === 'string' && data ? data : null;
}

/** Hand a code to the server. Returns the verdict; never throws. */
export async function redeemInvite(code: string | null | undefined): Promise<RedeemResult> {
  const clean = normaliseCode(code);
  if (!clean) return { ok: false, reason: 'empty', message: REASON_TEXT.empty };

  const { data, error } = await supabase.rpc('redeem_invite', { p_code: clean });
  if (error) {
    // A network failure is not "the code is wrong", and must not be reported as
    // one — the user would retype a perfectly good code.
    return {
      ok: false,
      reason: 'request_failed',
      message: friendlyError(error, "Couldn't check that code. Please try again."),
    };
  }

  const d = (data ?? {}) as { ok?: boolean; reason?: string; inviter?: string | null };
  if (d.ok) {
    return {
      ok: true,
      inviter: d.inviter ?? null,
      message: d.inviter ? `You're in — @${d.inviter} invited you.` : "You're in.",
    };
  }
  return {
    ok: false,
    reason: d.reason,
    message: REASON_TEXT[d.reason ?? ''] ?? "That code didn't work. Check it and try again.",
  };
}

/** The app's own link for a code. `scheme: "genz"` is already in app.json. */
export function inviteDeepLink(code: string): string {
  return `genz://invite/${normaliseCode(code)}`;
}

/**
 * The text that goes out through the share sheet.
 *
 * The code is written out in full rather than relying on the link, because a
 * recipient who does not have the app yet cannot open a genz:// link — and at
 * this stage nobody has the app yet. The link is still included so it works for
 * anyone who does.
 */
export function inviteShareMessage(code: string): string {
  const clean = normaliseCode(code);
  return [
    'Join me on Gen Z.',
    '',
    `Use my invite code: ${clean}`,
    '',
    'Everything vanishes after 7 days. No archive, no receipts.',
  ].join('\n');
}

/** Open the native share sheet. Returns true when the user actually shared. */
export async function shareInvite(code: string): Promise<boolean> {
  const clean = normaliseCode(code);
  if (!clean) return false;
  try {
    const res = await Share.share({
      message: `${inviteShareMessage(clean)}\n\n${inviteDeepLink(clean)}`,
    });
    return res.action === Share.sharedAction;
  } catch (e) {
    // A dismissed share sheet and a failed one look the same to the user: both
    // mean nothing went out. Log the real reason so they are distinguishable.
    console.warn('[genz] shareInvite failed:', friendlyError(e));
    return false;
  }
}

/** Pull a code out of any incoming link, or a pasted bare code. */
export function parseInviteCode(url: string | null | undefined): string | null {
  if (!url) return null;
  const inLink = /invite\/([A-Za-z0-9]{4,12})/.exec(url);
  if (inLink) return inLink[1].toUpperCase();
  const bare = /^[A-Za-z0-9]{6}$/.exec(url.trim());
  return bare ? bare[0].toUpperCase() : null;
}

/**
 * Stash a code that arrived before there was a session.
 *
 * A deep link opened on a fresh install lands before sign-up completes, so the
 * code has to survive that gap or the invite is silently lost — which would make
 * the inviter's count wrong and the whole loop untrustworthy.
 */
export async function rememberPendingInvite(code: string): Promise<void> {
  const clean = normaliseCode(code);
  if (!clean) return;
  try {
    await AsyncStorage.setItem(PENDING_KEY, clean);
  } catch (e) {
    console.warn('[genz] could not stash pending invite:', friendlyError(e));
  }
}

/** Redeem a stashed code, if there is one. Returns null when there was none. */
export async function redeemPendingInvite(): Promise<RedeemResult | null> {
  let code: string | null = null;
  try {
    code = await AsyncStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!code) return null;

  const result = await redeemInvite(code);
  // Clear on success AND on a definitive rejection (bad code, already claimed).
  // Keep it only when the attempt itself failed, so a network blip does not
  // throw away a code the user legitimately has.
  if (result.ok || result.reason !== 'request_failed') {
    await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
  }
  return result;
}
