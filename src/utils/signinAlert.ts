// ============================================================
// Gen Z -- new sign-in alerts
//
// Reports a genuine sign-in so the account's OTHER devices can be warned
// immediately, with the device name and where the sign-in came from.
//
// WHY IP GEOLOCATION INSTEAD OF GPS:
//   The question being answered is "where did this sign-in come from?", not
//   "where is the phone right now?". An IP lookup answers the real question,
//   needs no permission prompt, adds no native dependency, and works on a
//   phone in a pocket. City-level is the same accuracy Google's and Meta's
//   "new sign-in" emails use, which is the level people already understand.
//   The IP itself is not sent from here -- the server reads it off the request,
//   so this whole lookup is a best-effort nicety, not the source of truth. If
//   it fails we still report the sign-in; it just shows the IP alone.
//
// PRIVACY: one HTTPS GET per sign-in to a public no-key endpoint that returns
// city granularity. No coordinates are requested or stored, no GPS is touched,
// and nothing is looked up on app start, resume or token refresh.
// ============================================================

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase/client';
import { deviceLabel, waitForPushToken } from './push';

const KEY_SESSION = 'genz_session_key';
const KEY_REPORTED = 'genz_signin_reported_at';
const GEO_TIMEOUT_MS = 5000;

export type SigninPlace = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  isp: string | null;
};

export type SigninReport = {
  ok?: boolean;
  new_device?: boolean;
  new_location?: boolean;
  alerted?: boolean;
  other_devices?: number;
  ip?: string | null;
  device?: string | null;
};

const EMPTY_PLACE: SigninPlace = {
  city: null,
  region: null,
  country: null,
  countryCode: null,
  isp: null,
};

const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
};

/**
 * One-shot location lookup for this connection. Never throws: any failure,
 * timeout or shape change resolves to nulls so the sign-in report still goes
 * out. Two providers are tried because these are free public endpoints with no
 * uptime promise, and either one is sufficient.
 */
export async function lookupPlace(): Promise<SigninPlace> {
  const providers: { url: string; map: (j: Record<string, unknown>) => SigninPlace }[] = [
    {
      url: 'https://ipwho.is/',
      map: (j) => ({
        city: clean(j.city),
        region: clean(j.region),
        country: clean(j.country),
        countryCode: clean(j.country_code),
        isp: clean((j.connection as Record<string, unknown> | undefined)?.isp),
      }),
    },
    {
      url: 'https://ipapi.co/json/',
      map: (j) => ({
        city: clean(j.city),
        region: clean(j.region),
        country: clean(j.country_name),
        countryCode: clean(j.country_code),
        isp: clean(j.org),
      }),
    },
  ];

  for (const p of providers) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GEO_TIMEOUT_MS);
    try {
      const res = await fetch(p.url, { signal: ctl.signal });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      // ipwho.is signals failure with success:false and HTTP 200
      if (json.success === false) continue;
      const place = p.map(json);
      if (place.city || place.country) return place;
    } catch {
      // try the next provider
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...EMPTY_PLACE };
}

/** Stable per-install id. Same value the session heartbeat stores. */
async function sessionKey(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(KEY_SESSION);
    if (existing) return existing;
    const fresh = `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await AsyncStorage.setItem(KEY_SESSION, fresh);
    return fresh;
  } catch {
    // storage unavailable: a throwaway key still lets the server record the
    // sign-in and alert the other devices, it just may re-alert next time
    return `k${Date.now().toString(36)}`;
  }
}

/**
 * Report a genuine sign-in. Fire-and-forget from the caller's point of view:
 * resolves to null on any failure and never throws.
 *
 * @param force bypass the "reported in the last minute" guard (used by tests
 *              and by an explicit user-initiated "this was me" re-check)
 */
export async function reportSignin(force = false): Promise<SigninReport | null> {
  try {
    // React StrictMode double-invokes effects in development, and a fast
    // sign-out/sign-in can re-run this; both would fire two alerts for one
    // sign-in, which is exactly the kind of noise that trains people to ignore
    // security warnings. One report per minute is plenty.
    if (!force) {
      const last = await AsyncStorage.getItem(KEY_REPORTED).catch(() => null);
      const lastMs = last ? Number(last) : 0;
      if (lastMs && Date.now() - lastMs < 60_000) return null;
    }
    // stamped before the work so two racing callers cannot both proceed
    await AsyncStorage.setItem(KEY_REPORTED, String(Date.now())).catch(() => {});

    const [{ data: auth }, place, token] = await Promise.all([
      supabase.auth.getUser(),
      lookupPlace(),
      // short wait: initPush() may still be mid-flight on a cold sign-in. The
      // token only decides which device is skipped, so a null is acceptable.
      waitForPushToken(6000),
    ]);

    const user = auth?.user;
    if (!user) return null;

    const { data, error } = await supabase.rpc('register_signin', {
      p_session_key: await sessionKey(),
      // real marketing name ("Infinix HOT 30", "Pixel 8") instead of "Android"
      p_device: deviceLabel(),
      p_platform: Platform.OS,
      p_app_version: String((Constants?.expoConfig as { version?: string } | null)?.version ?? ''),
      p_city: place.city,
      p_region: place.region,
      p_country: place.country,
      p_country_code: place.countryCode,
      p_isp: place.isp,
      p_current_token: token,
    });
    if (error) return null;
    return (data ?? {}) as SigninReport;
  } catch {
    return null;
  }
}

/** True when this sign-in produced an alert on the account's other devices. */
export function wasAlerted(r: SigninReport | null): boolean {
  return !!r?.alerted;
}

/** "Lagos, Nigeria" / "Nigeria" / null -- for one-line display. */
export function placeLabel(city?: string | null, country?: string | null): string | null {
  const c = clean(city);
  const k = clean(country);
  if (c && k) return `${c}, ${k}`;
  return c ?? k ?? null;
}
