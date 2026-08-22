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
      body = await (await fetch(uri)).blob();
    } catch {
      body = await fileAsBytes(uri);
    }
  }
  const { error } = await supabase.storage.from('media').upload(path, body as any, { upsert, contentType: type });
  if (error) throw new Error(error.message);
  const {
    data: { publicUrl },
  } = supabase.storage.from('media').getPublicUrl(path);
  return publicUrl;
}
