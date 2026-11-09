// ============================================================
// Native video processing via ffmpeg-expo (Expo Module, works
// on the New Architecture). REPLACES the retired
// ffmpeg-kit-react-native, which hangs/breaks on RN 0.86+
// new-arch builds.
// Available ONLY in dev/production builds that include native
// code (NOT Expo Go). Everything degrades gracefully:
// hasNativeFFmpeg() is false in Expo Go, and processDropVideo
// throws → the create flow falls back to the metadata-only path
// (playback-time trim/speed/filters via DropVideoView).
// ============================================================

import { coverWindows, pickBestCover } from './coverPicker';

let ffModule: any = null;
let ffChecked = false;
let expoGoChecked = false;
let isExpoGo = false;

// True when running inside Expo Go, where NATIVE MODULES ARE ABSENT.
// Requiring a native-only package there makes expo-modules-core log an
// error (redbox) even if we catch the throw — so we never even import
// ffmpeg-expo in Expo Go. Native builds (dev-client / APK) pass this.
function runningInExpoGo(): boolean {
  if (!expoGoChecked) {
    expoGoChecked = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Constants = require('expo-constants').default ?? require('expo-constants');
      isExpoGo = Constants?.executionEnvironment === 'storeClient';
    } catch {
      isExpoGo = false;
    }
  }
  return isExpoGo;
}

// ffmpeg-expo exposes sync getVersion() once the native side is
// linked — a real presence check (not just "JS wrapper exists").
function modulePresent(): boolean {
  if (!ffChecked) {
    ffChecked = true;
    if (runningInExpoGo()) {
      ffModule = null; // native module absent — never import, never redbox
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require('ffmpeg-expo');
        const v = m?.getVersion?.();
        if (!v || !v.version) {
          ffModule = null;
        } else {
          ffModule = m;
        }
      } catch {
        ffModule = null;
      }
    }
  }
  return !!ffModule;
}

// Sync check used by the create flow + download flow.
export function hasNativeFFmpeg(): boolean {
  return modulePresent();
}

export type ProcessOptions = {
  trim?: { start: number; end: number } | null;
  speed?: number | null;
  rotation?: number | null;
  filter?: string | null; // our filter id → mapped to an ffmpeg color-grading chain
  voiceoverUri?: string | null; // local audio file to mix into the video
  outputName?: string;
  /**
   * The viewfinder's retouch level (0 off, 1 soft, 2 strong). Kept separate
   * from `filter` on purpose: retouch is a camera setting, the editor's filter
   * carousel is an aesthetic choice, and a take can legitimately have both.
   */
  retouch?: 0 | 1 | 2 | null;
  /**
   * Target aspect ratio (width / height) picked in the camera, e.g. 9/16.
   * The sensor records in its native ratio, so this is what makes the Ratio
   * tool true: the exported file is centre-cropped to the frame the user
   * framed in. null / undefined keeps the full frame.
   */
  crop?: number | null;
};

// Our UI filter ids → approximate ffmpeg color/grading chains.
function filterToVf(filter: string | null | undefined): string | null {
  switch (filter) {
    case 'vibe':
      return 'colorbalance=rs=0.08:gs=0.02:bs=-0.06,eq=saturation=1.15';
    case 'midnight':
      return 'colorbalance=rs=-0.06:gs=-0.02:bs=0.12,eq=brightness=-0.05';
    case 'sunset':
      return 'colorbalance=rs=0.10:gs=-0.02:bs=-0.08';
    case 'mono':
      return 'hue=s=0,eq=contrast=1.05';
    case 'glow':
      return 'eq=brightness=0.04:saturation=1.2,unsharp=5:5:0.6';
    case 'vhs':
      return 'eq=saturation=1.3:contrast=1.1,hue=h=8';
    // Camera retouch. These two ids are not in the editor's filter carousel;
    // they exist so the viewfinder's Soft/Strong can be a promise the export
    // actually keeps instead of a veil over the preview.
    case 'retouch-soft':
      return 'eq=brightness=0.04:contrast=1.02:saturation=1.04';
    case 'retouch-strong':
      return 'eq=brightness=0.07:contrast=1.05:saturation=1.08,unsharp=3:3:0.4';
    default:
      return null;
  }
}

function cleanPath(p: string): string {
  return p.startsWith('file://') ? p.slice('file://'.length) : p;
}

// ============================================================
// Camera studio — photo filters
// ============================================================
// The ids here MUST match PHOTO_FILTERS in src/screens/CaptureScreen.tsx. They
// are baked into the captured JPEG, not painted over a preview: a photo carries
// its look with it into the composer, the upload, the feed.
//
// Only primitives this build is already proven to run (eq, colorbalance, hue,
// unsharp) are used. A missing filter fails the capture outright, so an exotic
// chain for a prettier name is not a trade worth making here.
export function photoFilterToVf(id: string | null | undefined): string | null {
  switch (id) {
    case 'natural':
      return 'eq=brightness=0.03:contrast=1.03:saturation=1.05';
    case 'warm':
      return 'colorbalance=rs=0.10:gs=0.02:bs=-0.10,eq=saturation=1.05';
    case 'cool':
      return 'colorbalance=rs=-0.08:gs=0.00:bs=0.10,eq=saturation=1.03';
    case 'vintage':
      return 'eq=saturation=0.72:contrast=0.94:brightness=0.05,colorbalance=rs=0.08:bs=-0.04';
    case 'cinematic':
      return 'eq=contrast=1.16:saturation=0.90:brightness=-0.03,colorbalance=rs=0.05:bs=0.07';
    case 'mono':
      return 'hue=s=0,eq=contrast=1.12';
    case 'glow':
      return 'eq=brightness=0.07:saturation=1.06,unsharp=7:7:-0.8';
    case 'vivid':
      return 'eq=saturation=1.35:contrast=1.10';
    case 'dreamy':
      return 'eq=brightness=0.06:saturation=1.12,colorbalance=rs=0.06:bs=0.08,unsharp=7:7:-0.5';
    default:
      return null;
  }
}

/**
 * Grades a captured JPEG to one of the camera studio looks and returns the new
 * file. 'normal' (or an unknown id) returns the original uri untouched — no
 * pointless re-encode, no quality loss for a no-op.
 */
