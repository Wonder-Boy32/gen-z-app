import { supabase } from '../supabase/client';

// Needed by the progress-capable uploader below, which talks to the Storage
// endpoint directly because supabase-js reports no progress.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Reads a local file (file:// uri) as bytes.
//
// ORDER MATTERS. The native File read goes FIRST: it is a direct native read
// with no HTTP stack in between, so it is immune to the Android restrictions
// that make XHR/fetch to file:// unreliable. XHR used to be first, and an XHR
// that "succeeds" with a 0-byte blob would resolve, skip every fallback, and
// upload nothing — a silent no-op that looked like a broken screen.
//
// Every branch records WHY it failed, so a total failure reports each real
// reason instead of one generic message.
function readViaXhr(uri: string, timeoutMs = 20000): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        xhr.abort();
        reject(new Error('XHR timed out'));
      }
    }, timeoutMs);
    xhr.open('GET', uri);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (xhr.status === 200 && xhr.response) resolve(xhr.response as Blob);
      else reject(new Error(`XHR status ${xhr.status}`));
    };
    xhr.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('XHR could not read the file'));
    };
    xhr.send();
  });
}

async function readFileBody(uri: string): Promise<Blob | ArrayBuffer> {
  const reasons: string[] = [];

  // 1. Native read — no network stack, handles large files and video.
  try {
    const fs: any = await import('expo-file-system');
    const File = fs.File;
    if (!File) {
      reasons.push('expo-file-system has no File export');
    } else {
      const buf = await new File(uri).arrayBuffer();
      if (buf && buf.byteLength > 0) return buf;
      reasons.push('native read returned 0 bytes');
    }
  } catch (e: any) {
    reasons.push(`native read: ${e?.message ?? e}`);
  }

  // 2. XHR.
  try {
    const blob = await readViaXhr(uri);
    if (blob.size > 0) return blob;
    reasons.push('XHR read returned 0 bytes');
  } catch (e: any) {
    reasons.push(`xhr: ${e?.message ?? e}`);
  }

  // 3. fetch.
  try {
    const blob = await withTimeout((await fetch(uri)).blob(), 30000, 'fetch timed out');
    if (blob.size > 0) return blob;
    reasons.push('fetch read returned 0 bytes');
  } catch (e: any) {
    reasons.push(`fetch: ${e?.message ?? e}`);
  }

  throw new Error(`Could not read the selected file (${reasons.join('; ')})`);
}

// Race a promise against a timeout so a stalled native/network call can
// never leave the UI stuck on an infinite spinner. The loser throws a
// clear, human-readable message.
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Uploads a local file (uri) to the 'media' bucket and returns its public URL.
export async function uploadMedia(
  path: string,
  uri: string,
  mimeType: string | undefined | null,
  upsert = false
): Promise<string> {
  const type = mimeType ?? 'application/octet-stream';
  // One reader, which tries the native path first and reports every failure
  // reason if all of them fail.
  const body = await readFileBody(uri);
  // supabase-js has NO upload timeout — a stalled connection hangs forever.
  // Wrap it so the user always gets a clear error instead of an endless spin.
  const upload = supabase.storage
    .from('media')
    .upload(path, body as any, { upsert, contentType: type });
  let result: { error: any };
  try {
    result = await withTimeout(Promise.resolve(upload), 120000, 'Upload timed out — check your connection and try again.');
  } catch (e: any) {
    throw new Error(e?.message ?? 'Upload failed — check your connection and try again.');
  }
  const { error } = result;
  if (error) throw new Error(error.message);
  const {
    data: { publicUrl },
  } = supabase.storage.from('media').getPublicUrl(path);
  return publicUrl;
}

// ------------------------------------------------------------------
// Progress-capable upload.
//
// supabase-js emits no progress events at all, so a percentage bar built on
// `.upload()` could only ever be a fiction. This performs the same PUT against
// the same Storage endpoint with the same credentials, and reads
// `xhr.upload.onprogress` — the only honest source for "how much is left".
//
// It is a separate function on purpose: uploadMedia() is called from 15 places
// (chat, avatars, stories, onboarding…) that do not want or need a progress bar
// and must keep using the proven path.
// ------------------------------------------------------------------

/** Resolves true only when the server accepted the bytes. */
async function putWithProgress(
  path: string,
  body: Blob | ArrayBuffer,
  type: string,
  upsert: boolean,
  onProgress?: (fraction: number) => void
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return false;

  // Encode each segment, not the whole path — the separators must survive.
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const url = `${SUPABASE_URL}/storage/v1/object/media/${encoded}`;

  return new Promise<boolean>((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', type);
    if (upsert) xhr.setRequestHeader('x-upsert', 'true');
    // The XHR owns its own timeout so a stalled request is actually ABORTED —
    // the withTimeout() helper used elsewhere can only stop waiting.
    xhr.timeout = 120000;

    if (onProgress) {
      xhr.upload.onprogress = (e: any) => {
        if (e?.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        finish(true);
      } else {
        finish(false);
      }
    };
    xhr.onerror = () => finish(false);
    xhr.ontimeout = () => finish(false);
    xhr.onabort = () => finish(false);

    try {
      xhr.send(body as any);
    } catch {
      finish(false);
    }
  });
}

/**
 * Uploads a local file and reports real byte progress (0..1).
 *
 * Falls back to the plain supabase-js upload if the XHR path is unavailable or
 * the server rejects it, so a post is never lost to a transport detail.
 */
export async function uploadMediaWithProgress(
  path: string,
  uri: string,
  mimeType: string | undefined | null,
  onProgress?: (fraction: number) => void,
  upsert = false
): Promise<string> {
  const type = mimeType ?? 'application/octet-stream';
  const body = await readFileBody(uri);

  const uploaded = await putWithProgress(path, body, type, upsert, onProgress);
  if (uploaded) {
    onProgress?.(1);
    const {
      data: { publicUrl },
    } = supabase.storage.from('media').getPublicUrl(path);
    return publicUrl;
  }

  // Fallback: the proven path. Progress will jump rather than glide, which is
  // better than failing.
  return uploadMedia(path, uri, type, upsert);
}
