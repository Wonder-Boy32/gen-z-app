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
    default:
      return null;
  }
}

function cleanPath(p: string): string {
  return p.startsWith('file://') ? p.slice('file://'.length) : p;
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

// Extracts a cover frame (0.5s in) from a local video — used to auto-fill
// the profile tile when the creator didn't pick a cover. Native builds only.
export async function extractVideoCover(uri: string, outputName = 'cover'): Promise<string> {
  if (!modulePresent()) throw new Error('ffmpeg unavailable');
  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}drop-edit/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // dir may already exist
  }
  const out = `${dir}${outputName}-${Date.now()}.jpg`;
  await exec(['-y', '-ss', '0.5', '-i', cleanPath(uri), '-frames:v', '1', '-q:v', '3', cleanPath(out)], 30000);
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

  const hasVisualEdits = (opts.speed && opts.speed !== 1) || !!opts.rotation || !!filterToVf(opts.filter);

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

  // filter
  const f = filterToVf(opts.filter);
  if (f) vf.push(f);

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

export type BakeOutcome = { uri: string; watermarked: boolean };

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
  type AudioMode = 'mix-music' | 'mix-orig' | 'music' | 'orig' | 'jingle';

  const hasOrigAudio = meta?.hasAudio !== false;
  const mixMode: AudioMode | null = musicUri ? 'mix-music' : hasOrigAudio ? 'mix-orig' : null;
  const plainMode: AudioMode | null = musicUri ? 'music' : hasOrigAudio ? 'orig' : null;
  const audioLadder: AudioMode[] = [];
  if (jingle) {
    if (mixMode) audioLadder.push(mixMode);
    if (plainMode) audioLadder.push(plainMode);
    audioLadder.push('jingle');
  } else if (plainMode) {
    audioLadder.push(plainMode);
  }
  const bestAudio: AudioMode[] = audioLadder.length ? [audioLadder[0]] : [];

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
    // The jingle is the one input whose timestamps start late, and an mp4 muxer
    // can reject that as non-monotonic - so retry with the jingle at t=0.
    plans.push({ ...full, label: 'no-jingle-delay', audio: bestAudio, jingleOffset: false });
    // Timestamps exactly as the demuxer produced them, and no header rewrite
    // (+faststart) at the end.
    plans.push({
      ...full,
      label: 'plain-timestamps',
      audio: bestAudio,
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
      audio: bestAudio,
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
      !!jingle && (mode === 'mix-music' || mode === 'mix-orig' || mode === 'jingle');
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
    let audioMap: string | null = null;
    if (mode === 'mix-music' || mode === 'mix-orig') {
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
  let done = false;
  // A time budget, not an open-ended ladder: once it is spent the remaining
  // re-encode plans are skipped and the remux at the end still runs, so nobody
  // is left watching a spinner for ten minutes.
  const deadline = Date.now() + 300000;

  for (const plan of plans) {
    const modes: (AudioMode | null)[] = plan.audio.length ? plan.audio : [null];
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
        done = true;
        break;
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
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
  return { uri: out, watermarked };
}