export async function processPhotoFilter(
  uri: string,
  filterId: string | null | undefined
): Promise<string> {
  const vf = photoFilterToVf(filterId);
  if (!vf) return uri;
  if (!modulePresent()) throw new Error('video encoder unavailable');

  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-photo/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // exists
  }
  const out = `${dir}shot-${Date.now()}.jpg`;

  await exec(
    [
      '-y',
      '-i',
      cleanPath(uri),
      // yuvj420p is the full-range JPEG pixel format; without it the grade comes
      // back washed out on Android decoders
      '-vf',
      `${vf},format=yuvj420p`,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      cleanPath(out),
    ],
    60000
  );

  const meta = await probeMediaMeta(out);
  if (meta && !meta.hasVideo) throw new Error('encoder produced no image output');
  return out;
}

// ============================================================
// Reading an ffmpeg failure
// ============================================================
//
// ffmpeg writes its diagnostics in order and states the actual reason LAST. A
// failing run also emits hundreds of demuxer index traces at trace level, one
// per sample, roughly 100 characters each:
//
//   AVIndex stream 0, sample 12, offset 2e0bb, dts 16384, size 9113, ...
//
// The first version of this extracted every line matching /dts|pts|error|.../
// and then cut the result with slice(0, 3200). Those trace lines are all
// unique strings, so de-duplication kept every one of them, they filled the
// whole budget, and the actual failure was pushed off the end. The result was
// a "Download failed" dialog showing nothing but ~34 index samples and no
// reason at all - the real error was in the log, just past the cut.
//
// So: drop the known chatter, then put the TAIL first. Whatever else is lost,
// the line that explains the failure is inside the first screen of text.
const FFMPEG_NOISE =
  /^(AVIndex stream |type:|\s*dts shift |frame=\s|size=\s|\[out#\d+\/[^\]]*\]\s*video:|\s*$)/;

const FFMPEG_INTERESTING =
  /error|fail|invalid|corrupt|muxer|encod|decod|Conversion|monoton|dts|pts|buffer|overflow|Permission|No such|unable|cannot|broken|not found|unknown|unrecognized|unsupported/i;

function describeFfmpegFailure(logBuf: string[]): string {
  const clean = logBuf.filter((l) => !FFMPEG_NOISE.test(l));
  const source = clean.length ? clean : logBuf;
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (line: string) => {
    const key = line.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key.slice(0, 240));
  };
  // 1. the last lines, verbatim - this is where the fatal error lives
  source.slice(-12).forEach(push);
  // 2. every other diagnostic line, newest first, as supporting context
  source
    .filter((l) => FFMPEG_INTERESTING.test(l))
    .reverse()
    .forEach(push);
  return out.join('\n').slice(0, 1400);
}

// Keeps the whole log on the device so a failure is still diagnosable after the
// dialog is dismissed (the UI only ever shows an extract of it).
function dumpFfmpegLog(args: string[], logBuf: string[]): void {
  void (async () => {
    try {
      const fs: any = await import('expo-file-system/legacy');
      const uri = `${fs.cacheDirectory}genz-ffmpeg-last.log`;
      await fs.writeAsStringAsync(uri, `args: ${args.join(' ')}\n\n${logBuf.join('\n')}\n`);
      console.log(`[ffmpeg-expo] full log written to ${uri}`);
    } catch {
      // best effort only - diagnostics must never fail a command
    }
  })();
}

// Runs one ffmpeg command (args array — no shell involved, so paths
// with spaces/special chars are safe). Hard timeout + cancel so a
// wedged session can never leave the UI stuck. On failure the thrown
// Error includes ffmpeg's last log line so the UI can show WHY.
function exec(args: string[], timeoutMs = 120000): Promise<{ returnCode: number }> {
  const m = ffModule;
  if (!m) return Promise.reject(new Error('ffmpeg not available'));
  return new Promise((resolve, reject) => {
    let session: any;
    let settled = false;
    const logBuf: string[] = [];
    const tail = (n: number) => logBuf.slice(-n).join(' | ').slice(0, 900);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        session?.cancel?.();
      } catch {
        // ignore
      }
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    try {
      session = m.run(args, {
        logLevel: 'warning',
        onLog: (log: any) => {
          try {
            const line = String(log?.message ?? '');
            if (line.trim()) logBuf.push(line.trim().slice(0, 300));
          } catch {
            // ignore
          }
        },
      });
      session.result.then(
        (r: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (r && r.returnCode === 0) {
            console.log(`[ffmpeg-expo] ok code ${r.returnCode}`, tail(2));
            resolve(r);
          } else {
            // The FULL log goes to the device log; the UI receives a compact,
            // tail-first extract. See describeFfmpegFailure() for why the order
            // matters - a head-first slice showed 34 lines of demuxer index
            // traces and hid the reason entirely.
            console.log('[ffmpeg-expo] FAILED - full log:\n' + logBuf.join('\n'));
            dumpFfmpegLog(args, logBuf);
            const detail = describeFfmpegFailure(logBuf);
            reject(new Error(`ffmpeg failed (code ${r?.returnCode}):\n${detail || '(no log output)'}`));
          }
        },
        (e: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const msg = e instanceof Error ? e.message : String(e ?? 'ffmpeg error');
          reject(new Error(msg.slice(0, 400) || 'ffmpeg error'));
        }
      );
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('ffmpeg error'));
    }
  });
}

// Runs one command; returns the output uri on success, throws on error.
async function run(args: string[], out: string): Promise<string> {
  await exec(args);
  return out;
}

