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
            // Dump the FULL ffmpeg log (info-level, no red LogBox): the real
            // error line is printed BEFORE the per-input statistics block, so
            // short tails keep hiding it. Metro console shows everything.
            console.log('[ffmpeg-expo] FAILED — full log:\n' + logBuf.join('\n'));
            // The red LogBox block truncates long text, and the option-parsing
            // preamble alone eats that budget — so embed a COMPACT extraction:
            // diagnostic lines (errors, muxer/encoder/decoder/stream issues)
            // plus the last raw lines for context.
            const diag = logBuf.filter((l) =>
              /error|fail|invalid|corrupt|muxer|encod|decod|Conversion|monoton|dts|pts|buffer|overflow|space|Permission|No such|unable|cannot|broken/i.test(l)
            );
            const compact = [...diag, ...logBuf.slice(-6)]
              .filter((v, i, a) => a.indexOf(v) === i)
              .join('\n')
              .slice(0, 3200);
            reject(new Error(`ffmpeg failed (code ${r?.returnCode}):\n${compact || logBuf.slice(-12).join('\n')}`));
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
          if (width === null && wm) width = Number(wm[1]);
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

/**
 * Bakes watermark (+ music + jingle outro) into a NEW video file.
 * inputUri: local video file. musicUri: optional LOCAL audio (attached sound).
 * watermarkUri: optional LOCAL overlay image ("GEN Z @creator" pill captured
 * in-app); falls back to the bundled wordmark when omitted.
 * Returns the output file uri. Throws on any failure.
 */
