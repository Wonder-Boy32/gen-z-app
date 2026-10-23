import { supabase } from '../supabase/client';

/**
 * Private media references.
 *
 * Chat attachments and anonymous-message photos used to be stored as
 * absolute public URLs pointing at the `media` bucket. Anyone holding
 * the URL — or anyone who listed the bucket, which was also allowed —
 * could read them with no authentication at all. That is why the
 * database now writes those objects to private buckets.
 *
 * A private object cannot be referenced by a permanent URL, so the
 * database stores a REFERENCE instead:
 *
 *     sb://chat-media/<conversationId>/<senderUid>/<file>
 *     sb://anon-media/<recipientId>/<file>
 *
 * The renderer turns a reference into a short-lived signed URL at the
 * moment it needs one. Two rules make this safe to mix with old data:
 *
 *   1. Anything that is not an `sb://` reference is returned unchanged.
 *      Legacy rows still hold full public URLs and keep working, so the
 *      migration can run after the client ships rather than before.
 *   2. A failed signature resolves to `null`, never to the raw path.
 *      A broken image is a rendering bug; a leaked path is a privacy
 *      bug, and they must not be confused.
 */

const REF_RE = /^sb:\/\/([a-z0-9-]+)\/(.+)$/i;

/** Signed URLs are valid for 1 hour; cached for 45 minutes so a long
 *  session refreshes before anything expires under the user. */
const SIGNED_TTL_SECONDS = 3600;
const CACHE_TTL_MS = 45 * 60 * 1000;

type Cached = { url: string; at: number };

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<string | null>>();

export function storageRef(bucket: string, path: string): string {
  return `sb://${bucket}/${path}`;
}

export function isStorageRef(value: string | null | undefined): boolean {
  return !!value && REF_RE.test(value);
}

function parse(ref: string): { bucket: string; path: string } | null {
  const m = REF_RE.exec(ref);
  return m ? { bucket: m[1], path: m[2] } : null;
}

/**
 * Resolve one reference. Plain URLs pass straight through, which is what
 * keeps every legacy row and every genuinely public image working.
 */
export async function resolveMediaRef(
  value: string | null | undefined
): Promise<string | null> {
  if (!value) return null;
  const parsed = parse(value);
  if (!parsed) return value;

  const hit = cache.get(value);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.url;

  const pending = inFlight.get(value);
  if (pending) return pending;

  const job = (async () => {
    try {
      const { data, error } = await supabase.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, SIGNED_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        if (__DEV__) console.warn('[privateMedia] sign failed:', parsed.bucket, error?.message);
        return null;
      }
      cache.set(value, { url: data.signedUrl, at: Date.now() });
      return data.signedUrl;
    } catch (e: any) {
      if (__DEV__) console.warn('[privateMedia] sign threw:', e?.message ?? e);
      return null;
    } finally {
      inFlight.delete(value);
    }
  })();

  inFlight.set(value, job);
  return job;
}

/**
 * Resolve a batch. Used on timeline load so a thread with twenty photos
 * costs one round trip per bucket instead of twenty.
 */
export async function resolveMediaRefs(
  values: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byBucket = new Map<string, string[]>();

  for (const v of values) {
    if (!v) continue;
    const parsed = parse(v);
    if (!parsed) {
      out.set(v, v);
      continue;
    }
    const hit = cache.get(v);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      out.set(v, hit.url);
      continue;
    }
    const list = byBucket.get(parsed.bucket) ?? [];
    list.push(v);
    byBucket.set(parsed.bucket, list);
  }

  await Promise.all(
    Array.from(byBucket.entries()).map(async ([bucket, refs]) => {
      const paths = refs.map((r) => parse(r)!.path);
      try {
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrls(paths, SIGNED_TTL_SECONDS);

        if (error || !data) {
          // Fall back to one-by-one so a single bad path cannot blank a
          // whole page of images.
          await Promise.all(
            refs.map(async (r) => {
              const signed = await resolveMediaRef(r);
              if (signed) out.set(r, signed);
            })
          );
          return;
        }

        data.forEach((entry: { path: string | null; signedUrl: string | null; error: string | null }, i: number) => {
          if (entry?.signedUrl) {
            const ref = refs[i];
            cache.set(ref, { url: entry.signedUrl, at: Date.now() });
            out.set(ref, entry.signedUrl);
          }
        });
      } catch (e: any) {
        if (__DEV__) console.warn('[privateMedia] batch sign threw:', e?.message ?? e);
      }
    })
  );

  return out;
}

/** Test seam — not used in app code. */
export function _clearPrivateMediaCache(): void {
  cache.clear();
  inFlight.clear();
}
