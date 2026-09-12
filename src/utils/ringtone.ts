// ============================================================
// Ringtone — generates a small WAV beep on-device (no assets,
// no network) and returns its file:// URI for expo-audio.
// ============================================================

let cachedUri: string | null = null;

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function buildBeepWavBase64(): string {
  const sampleRate = 8000;
  const beepSec = 0.42;
  const gapSec = 0.26;
  const cycles = 5;
  const totalSec = (beepSec + gapSec) * cycles;
  const n = Math.floor(sampleRate * totalSec);
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeString(view, 36, 'data');
  view.setUint32(40, n * 2, true);

  let idx = 44;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = t % (beepSec + gapSec);
    const on = phase < beepSec;
    // gentle fade in/out so the beep doesn't click
    const fade = on ? Math.min(1, phase / 0.02, (beepSec - phase) / 0.02) : 0;
    const v = on ? Math.sin(2 * Math.PI * 880 * t) * 0.35 * Math.max(0, fade) : 0;
    const s = Math.max(-1, Math.min(1, v));
    view.setInt16(idx, Math.round(s * 32767), true);
    idx += 2;
  }

  // base64 (chunked to avoid call-stack limits on long strings)
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// Writes the ringtone to the cache dir once and memoizes the URI.
export async function getRingtoneUri(): Promise<string> {
  if (cachedUri) return cachedUri;
  const fs: any = await import('expo-file-system');
  const File = fs.File;
  const b64 = buildBeepWavBase64();
  const file = new File(fs.Paths.cache, 'chat-ringtone.wav');
  if (file.exists) file.delete();
  await file.write(b64, { encoding: 'base64' });
  const uri: string = file.uri;
  cachedUri = uri;
  return uri;
}
