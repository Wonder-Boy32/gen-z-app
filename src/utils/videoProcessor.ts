// ============================================================
// Native video processing via ffmpeg.
// Available ONLY in dev/production builds that include
// ffmpeg-kit-react-native (i.e. NOT in Expo Go).
// Everything here degrades gracefully: hasNativeFFmpeg() is
// false in Expo Go, and processDropVideo throws → the create
// flow falls back to the metadata-only path (playback-time
// trim/speed/filters via DropVideoView).
// ============================================================

let nativeFFmpeg: any = null;
let checked = false;

export function hasNativeFFmpeg(): boolean {
  if (!checked) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nativeFFmpeg = require('ffmpeg-kit-react-native');
    } catch {
      nativeFFmpeg = null;
    }
    checked = true;
  }
  return !!nativeFFmpeg;
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

// Runs one ffmpeg command; returns the output uri on success, throws on error.
async function run(args: string[], out: string): Promise<string> {
  const ff = nativeFFmpeg;
  const session = await ff.FFmpegKit.execute(`-y ${args.join(' ')}`);
  const returnCode = await session.getReturnCode();
  if (ff.ReturnCode.isSuccess(returnCode)) return out;
  throw new Error(`ffmpeg failed (code ${returnCode})`);
}

// Processes a video file into a NEW file that has trim/speed/rotation/
// filter/voiceover BAKED IN. Returns the output file uri.
// Throws if ffmpeg is unavailable or the command fails.
export async function processDropVideo(uri: string, opts: ProcessOptions): Promise<string> {
  if (!hasNativeFFmpeg()) throw new Error('ffmpeg not available');

  const fs: any = await import('expo-file-system');
  const dir = `${fs.cacheDirectory}drop-edit/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // dir may already exist
  }
  const out = `${dir}${opts.outputName ?? 'drop'}-${Date.now()}.mp4`;
  const input = cleanPath(uri);

  const args: string[] = ['-i', input];
  const vf: string[] = [];

  const hasAudioMix = !!opts.voiceoverUri;
  if (opts.voiceoverUri) args.push('-i', cleanPath(opts.voiceoverUri));

  const hasVisualEdits =
    (opts.speed && opts.speed !== 1) || !!opts.rotation || !!filterToVf(opts.filter);

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
      await run([...args, '-c', 'copy'], out);
    } else {
      if (hasAudioMix) {
        // mix voiceover over the video audio
        args.push(
          '-filter_complex',
          '[0:v:0]' +
            (vf.length ? `${vf.join(',')},` : '') +
            'scale=iw:ih[vout];[0:a?][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]',
          '-map',
          '[vout]',
          '-map',
          '[aout]'
        );
      } else {
        args.push('-vf', vf.join(','));
        args.push('-map', '0:v:0', '-map', '0:a?');
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-movflags', '+faststart');
      try {
        await run(args, out);
      } catch {
        // no libx264 in this package (non-gpl) → try Android hardware encoder
        const hw = args.map((a) => (a === 'libx264' ? 'h264_mediacodec' : a));
        try {
          await run(hw, out);
        } catch {
          // last resort: universal mpeg4 encoder
          const mp4 = args.map((a) => (a === 'libx264' ? 'mpeg4' : a));
          await run(mp4, out);
        }
      }
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