// Reads duration / width / stream presence from the ffmpeg header
// (container metadata) via a cancelled probe session.
async function probeMediaMeta(uri: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
} | null> {
  const m = ffModule;
  if (!m) return null;
  // Header-only read: `-i file` with NO output. ffmpeg prints the full input
  // dump (Duration + every stream) and exits non-zero ("no output file").
  // Nothing is DECODED, so missing filters (aresample), corrupt frames, or
  // broken timestamps can never break the probe — it only reads the header.
  const lines: string[] = [];
  let session: any;
  let settled = false;
  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        session?.cancel?.();
      } catch {
        // ignore
      }
      let dur: number | null = null;
      let width: number | null = null;
      let height: number | null = null;
      let hasVideo = false;
      let hasAudio = false;
      let videoCodec: string | null = null;
      let saw = false;
      for (const raw of lines) {
        const dm = raw.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (dur === null && dm) {
          dur = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + parseFloat(dm[3]);
          saw = true;
        }
        const isStream = /^Stream\s*#\d+:\d+/.test(raw);
        if (isStream && /:\s*Video:/.test(raw)) {
          hasVideo = true;
          saw = true;
          const cm = raw.match(/:\s*Video:\s*(\S+)/);
          if (videoCodec === null && cm) videoCodec = cm[1];
          const wm = raw.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
          if (width === null && wm) {
            width = Number(wm[1]);
            height = Number(wm[2]);
          }
        } else if (isStream && /:\s*Audio:/.test(raw)) {
          hasAudio = true;
          saw = true;
        }
      }
      if (!saw) {
        resolve(null); // unreadable / nothing parsed — caller must not block on it
        return;
      }
      resolve({
        durationSec: dur && !Number.isNaN(dur) && dur > 0 ? dur : NaN,
        width: width && width > 0 ? width : 0,
        height: height && height > 0 ? height : 0,
        hasVideo,
        hasAudio,
        videoCodec,
      });
    };
    const timer = setTimeout(finish, 6000);
    try {
      session = m.run(['-hide_banner', '-i', cleanPath(uri)], {
        logLevel: 'warning',
        onLog: (log: any) => {
          const msg = String(log?.message ?? '');
          if (msg.trim()) lines.push(msg.trim());
        },
      });
      session.result.then(finish, finish);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// Runs one command and hands back its log lines.
//
// exec() deliberately throws them away — its contract is success/failure. The
// cover scorer needs to READ the output, because that is where ffmpeg's
// signalstats filter prints the frame's average luma.
function execCapture(
  args: string[],
  timeoutMs = 20000
): Promise<{ returnCode: number; lines: string[] }> {
  const m = ffModule;
  if (!m) return Promise.reject(new Error('ffmpeg not available'));
  return new Promise((resolve, reject) => {
    let session: any;
    let settled = false;
    const lines: string[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        session?.cancel?.();
      } catch {
        // ignore
      }
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    try {
      // 'info', not 'warning': metadata=print emits at info level and would be
      // suppressed before it ever reached us.
      session = m.run(args, {
        logLevel: 'info',
        onLog: (log: any) => {
          try {
            const line = String(log?.message ?? '');
            if (line.trim()) lines.push(line.trim().slice(0, 300));
          } catch {
            // ignore
          }
        },
      });
      session.result.then(
        (r: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ returnCode: r?.returnCode ?? -1, lines });
        },
        (e: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error('ffmpeg error'));
        }
      );
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('ffmpeg error'));
    }
  });
}

