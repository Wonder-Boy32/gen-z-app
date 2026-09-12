import { supabase } from '../supabase/client';

// Reads a local file (file:// uri) as a Blob via XHR — the reliable Android path.
// With a timeout so a bad uri errors instead of hanging forever.
function readAsBlob(uri: string, timeoutMs = 20000): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        xhr.abort();
        reject(new Error('Timed out reading the file'));
      }
    }, timeoutMs);
    xhr.open('GET', uri);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (xhr.status === 200) resolve(xhr.response as Blob);
      else reject(new Error(`Could not read file (status ${xhr.status})`));
    };
    xhr.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('Could not read the local file'));
    };
    xhr.send();
  });
}

// Last-resort: read the file as raw bytes via expo-file-system (always works).
async function fileAsBytes(uri: string): Promise<ArrayBuffer> {
  const fs: any = await import('expo-file-system');
  const File = fs.File;
  if (!File) throw new Error('expo-file-system unavailable');
  const file = new File(uri);
  const bytes: Uint8Array = await file.bytes();
  return bytes.buffer as ArrayBuffer;
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
  let body: Blob | ArrayBuffer;
  try {
    body = await readAsBlob(uri);
  } catch {
    try {
      body = await withTimeout((await fetch(uri)).blob(), 30000, 'Timed out reading the file');
    } catch {
      body = await fileAsBytes(uri);
    }
  }
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
