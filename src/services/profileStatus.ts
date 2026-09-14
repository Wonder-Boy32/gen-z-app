// ============================================================
// Temporary mood / status — client data layer
//
// Reads go through `profile_status_live` (a view that filters expires_at in SQL),
// so an expired mood can never render even before the purge removes the row. No
// screen needs to remember to check expiry.
//
// This is NOT the same thing as profiles.activity_status (online presence) or
// profiles.account_status (moderation). A mood is a third, unrelated concept.
//
// The 48h window and the server-side created_at stamp live in the database
// (supabase/profile_status.sql). This layer never assumes its own expiry wins.
// ============================================================

import { supabase } from '../supabase/client';

export type ProfileStatus = {
  emoji: string;
  label: string;
  expiresAt: string;
};

/** The examples from the product spec, plus one neutral default. */
export const STATUS_PRESETS: { emoji: string; label: string }[] = [
  { emoji: '🥱', label: 'Barely surviving lectures' },
  { emoji: '😭', label: 'Exam tomorrow' },
  { emoji: '🔥', label: 'Outside tonight' },
  { emoji: '❤️', label: 'Good vibes' },
  { emoji: '😴', label: 'Do not disturb me' },
];

export const STATUS_MAX_LABEL = 40;
export const STATUS_MAX_HOURS = 48;
export const STATUS_DEFAULT_HOURS = 24;

const LIVE_VIEW = 'profile_status_live';

function toStatus(row: { emoji?: string | null; label?: string | null; expires_at?: string | null } | null): ProfileStatus | null {
  if (!row || !row.expires_at) return null;
  return { emoji: row.emoji ?? '✨', label: row.label ?? '', expiresAt: row.expires_at };
}

export async function fetchMyStatus(): Promise<ProfileStatus | null> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from(LIVE_VIEW)
    .select('emoji, label, expires_at')
    .eq('user_id', uid)
    .maybeSingle();

  if (error || !data) return null;
  return toStatus(data);
}

/** For lists (people rows, search results). One query regardless of how many ids. */
export async function fetchStatuses(userIds: string[]): Promise<Record<string, ProfileStatus>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return {};

  const { data, error } = await supabase
    .from(LIVE_VIEW)
    .select('user_id, emoji, label, expires_at')
    .in('user_id', ids);

  if (error || !data) return {};

  const out: Record<string, ProfileStatus> = {};
  for (const row of data as { user_id: string; emoji: string | null; label: string | null; expires_at: string | null }[]) {
    const status = toStatus(row);
    if (status) out[row.user_id] = status;
  }
  return out;
}

export async function setMyStatus(
  emoji: string,
  label: string,
  hours: number = STATUS_DEFAULT_HOURS
): Promise<{ ok: boolean; message: string }> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return { ok: false, message: 'Please sign in again and retry.' };

  const clean = label.trim();
  if (!clean) return { ok: false, message: 'Add a short status first.' };
  if (clean.length > STATUS_MAX_LABEL) {
    return { ok: false, message: `Keep it under ${STATUS_MAX_LABEL} characters.` };
  }

  // Clamped here only so the common case is a clean request; the database clamps
  // again and owns the decision.
  const hoursClamped = Math.min(Math.max(1, hours), STATUS_MAX_HOURS);
  const expiresAt = new Date(Date.now() + hoursClamped * 3_600_000).toISOString();

  // One mood per user, so a second set replaces the first rather than stacking.
  const { error } = await supabase
    .from('profile_status')
    .upsert(
      { user_id: uid, emoji: emoji || '✨', label: clean, expires_at: expiresAt },
      { onConflict: 'user_id' }
    );

  if (error) {
    // 23514 = a check constraint refused it; the server decided, not us
    if (error.code === '23514') {
      return { ok: false, message: 'That status duration is not allowed.' };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true, message: 'Status is live.' };
}

export async function clearMyStatus(): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.rpc('clear_my_status');
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: 'Status cleared.' };
}

/** Compact countdown for the chip, e.g. "42m", "7h", "1d". */
export function shortTimeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