// Average luma of a still, 0-255. NaN when this build has no signalstats —
// the caller treats that as "unmeasurable", not as "black".
async function lumaOf(jpgPath: string): Promise<number> {
  try {
    const { lines } = await execCapture([
      '-hide_banner',
      '-i',
      cleanPath(jpgPath),
      '-vf',
      'signalstats,metadata=print',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    for (const line of lines) {
      const hit = line.match(/signalstats\.YAVG=([\d.]+)/);
      if (hit) return parseFloat(hit[1]);
    }
  } catch {
    // no signalstats in this build, or a still ffmpeg would not decode
  }
  return NaN;
}

// Picks the best-looking frame of a local video as its cover — used whenever
// the creator has not chosen one, which is the normal case.
//
// The previous version took a single frame at a fixed 0.5s. On any clip that
// opens on black or a fade-in that produced a black cover tile, which is the
// reported "the cover is just black". This version follows the policy in
// utils/coverPicker.ts: scan several windows, let the `thumbnail` filter pick a
// representative frame inside each, then keep the one whose average luma is
// closest to well-exposed.
//
// Native builds only. The Expo Go path is a view-shot, handled by the caller.
export async function extractVideoCover(
  uri: string,
  outputName = 'cover',
  opts: { durationSec?: number } = {}
): Promise<string> {
  if (!modulePresent()) throw new Error('ffmpeg unavailable');
  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-edit/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // dir may already exist
  }

  let durationSec = opts.durationSec ?? 0;
  if (!durationSec) {
    // Header-only probe: cheap, and it cannot fail on a decode problem.
    const meta = await probeMediaMeta(uri).catch(() => null);
    durationSec = meta?.durationSec ?? 0;
  }

  const stamp = Date.now();
  const windows = coverWindows(durationSec);
  const cands: { at: number; path: string; yavg: number }[] = [];

  for (let i = 0; i < windows.length; i++) {
    const at = windows[i];
    const path = `${dir}${outputName}-${stamp}-${i}.jpg`;
    try {
      await exec(
        [
          '-y',
          // -ss before -i seeks the container instead of decoding up to the
          // point, which is the difference between fast and unusable here.
          '-ss',
          String(at),
          '-i',
          cleanPath(uri),
          '-vf',
          // 30 frames is ~1s of a normal clip: enough for the filter to judge
          // what is typical, short enough to stay quick on a phone.
          'thumbnail=30',
          '-frames:v',
          '1',
          '-q:v',
          '3',
          cleanPath(path),
        ],
        45000
      );
    } catch {
      continue; // a window ffmpeg cannot seek to is simply not a candidate
    }
    cands.push({ at, path, yavg: await lumaOf(path) });
  }

  if (!cands.length) {
    // Nothing decoded at all. Fall back to the old behaviour rather than throw:
    // a plain seek still beats a post with no cover image.
    const fallback = `${dir}${outputName}-${stamp}.jpg`;
    await exec(
      ['-y', '-ss', '0.5', '-i', cleanPath(uri), '-frames:v', '1', '-q:v', '3', cleanPath(fallback)],
      30000
    );
    return fallback;
  }

  const best = pickBestCover(cands) ?? cands[0];

  // The losing frames are temp files nobody will read.
  for (const c of cands) {
    if (c.path === best.path) continue;
    try {
      fs.deleteAsync(c.path, { idempotent: true });
    } catch {
      // cache dir; the OS reclaims it
    }
  }

  return best.path;
}

/**
 * Joins the segments of one recording session into a single file.
 *
 * The camera records in clips: you shoot, you stop, you shoot again. Each stop
 * leaves a complete mp4 behind, and a post is one video, so the pieces have to
 * become one file before the editor ever sees them.
 *
 * Stream copy first (`-c copy`): every segment came from the same camera in the
 * same session, so the codecs and parameters match and the join costs no
 * re-encode and no quality. If that fails — segments can differ in resolution
 * if the user flipped the camera mid-session — fall back to a re-encode so the
 * take is still delivered rather than lost.
 *
 * Returns null when there is nothing to join (0 or 1 clip): the caller already
 * has the file it wants and a pointless remux would only waste seconds.
 */
export async function concatClips(
  uris: string[],
  outputName = 'genz-clip'
): Promise<string | null> {
  if (uris.length === 0) return null;
  if (uris.length === 1) return uris[0];
  if (!modulePresent()) throw new Error('ffmpeg not available');

  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-clips/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // may already exist
  }

  // concat demuxer list. Paths are file:// uris from the camera; the demuxer
  // wants plain paths, and single quotes are escaped for it.
  const listPath = `${dir}list-${Date.now()}.txt`;
  const list = uris
    .map((u) => `file '${cleanPath(u).replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fs.writeAsStringAsync(listPath, `${list}\n`);

  const out = `${dir}${outputName}-${Date.now()}.mp4`;

  try {
    await exec(
      ['-y', '-f', 'concat', '-safe', '0', '-i', cleanPath(listPath), '-c', 'copy', cleanPath(out)],
      180000
    );
  } catch {
    // Different resolutions/codecs across segments: join by re-encoding.
    await exec(
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        cleanPath(listPath),
        '-c:v',
        'mpeg4',
        '-q:v',
        '4',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        cleanPath(out),
      ],
      240000
    );
  }

  return out;
}

// Encodes a NEW video file with trim/speed/rotation/filter/voiceover
// BAKED IN. Returns the output file uri. Throws if ffmpeg is
// unavailable or the command fails.
export async function processDropVideo(uri: string, opts: ProcessOptions): Promise<string> {
  if (!modulePresent()) throw new Error('ffmpeg not available');

  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-edit/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // dir may already exist
  }
  const out = `${dir}${opts.outputName ?? 'drop'}-${Date.now()}.mp4`;
  const input = cleanPath(uri);

  const args: string[] = ['-y', '-i', input];
  const vf: string[] = [];

  const hasAudioMix = !!opts.voiceoverUri;
  if (opts.voiceoverUri) args.push('-i', cleanPath(opts.voiceoverUri));

  // Retouch: the camera's Soft/Strong, as a real grade — not a veil that dies
  // when the preview closes.
  const retouchVf =
    opts.retouch === 1
      ? filterToVf('retouch-soft')
      : opts.retouch === 2
        ? filterToVf('retouch-strong')
        : null;

  // Crop to the ratio the user framed. The expressions are quoted because the
  // commas inside min() would otherwise be read as filter separators, and the
  // even-dims scale is there because mpeg4 refuses odd frame sizes.
  const cropVf =
    opts.crop && opts.crop > 0
      ? `crop='min(iw,ih*${opts.crop.toFixed(6)})':'min(ih,iw/${opts.crop.toFixed(6)})',` +
        `scale='trunc(iw/2)*2':'trunc(ih/2)*2'`
      : null;

  const hasVisualEdits =
    (opts.speed && opts.speed !== 1) ||
    !!opts.rotation ||
    !!filterToVf(opts.filter) ||
    !!retouchVf ||
    !!cropVf;

  // trim
  if (opts.trim && opts.trim.end > opts.trim.start) {
    args.push('-ss', String(opts.trim.start), '-to', String(opts.trim.end));
  }

  // speed
  if (opts.speed && opts.speed !== 1) {
    vf.push(`setpts=${(1 / opts.speed).toFixed(4)}*PTS`);
  }

  // rotation
  if (opts.rotation) {
    const r = ((opts.rotation % 360) + 360) % 360;
    if (r === 90) vf.push('transpose=1');
    else if (r === 180) vf.push('transpose=1,transpose=1');
    else if (r === 270) vf.push('transpose=2');
  }

  // ratio crop — after any rotation, so it crops the upright frame
  if (cropVf) vf.push(cropVf);

  // filter
  const f = filterToVf(opts.filter);
  if (f) vf.push(f);

  // retouch, on top of the chosen look
  if (retouchVf) vf.push(retouchVf);

  const pureTrim = !hasVisualEdits && !hasAudioMix;

  try {
    if (pureTrim) {
      // fast lossless trim — no re-encode
      await run([...args, '-c', 'copy', cleanPath(out)], out);
    } else {
      // re-encode path. ffmpeg-expo ships LGPL-only binaries (no libx264),
      // so use the universal mpeg4 encoder + aac.
      const encArgs: string[] = [...args];
      if (hasAudioMix) {
        // mix voiceover over the video audio
        encArgs.push(
          '-filter_complex',
          `[0:v:0]${vf.length ? `${vf.join(',')},` : ''}format=yuv420p[vout];[0:a?][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
          '-map',
          '[vout]',
          '-map',
          '[aout]'
        );
      } else {
        if (vf.length) encArgs.push('-vf', `${vf.join(',')},format=yuv420p`);
        encArgs.push('-map', '0:v:0', '-map', '0:a?');
      }
      encArgs.push('-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
      await run(encArgs, out);
    }
  } catch (e) {
    // clean up partial output
    try {
      await fs.deleteAsync(out, { idempotent: true });
    } catch {
      // ignore
    }
    throw e;
  }

  return out;
}

// ============================================================
// ============================================================
// Capability probe — ask THIS phone's binary, do not assume
// ============================================================
//
// The plan ladder below used to be written against a belief about what the
// shipped libavfilter contains ("it has aresample, it lacks amix"). A device
// report proved that belief wrong: ffmpeg said `'aresample' filter not present`
// on a build we had documented as having it. Every plan then failed for a
// reason the ladder could not see, and the user got an unbranded video with a
// wall of demuxer output.
//
// `-filters` is cheap (no input, no encode), prints one line per filter, and
// answers the question authoritatively. Cached for the process lifetime: the
// binary cannot change under us between two downloads.
type Capabilities = { filters: Set<string> };

let capsPromise: Promise<Capabilities | null> | null = null;

async function probeCapabilities(): Promise<Capabilities | null> {
  if (capsPromise) return capsPromise;
  capsPromise = (async (): Promise<Capabilities | null> => {
    const m = ffModule;
    if (!m) return null;
    try {
      const lines: string[] = [];
      const session = m.run(['-hide_banner', '-filters'], {
        logLevel: 'info',
        onLog: (log: any) => {
          const line = String(log?.message ?? '');
          if (line.trim()) lines.push(line);
        },
      });
      const r = await session.result;
      if (!r || r.returnCode !== 0) {
        console.warn('[bakeVideo] capability probe returned', r?.returnCode);
        return null;
      }
      const filters = new Set<string>();
      for (const line of lines) {
        // " ... overlay           VV->V   Overlay a video source on top of ..."
        // three flag chars, then the name
        const match = /^\s*[TSC.]{3}\s+([A-Za-z0-9_]+)\s+/.exec(line);
        if (match) filters.add(match[1]);
      }
      console.log(`[bakeVideo] probe: ${filters.size} filters`);
      return filters.size ? { filters } : null;
    } catch (e: any) {
      console.warn('[bakeVideo] capability probe failed:', e?.message);
      return null;
    }
  })();
  return capsPromise;
}