export async function bakeDownloadVideo(
  inputUri: string,
  musicUri: string | null,
  durationSec?: number | null,
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
  const out = `${dir}${stampName()}.mp4`;

  // "GEN Z @creator" pill captured in-app takes priority over the bundled
  // wordmark (the pill carries the creator's handle).
  const wm = watermarkUri || (await bundledAssetPath(WM_SRC as any));
  const jingle = await bundledAssetPath(JINGLE_SRC as any);
  if (!wm || !jingle) throw new Error('brand assets unavailable');

  const meta = await probeMediaMeta(inputUri);
  const durSec =
    durationSec && durationSec > 0
      ? durationSec
      : meta?.durationSec && !Number.isNaN(meta.durationSec)
        ? meta.durationSec
        : 30;
  // watermark ≈ 22% of the video width (TikTok-corner scale), keep even
  const vw = meta?.width && meta.width > 0 ? meta.width : 1080;
  const wmW = Math.max(120, Math.round((vw * 0.22) / 2) * 2);
  // start the jingle so it fully plays inside the video (no tail cut)
  const jingleDelaySec = Math.max(0, durSec - JINGLE_SEC - 0.2);

  // inputs: [0]=video [1]=watermark [+music]. The jingle is delayed with
  // the -itsoffset INPUT option (the phone's ffmpeg build has NO adelay
  // filter), so it plays during the outro window at the end.
  // -fflags +genpts regenerates timestamps (odd downloaded files can carry
  // broken PTS that made the slim build's muxer choke mid-encode).
  const base: string[] = ['-y', '-fflags', '+genpts', '-i', cleanPath(inputUri), '-i', cleanPath(wm)];
  base.push('-itsoffset', jingleDelaySec.toFixed(3), '-i', cleanPath(jingle)); // [2]
  if (musicUri) {
    // loop music and trim it to the video length via the -t input option
    // (the build may not include atrim/asetpts)
    base.push('-stream_loop', '-1', '-t', String(Math.round(durSec)), '-i', cleanPath(musicUri)); // [3]
  }

  // Audio capabilities of the on-device ffmpeg (slim "embed" builds lack
  // adelay/anullsrc/amix entirely). We ALWAYS try a mixing mode first, then
  // degrade to a mode that needs NO audio filters:
  //   mix-music  = music + jingle outro       (needs amix)
  //   mix-orig   = original audio + jingle     (needs amix)
  //   music      = music only, no jingle       (map 3:a — zero filters)
  //   orig       = original audio, no jingle   (map 0:a — zero filters)
  //   jingle     = jingle only (silent source) (map 2:a — zero filters)
  // Every fallback preserves SOME audio — we never silently blank a video
  // that had sound, and we never let a missing filter kill the download.
  type BakeMode = 'mix-music' | 'mix-orig' | 'music' | 'orig' | 'jingle';

  const vf = (): string[] => [
    `[1:v]scale=w=${wmW}:h=-1[wm]`,
    // corner watermark, bottom-right, fade-in after 0.4s
    `[0:v][wm]overlay=x=W-w-14:y=H-h-14:enable='gte(t,0.4)',format=pix_fmts=yuv420p[vout]`,
  ];
  // NOTE: ONLY named-option syntax — the Android build rejects positional
  // filter args. Audio inputs are normalized to 44100 Hz mono BEFORE amix
  // (amix refuses mismatched sample rates/layouts; phone videos are usually
  // 48 kHz stereo, the jingle is 44.1 kHz mono).
  const J = `[2:a]aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[jing]`;
  const mkFc = (mode: BakeMode): string[] => {
    const fc = vf();
    if (mode === 'mix-music') {
      fc.push(`[3:a]aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[mus]`, J);
      fc.push(`[mus][jing]amix=inputs=2:duration=first[aout]`);
    } else if (mode === 'mix-orig') {
      fc.push(`[0:a]aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[orig]`, J);
      fc.push(`[orig][jing]amix=inputs=2:duration=first[aout]`);
    }
    return fc;
  };

  const tryOrder: BakeMode[] = musicUri
    ? ['mix-music', 'music', 'jingle']
    : meta?.hasAudio !== false
      ? ['mix-orig', 'orig', 'jingle']
      : ['jingle'];

  let lastErr: Error | null = null;
  let done = false;
  for (const mode of tryOrder) {
    const fc = mkFc(mode);
    const args: string[] = [...base];
    args.push('-filter_complex', fc.join(';'));
    args.push('-map', '[vout]');
    // audio source for this mode: mixed [aout] | music 3:a | original 0:a | jingle 2:a
    args.push('-map', mode === 'mix-music' || mode === 'mix-orig' ? '[aout]' : mode === 'music' ? '3:a' : mode === 'orig' ? '0:a' : '2:a');
    // ffmpeg-expo LGPL binaries: no libx264 → universal mpeg4 + aac.
    // No -shortest: with a late-starting audio stream (-itsoffset) the slim
    // build's -shortest bookkeeping failed mid-encode. The app measures the
    // video duration directly, so an explicit -t cap is exact and safe.
    args.push('-c:v', 'mpeg4', '-q:v', '4');
    args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
    args.push('-t', durSec.toFixed(3));
    args.push(cleanPath(out));
    console.log(`[bakeVideo] mode=${mode} in=${inputUri} music=${!!musicUri} hasAudio=${meta?.hasAudio} dur=${durSec} vw=${vw} jingleDelay=${jingleDelaySec}`);
    try {
      await exec(args, 180000);
      done = true;
      break;
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[bakeVideo] mode ${mode} failed (${lastErr.message}) — trying next`);
    }
  }
  if (!done) {
    console.error('[bakeVideo] ALL modes failed:', lastErr?.message);
    throw lastErr ?? new Error('video bake failed');
  }

  // Sanity: the baked file MUST contain a video stream. If the encoder
  // silently dropped video (audio-only output), tell the user loudly.
  const outMeta = await probeMediaMeta(out);
  const fsx: any = await import('expo-file-system/legacy');
  let outBytes = 0;
  try {
    const info = await fsx.getInfoAsync(out);
    outBytes = info?.size ?? 0;
  } catch {
    // ignore
  }
  console.log(`[bakeVideo] out probe=${JSON.stringify(outMeta)} bytes=${outBytes}`);
  if (outMeta && !outMeta.hasVideo) {
    try {
      const fs: any = await import('expo-file-system/legacy');
      await fs.deleteAsync(out, { idempotent: true });
    } catch {
      // ignore
    }
    throw new Error('The encoder produced a file without video — please report this (code 2)');
  }
  return out;
}