// Download-to-gallery bakes (TikTok-style): corner GENZ watermark
// (+ GENZ jingle outro on videos). The ORIGINAL file is never
// modified — a watermarked COPY is produced and saved.
// ============================================================

// Resolve a bundled asset (require(...)) to a real file path on disk.
export async function bundledAssetPath(moduleRef: number): Promise<string | null> {
  try {
    const { Asset } = require('expo-asset');
    const a = Asset.fromModule(moduleRef);
    if (a.localUri) return a.localUri;
    await a.downloadAsync();
    return a.localUri ?? a.uri ?? null;
  } catch {
    return null;
  }
}

// Bundled watermark wordmark + jingle
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WM_SRC = require('../../assets/wm-genz.png');
// The jingle MUST be AAC (.m4a), not WAV: the phone's slim ffmpeg build has
// no 'aresample' filter, and AAC's float format can't be produced from a
// WAV's integer PCM without it. AAC→AAC needs zero conversion.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JINGLE_SRC = require('../../assets/genz_jingle.m4a');

// Download file names like GenZ_2026-09-07_0810 (local date + HHmm)
function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `GenZ_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function downloadBakeReady(): boolean {
  return modulePresent();
}

const JINGLE_SEC = 2.4; // length of the bundled genz_jingle.m4a

// Bakes the corner GENZ watermark into a photo copy (original resolution).
// watermarkUri: optional local "GEN Z @creator" pill (captured in-app).
// Returns the output jpg uri. Throws on failure.
export async function bakePhotoWatermark(
  inputUri: string,
  watermarkUri?: string | null
): Promise<string> {
  if (!modulePresent()) throw new Error('video encoder unavailable');
  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-download/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // exists
  }
  const out = `${dir}${stampName()}.jpg`;
  const wm = watermarkUri || (await bundledAssetPath(WM_SRC as any));
  if (!wm) throw new Error('brand assets unavailable');

  const meta = await probeMediaMeta(inputUri);
  const iw = meta?.width && meta.width > 0 ? meta.width : 1080;
  const wmW = Math.max(120, Math.round((iw * 0.22) / 2) * 2);

  console.log(`[bakePhoto] in=${inputUri} wmW=${wmW} probe=${JSON.stringify(meta)}`);
  await exec(
    [
      '-y',
      '-i', cleanPath(inputUri),
      '-i', cleanPath(wm),
      '-filter_complex',
      `[1:v]scale=${wmW}:-1[wm];[0:v][wm]overlay=W-w-14:H-h-14,format=yuv420p[vout]`,
      '-map',
      '[vout]',
      '-frames:v', '1',
      '-q:v', '2',
      cleanPath(out),
    ],
    60000
  );
  const outMeta = await probeMediaMeta(out);
  console.log(`[bakePhoto] out probe=${JSON.stringify(outMeta)}`);
  if (outMeta && !outMeta.hasVideo) {
    throw new Error('encoder produced no image output — please report this');
  }
  return out;
}

// A watermark image ffmpeg cannot read would fail EVERY attempt that uses it,
// and each failed attempt costs the user real time, so it is verified before it
// is trusted: the captured "GEN Z @creator" pill first, the bundled wordmark
// second, and - when neither can be read - no watermark at all rather than a
// download that never finishes.
async function resolveWatermark(watermarkUri?: string | null): Promise<string | null> {
  const candidates = [watermarkUri, await bundledAssetPath(WM_SRC as any)];
  for (const c of candidates) {
    if (!c) continue;
    const meta = await probeMediaMeta(c);
    if (meta?.hasVideo && meta.width > 0) return c;
    console.warn(`[bakeVideo] watermark unusable (${c}): ${JSON.stringify(meta)}`);
  }
  return null;
}

export type BakeOutcome = {
  uri: string;
  /** the corner GEN Z mark actually made it into the pixels */
  watermarked: boolean;
  /** the GEN Z jingle made it onto the audio track */
  jingled: boolean;
  /**
   * Which plan produced the file, and — when branding is missing — why the
   * better plans failed.
   *
   * This exists because "Saved without the GEN Z mark" was the only thing the
   * user was ever told. The bake walks a ladder and the interesting information
   * (which step failed, and ffmpeg's own reason) was only ever written to
   * logcat, which is unreachable on a release build. Surfacing it is the only
   * way a device report can be diagnosed without a debug session.
   */
  plan: string;
  reason?: string;
};

/**
 * Bakes watermark (+ music + jingle outro) into a NEW video file.
 * inputUri: local video file. musicUri: optional LOCAL audio (attached sound).
 * watermarkUri: optional LOCAL overlay image ("GEN Z @creator" pill captured
 * in-app); falls back to the bundled wordmark when omitted.
 *
 * Returns the output uri AND whether the GEN Z mark actually made it in - the
 * plans below end with paths that cannot draw the mark, and the caller has to
 * be able to say so rather than claim a branded save.
 *
 * Throws only when every plan failed, which - with a plain remux at the end -
 * means the input file itself is unreadable.
 */
export async function bakeDownloadVideo(
  inputUri: string,
  musicUri: string | null,
  durationSec?: number | null,
  watermarkUri?: string | null
): Promise<BakeOutcome> {
  if (!modulePresent()) throw new Error('video encoder unavailable');
  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-download/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // exists
  }
  const out = `${dir}${stampName()}.mp4`;

  const meta = await probeMediaMeta(inputUri);
  // Neither brand asset is required any more: a missing jingle only removes the
  // outro and a missing (or unreadable) watermark only removes the corner pill.
  // Neither is a good reason to refuse the download the user asked for.
  const wm = await resolveWatermark(watermarkUri);
  const jingle = await bundledAssetPath(JINGLE_SRC as any);

  // What this binary can ACTUALLY do. Null means the probe could not run, in
  // which case every filter is assumed present and behaviour is unchanged —
  // an unprobed device must not lose features to a failed diagnostic.
  const caps = await probeCapabilities();
  const hasFilter = (name: string) => (caps ? caps.filters.has(name) : true);
  const missing: string[] = [];
  const need = (name: string) => {
    if (hasFilter(name)) return true;
    if (!missing.includes(name)) missing.push(name);
    return false;
  };
  /** true when this device has every filter the mode asks for */
  const modeUsable = (mode: AudioMode): boolean => {
    if (mode === 'mix-music' || mode === 'mix-orig') return need('amix') && need('aformat');
    if (mode === 'jingle-concat') return need('concat') && need('aformat') && need('atrim');
    return true; // 'orig' / 'music' / 'jingle' map an existing stream: no filter
  };
  const durSec =
    durationSec && durationSec > 0
      ? durationSec
      : meta?.durationSec && !Number.isNaN(meta.durationSec)
        ? meta.durationSec
        : 30;
  // watermark ≈ 22% of the video width (TikTok-corner scale), keep even
  const vw = meta?.width && meta.width > 0 ? meta.width : 1080;
  const vh = meta?.height && meta.height > 0 ? meta.height : 0;
  const wmW = Math.max(120, Math.round((vw * 0.22) / 2) * 2);
  // mpeg4 + yuv420p refuse odd dimensions ("width not divisible by 2"), which a
  // cropped or screen-recorded source can easily have. Costs nothing unless the
  // probe actually reports an odd side.
  const evenFix = vh > 0 && (vw % 2 !== 0 || vh % 2 !== 0);
  // start the jingle so it fully plays inside the video (no tail cut)
  const jingleDelaySec = Math.max(0, durSec - JINGLE_SEC - 0.2);

  // inputs: [0]=video [1]=watermark [+music]. The jingle is delayed with
  // the -itsoffset INPUT option (the phone's ffmpeg build has NO adelay
  // filter), so it plays during the outro window at the end.
  // -fflags +genpts regenerates timestamps (odd downloaded files can carry
  // broken PTS that made the slim build's muxer choke mid-encode).
  // ---- audio ladder ----------------------------------------------------
  //
  // The slim on-device ffmpeg can lack adelay/anullsrc/amix entirely, so a
  // mixing mode is tried first and the ladder degrades to modes that need NO
  // audio filters at all. Every fallback preserves SOME audio: a video that had
  // sound never comes back silent, and a missing filter never kills the
  // download.
  type AudioMode = 'mix-music' | 'mix-orig' | 'music' | 'orig' | 'jingle' | 'jingle-concat';

  const hasOrigAudio = meta?.hasAudio !== false;
  const mixMode: AudioMode | null = musicUri ? 'mix-music' : hasOrigAudio ? 'mix-orig' : null;
  const plainMode: AudioMode | null = musicUri ? 'music' : hasOrigAudio ? 'orig' : null;
  // ORDER MATTERS, AND IT IS NOT JUST "BEST FIRST".
  //
  // The on-device ffmpeg is a deliberate whitelist. Verified by reading the
  // filter names out of the shipped libavfilter: it HAS overlay, scale, format,
  // aformat, atrim, concat, volume and aresample, and it does NOT have amix,
  // adelay, asetpts, anullsrc, pad, movie or drawtext.
  //
  // That single fact explains the reported bug. amix was the only way the jingle
  // was ever added, so every plan that carried a mix mode died on a filter that
  // does not exist here — and because the degraded plans reused the same mix
  // mode (bestAudio below), THEY died too, all the way down to the filter-free
  // remux. The result was a saved file with no watermark AND no jingle, which is
  // exactly what the user saw. The watermark never failed on its own merits.
  //
  // So the ladder now offers a jingle path built only from filters this build
  // actually has ('jingle-concat': original audio, then the jingle as an outro,
  // joined with concat), and the degraded plans pick a mode that needs no
  // mixing at all.
  const audioLadder: AudioMode[] = [];
  if (jingle) {
    // true mixing: keeps the creator's sound running under the jingle. Only
    // works on a build with amix, but it is the nicest result when it does.
    if (mixMode) audioLadder.push(mixMode);
    // original sound, then the jingle as an outro — no mixer required
    if (hasOrigAudio) audioLadder.push('jingle-concat');
    // last resorts that still carry SOME audio
    if (plainMode) audioLadder.push(plainMode);
    audioLadder.push('jingle');
  } else if (plainMode) {
    audioLadder.push(plainMode);
  }
  const bestAudio: AudioMode[] = audioLadder.length ? [audioLadder[0]] : [];
  // What the DEGRADED plans should use. Deliberately the best mode that needs no
  // mixer: these plans exist to rescue a download, so giving them a mode that
  // cannot work on this build would defeat their entire purpose.
  const noMix = audioLadder.filter((m) => m !== 'mix-music' && m !== 'mix-orig');
  const bestNoMix: AudioMode[] = noMix.length ? [noMix[0]] : [];

  // ---- plans -----------------------------------------------------------
  //
  // WHY PLANS AND NOT JUST THE AUDIO LADDER
  //
  // The previous version varied the AUDIO side only. The inputs, -fflags
  // +genpts, the -itsoffset on the jingle, the scale/overlay chain, the mpeg4
  // arguments and +faststart were byte-identical in every attempt - so a
  // failure anywhere in that shared half failed all of them, and the user got a
  // single error with no way to tell which part was at fault. That is exactly
  // what happened: "Download failed", code 2, reason invisible.
  //
  // These plans vary the shared half, one suspect at a time, and end with a
  // path that cannot fail on a codec or a filter: a plain remux. Only the last
  // two skip the watermark, and they report that so the UI can say so.
  type Plan = {
    label: string;
    audio: AudioMode[];
    /** -fflags +genpts (regenerates timestamps) */
    genpts: boolean;
    /** delay the jingle into the outro window with -itsoffset */
    jingleOffset: boolean;
    faststart: boolean;
    /** draw the corner watermark - requires `wm` */
    overlay: boolean;
    /** false = stream copy: no filters, no encoder, no overlay */
    reencode: boolean;
    /**
     * Use the smallest possible filtergraph: one overlay, no scale, no
     * pix_fmt conversion, no audio filters at all (the original audio is
     * stream-copied).
     *
     * The reported failure is that EVERY re-encoding plan failed on a real
     * device while the filter-free remux succeeded - i.e. the problem is the
     * filtergraph machinery, not the codecs. This plan is the cheapest thing
     * that can still burn in the mark, so if the phone's ffmpeg can run any
     * filtergraph at all, this one has the best chance. It gives up the jingle
     * (mixing audio needs amix), which is a fair trade: the mark is the part
     * that identifies where the video came from.
     */
    minimal?: boolean;
  };

  const full: Plan = {
    label: 'watermark+jingle',
    audio: audioLadder,
    genpts: true,
    jingleOffset: true,
    faststart: true,
    overlay: true,
    reencode: true,
  };

  const plans: Plan[] = [];
  if (jingle) {
    plans.push(full);
    // The safety net for the watermark. Ordered straight after the full plan:
    // if the rich graph cannot run on this device, we would rather save a
    // marked video with its own sound than a pristine unbranded one.
    if (wm) {
      plans.push({
        ...full,
        label: 'minimal-overlay',
        audio: [],
        genpts: false,
        jingleOffset: false,
        faststart: false,
        minimal: true,
      });
    }
    // The jingle is the one input whose timestamps start late, and an mp4 muxer
    // can reject that as non-monotonic - so retry with the jingle at t=0.
    plans.push({ ...full, label: 'no-jingle-delay', audio: bestNoMix, jingleOffset: false });
    // Timestamps exactly as the demuxer produced them, and no header rewrite
    // (+faststart) at the end.
    plans.push({
      ...full,
      label: 'plain-timestamps',
      audio: bestNoMix,
      jingleOffset: false,
      genpts: false,
      faststart: false,
    });
  } else if (audioLadder.length) {
    plans.push({ ...full, label: 'no-jingle', jingleOffset: false, genpts: false, faststart: false });
  }
  if (wm && audioLadder.length) {
    // Isolates "the overlay chain, or the watermark image itself, is the problem"
    plans.push({
      ...full,
      label: 'no-watermark',
      audio: bestNoMix,
      jingleOffset: false,
      genpts: false,
      faststart: false,
      overlay: false,
    });
  }
  // The reason "Download failed" can no longer be the only outcome: copy the
  // streams as they are. No filters, no encoder, no overlay.
  plans.push({
    label: 'remux-copy',
    audio: [],
    genpts: false,
    jingleOffset: false,
    faststart: false,
    overlay: false,
    reencode: false,
  });

  // Builds the argv for one plan + audio mode.
  //
  // Input indices are COMPUTED, not hardcoded: dropping the watermark input
  // shifts the jingle from index 2 to index 1, and a filtergraph that refers to
  // the wrong stream fails in a way that looks nothing like the real cause.
  const attempt = (plan: Plan, mode: AudioMode | null): string[] => {
    const useWm = plan.overlay && !!wm;
    const wantsJingle =
      !!jingle &&
      (mode === 'mix-music' ||
        mode === 'mix-orig' ||
        mode === 'jingle' ||
        mode === 'jingle-concat');
    const wantsMusic = !!musicUri && mode === 'mix-music';

    const args: string[] = ['-y'];
    // -fflags +genpts regenerates timestamps (odd downloaded files can carry
    // broken PTS that made the slim build's muxer choke mid-encode).
    if (plan.genpts) args.push('-fflags', '+genpts');
    args.push('-i', cleanPath(inputUri));

    let nextIdx = 1;
    const wmIdx = useWm ? nextIdx++ : -1;
    if (useWm) args.push('-i', cleanPath(wm as string));
    const jingleIdx = wantsJingle ? nextIdx++ : -1;
    if (wantsJingle) {
      // The phone's ffmpeg build has NO adelay filter, so the jingle is delayed
      // with the -itsoffset INPUT option and plays during the outro window.
      if (plan.jingleOffset) args.push('-itsoffset', jingleDelaySec.toFixed(3));
      args.push('-i', cleanPath(jingle as string));
    }
    const musicIdx = wantsMusic ? nextIdx++ : -1;
    if (wantsMusic) {
      // loop the sound and trim it to the video length via the -t input option
      // (the build may not include atrim/asetpts)
      args.push('-stream_loop', '-1', '-t', String(Math.round(durSec)), '-i', cleanPath(musicUri as string));
    }

    if (!plan.reencode) {
      args.push('-map', '0:v:0', '-map', '0:a?', '-c', 'copy', cleanPath(out));
      return args;
    }

    // ---- minimal graph: one overlay, nothing else -------------------------
    //
    // No scale on the watermark (the PNG is already sized for this), no
    // format=pix_fmts conversion, no audio filters, and the audio is copied
    // rather than re-encoded. Every failure mode the full graph has that is not
    // literally "overlay two video streams" is designed out.
    if (plan.minimal && useWm) {
      return [
        '-y',
        '-i', cleanPath(inputUri),
        '-i', cleanPath(wm as string),
        '-filter_complex', `[0:v][1:v]overlay=x=W-w-14:y=H-h-14[vout]`,
        '-map', '[vout]',
        '-map', '0:a?',
        '-c:v', 'mpeg4', '-q:v', '4',
        // stream copy: the creator's own audio survives untouched, and no audio
        // filter or encoder is invoked at all
        '-c:a', 'copy',
        '-t', durSec.toFixed(3),
        cleanPath(out),
      ];
    }

    const fc: string[] = [];
    const baseLabel = evenFix ? '[base]' : '[0:v]';
    if (evenFix) fc.push('[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[base]');
    if (useWm) {
      fc.push(`[${wmIdx}:v]scale=w=${wmW}:h=-1[wm]`);
      // corner watermark, bottom-right, fade-in after 0.4s
      fc.push(`${baseLabel}[wm]overlay=x=W-w-14:y=H-h-14:enable='gte(t,0.4)',format=pix_fmts=yuv420p[vout]`);
    } else {
      fc.push(`${baseLabel}format=pix_fmts=yuv420p[vout]`);
    }

    // Audio inputs are normalized to 44100 Hz mono BEFORE amix: amix refuses
    // mismatched sample rates and layouts, and phone videos are usually 48 kHz
    // stereo while the jingle is 44.1 kHz mono.
    const A = 'aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono';
    // The jingle as an OUTRO, joined with concat — the only way to get a jingle
    // onto a build with no amix.
    //
    // Trade-off, stated plainly: concat plays the segments one after the other,
    // so the creator's own audio stops for the final JINGLE_SEC instead of
    // running underneath the jingle. The alternative on this build is no jingle
    // at all.
    //
    // Only atrim + aformat + concat are used, all three verified present on the
    // device build.
    const jingleTail = Math.max(0.5, durSec - JINGLE_SEC);
    let audioMap: string | null = null;
    if (mode === 'jingle-concat') {
      fc.push(`[0:a]${A},atrim=0:${jingleTail.toFixed(3)}[orig]`);
      fc.push(`[${jingleIdx}:a]${A}[jing]`);
      fc.push('[orig][jing]concat=n=2:v=0:a=1[aout]');
      audioMap = '[aout]';
    } else if (mode === 'mix-music' || mode === 'mix-orig') {
      fc.push(`${mode === 'mix-music' ? `[${musicIdx}:a]` : '[0:a]'}${A}[mix0]`);
      fc.push(`[${jingleIdx}:a]${A}[jing]`);
      fc.push('[mix0][jing]amix=inputs=2:duration=first[aout]');
      audioMap = '[aout]';
    } else if (mode === 'music') {
      audioMap = `${musicIdx}:a`;
    } else if (mode === 'orig') {
      audioMap = '0:a';
    } else if (mode === 'jingle') {
      audioMap = `${jingleIdx}:a`;
    }

    args.push('-filter_complex', fc.join(';'));
    args.push('-map', '[vout]');
    if (audioMap) args.push('-map', audioMap);
    // ffmpeg-expo LGPL binaries: no libx264, so universal mpeg4 + aac.
    args.push('-c:v', 'mpeg4', '-q:v', '4');
    if (audioMap) args.push('-c:a', 'aac', '-b:a', '128k');
    if (plan.faststart) args.push('-movflags', '+faststart');
    // No -shortest: with a late-starting audio stream (-itsoffset) the slim
    // build's -shortest bookkeeping failed mid-encode. The app measures the
    // video duration directly, so an explicit -t cap is exact and safe.
    args.push('-t', durSec.toFixed(3));
    args.push(cleanPath(out));
    return args;
  };


  let lastErr: Error | null = null;
  let watermarked = false;
  let jingled = false;
  let wonPlan = '';
  // One line per failed plan, kept so the user (and I) can see exactly which
  // part of the pipeline this device refuses.
  const attempts: string[] = [];
  let done = false;
  // A time budget, not an open-ended ladder: once it is spent the remaining
  // re-encode plans are skipped and the remux at the end still runs, so nobody
  // is left watching a spinner for ten minutes.
  const deadline = Date.now() + 300000;

  for (const plan of plans) {
    // An overlay plan on a binary with no `overlay` filter is a guaranteed
    // failure with a confusing message. Skip it and say why.
    if (plan.overlay && !need('overlay')) {
      attempts.push(`${plan.label}: skipped - this build has no 'overlay' filter`);
      continue;
    }
    const usableModes = plan.audio.filter(modeUsable);
    if (plan.audio.length && usableModes.length === 0) {
      attempts.push(`${plan.label}: skipped - none of its audio filters exist here`);
      continue;
    }
    const modes: (AudioMode | null)[] = plan.audio.length ? usableModes : [null];
    for (const mode of modes) {
      if (plan.reencode && Date.now() > deadline) {
        console.warn(`[bakeVideo] skipping plan ${plan.label} - out of time budget`);
        continue;
      }
      const args = attempt(plan, mode);
      console.log(
        `[bakeVideo] plan=${plan.label} audio=${mode ?? '-'} in=${inputUri} music=${!!musicUri} wm=${!!wm} dur=${durSec} vw=${vw}x${vh} genpts=${plan.genpts} offset=${plan.jingleOffset}`
      );
      try {
        // The first attempt gets the most room: it is the only one that pays
        // for a full re-encode on a cold device.
        await exec(args, plan.reencode ? (lastErr ? 90000 : 150000) : 60000);
        watermarked = plan.overlay && !!wm;
        // the jingle is in the output only when this plan actually asked for it
        jingled =
          !!jingle &&
          (mode === 'mix-music' ||
            mode === 'mix-orig' ||
            mode === 'jingle' ||
            mode === 'jingle-concat');
        wonPlan = plan.label;
        done = true;
        break;
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        attempts.push(`${plan.label}: ${lastErr.message}`);
        console.warn(`[bakeVideo] plan=${plan.label} audio=${mode ?? '-'} failed: ${lastErr.message}`);
        // A half-written file from a failed plan must never be mistaken for the
        // next attempt's output.
        try {
          await fs.deleteAsync(out, { idempotent: true });
        } catch {
          // ignore
        }
      }
    }
    if (done) break;
  }
  if (!done) {
    console.error('[bakeVideo] every plan failed:', lastErr?.message);
    throw lastErr ?? new Error('video bake failed');
  }

  // Sanity: the baked file MUST contain a video stream. If the encoder silently
  // dropped video (audio-only output), say so loudly rather than saving a file
  // the user cannot play.
  const outMeta = await probeMediaMeta(out);
  let outBytes = 0;
  try {
    const info = await fs.getInfoAsync(out);
    outBytes = info?.size ?? 0;
  } catch {
    // ignore
  }
  console.log(
    `[bakeVideo] out probe=${JSON.stringify(outMeta)} bytes=${outBytes} watermarked=${watermarked}`
  );
  if (outMeta && !outMeta.hasVideo) {
    try {
      await fs.deleteAsync(out, { idempotent: true });
    } catch {
      // ignore
    }
    throw new Error('The encoder produced a file without video — please report this (code 2)');
  }
  return {
    uri: out,
    watermarked,
    jingled,
    plan: wonPlan,
    // Only populated when something is missing, and kept short enough to read
    // in an alert: the whole point is that the next report names the culprit.
    reason: watermarked && jingled
      ? undefined
      : [
          watermarked ? null : 'the corner mark',
          jingled ? null : 'the jingle',
        ]
          .filter(Boolean)
          .join(' and ') +
        ' could not be added on this phone — ' +
        // A missing filter is the CAUSE, so it leads. The attempt list is
        // supporting detail and is capped hard: the old version pasted three
        // full ffmpeg logs into a dialog.
        // Order is by how far upstream the cause sits. If `!wm` the mark was
        // never in the command at all — resolveWatermark discarded it because
        // this binary could not read the image — so blaming a filter would be
        // a lie even when filters are also missing.
        (!wm
          ? 'this build of ffmpeg could not read the watermark image, so no mark was attempted'
          : missing.length
          ? `this build of ffmpeg has no ${missing.map((f) => `'${f}'`).join(', ')} filter, so the branded copy cannot be produced here`
          : attempts.length
          ? attempts.slice(0, 2).join(' | ')
          : 'no encoder available'),
  };
}
