// Verifies the EXACT argv bakeDownloadVideo builds, against a real ffmpeg.
//
// Why this exists: the download bake can only be tested end-to-end on a device,
// and a device round-trip costs a build plus an install. A malformed argument or
// filtergraph would look identical to a device that cannot encode — both end as
// a plain remux and "Saved without the GEN Z mark". This runs the real argv
// locally first, so anything it reports is a code problem, not the phone.
//
// It mirrors src/utils/videoProcessor.ts. If that file changes, change this one.
//   node scripts/verify-download-bake.js

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FF = require('ffmpeg-static');
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.repro-bake');
fs.mkdirSync(TMP, { recursive: true });

const wm = path.join(ROOT, 'assets', 'wm-genz.png');
const jingle = path.join(ROOT, 'assets', 'genz_jingle.m4a');

// A fixture close to a real phone capture: 360x640 portrait, 48 kHz STEREO audio
// (the jingle is 44.1 kHz mono, so amix has to reconcile the two — that mismatch
// is exactly what the aformat steps exist for).
const video = path.join(TMP, 'in.mp4');
const videoSilent = path.join(TMP, 'in-silent.mp4');
const music = path.join(TMP, 'music.m4a');

function run(args, tag) {
  const out = args[args.length - 1];
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  const r = spawnSync(FF, args, { encoding: 'utf8' });
  const outExists = fs.existsSync(out);
  const bytes = outExists ? fs.statSync(out).size : 0;
  const tail = (r.stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6)
    .join('\n');
  const ok = r.status === 0 && bytes > 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${tag}  (exit ${r.status}, ${bytes} bytes)`);
  if (!ok) console.log(tail);
  return ok;
}

function probe(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const t = r.stderr || '';
  return {
    video: /Stream #\d+:\d+.*Video:/.test(t),
    audio: /Stream #\d+:\d+.*Audio:/.test(t),
    resolution: /Video:.*?(\d{2,5}x\d{2,5})/.exec(t)?.[1] ?? '?',
  };
}

console.log('fixtures…');
const fixturesOk =
  run(
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=360x640:rate=30',
     '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
     '-ac', '2', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', video],
    'fixture: 360x640 video + 48k stereo audio'
  ) &&
  run(
    ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=360x640:rate=30',
     '-c:v', 'mpeg4', '-q:v', '4', '-an', videoSilent],
    'fixture: silent video'
  ) &&
  run(
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10:sample_rate=44100',
     '-c:a', 'aac', music],
    'fixture: attached sound'
  );

if (!fixturesOk) {
  console.error('\nfixture creation failed — ffmpeg itself is broken here, results would be meaningless');
  process.exit(1);
}

const durSec = 6;
const vw = 360;
const wmW = Math.max(120, Math.round((vw * 0.22) / 2) * 2);
const JINGLE_SEC = 2.4;
const jingleDelaySec = Math.max(0, durSec - JINGLE_SEC - 0.2);

// ---------------------------------------------------------------
// Plan "minimal-overlay" — the new safety net: one overlay, no scale on the
// watermark, no pix_fmt conversion, no audio filters, audio stream-copied.
// ---------------------------------------------------------------
const minimal = [
  '-y',
  '-i', video,
  '-i', wm,
  '-filter_complex', `[0:v][1:v]overlay=x=W-w-14:y=H-h-14[vout]`,
  '-map', '[vout]',
  '-map', '0:a?',
  '-c:v', 'mpeg4', '-q:v', '4',
  '-c:a', 'copy',
  '-t', durSec.toFixed(3),
  path.join(TMP, 'minimal.mp4'),
];

// ---------------------------------------------------------------
// Plan "watermark+jingle" in its fullest mode (mix-music): the whole graph.
// ---------------------------------------------------------------
const A = 'aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono';
const fcFull = [
  `[1:v]scale=w=${wmW}:h=-1[wm]`,
  `[0:v][wm]overlay=x=W-w-14:y=H-h-14:enable='gte(t,0.4)',format=pix_fmts=yuv420p[vout]`,
  `[3:a]${A}[mix0]`,
  `[2:a]${A}[jing]`,
  `[mix0][jing]amix=inputs=2:duration=first[aout]`,
].join(';');

const full = [
  '-y',
  '-fflags', '+genpts',
  // input order is load-bearing and must match attempt() in videoProcessor.ts:
  //   0 = video, 1 = watermark, 2 = jingle, 3 = attached sound
  // The filtergraph refers to these by index ([1:v], [2:a], [3:a]), so a missing
  // or reordered input here produces "stream specifier matches no streams" —
  // which is how this harness caught itself the first time it ran.
  '-i', video,
  '-i', wm,
  '-itsoffset', jingleDelaySec.toFixed(3),
  '-i', jingle,
  '-stream_loop', '-1', '-t', String(Math.round(durSec)),
  '-i', music,
  '-filter_complex', fcFull,
  '-map', '[vout]',
  '-map', '[aout]',
  '-c:v', 'mpeg4', '-q:v', '4',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  '-t', durSec.toFixed(3),
  path.join(TMP, 'full.mp4'),
];

// ---------------------------------------------------------------
// Plan "minimal-overlay" on a SILENT video: `-map 0:a?` must tolerate the
// missing stream and the copy must not be attempted.
// ---------------------------------------------------------------
// rebuilt rather than patched by index — editing an argv array positionally is
// how the first run of this file corrupted its own input list
const minimalSilent = [
  '-y',
  '-i', videoSilent,
  '-i', wm,
  '-filter_complex', `[0:v][1:v]overlay=x=W-w-14:y=H-h-14[vout]`,
  '-map', '[vout]',
  '-map', '0:a?',
  '-c:v', 'mpeg4', '-q:v', '4',
  '-c:a', 'copy',
  '-t', durSec.toFixed(3),
  path.join(TMP, 'minimal-silent.mp4'),
];

// ---------------------------------------------------------------
// Plan "watermark+jingle" in 'jingle-concat' mode — the path for devices whose
// ffmpeg has no amix. Uses only aformat + atrim + concat, which the shipped
// libavfilter is verified to contain (see the filter scan in the notes).
// ---------------------------------------------------------------
const tail = Math.max(0.5, durSec - JINGLE_SEC);
const fcConcat = [
  `[1:v]scale=w=${wmW}:h=-1[wm]`,
  `[0:v][wm]overlay=x=W-w-14:y=H-h-14:enable='gte(t,0.4)',format=pix_fmts=yuv420p[vout]`,
  `[0:a]${A},atrim=0:${tail.toFixed(3)}[orig]`,
  `[2:a]${A}[jing]`,
  `[orig][jing]concat=n=2:v=0:a=1[aout]`,
].join(';');

const concatJingle = [
  '-y',
  '-i', video,
  '-i', wm,
  '-i', jingle,
  '-filter_complex', fcConcat,
  '-map', '[vout]',
  '-map', '[aout]',
  '-c:v', 'mpeg4', '-q:v', '4',
  '-c:a', 'aac', '-b:a', '128k',
  '-t', durSec.toFixed(3),
  path.join(TMP, 'concat-jingle.mp4'),
];

console.log(`\nwmW=${wmW}  jingleDelay=${jingleDelaySec.toFixed(3)}s  tail=${tail.toFixed(3)}s  dur=${durSec}s`);
const a = run(minimal, 'minimal-overlay (audio copied)');
const b = run(full, 'watermark+jingle (full graph, needs amix)');
const c = run(minimalSilent, 'minimal-overlay on a silent video');
const d = run(concatJingle, 'watermark+jingle-outro (concat, no amix needed)');

console.log('\n--- output streams ---');
for (const f of ['minimal.mp4', 'full.mp4', 'minimal-silent.mp4', 'concat-jingle.mp4']) {
  const p = path.join(TMP, f);
  if (!fs.existsSync(p)) { console.log(`${f}: missing`); continue; }
  const m = probe(p);
  console.log(`${f}: video=${m.video} audio=${m.audio} ${m.resolution}`);
}

// ---------------------------------------------------------------
// Proof that the mark is actually IN the pixels, not merely that ffmpeg
// exited 0. A solid black source makes this unambiguous: the bottom-right
// corner is empty black before the bake and must contain the watermark's
// bright glyphs after it. (Measuring the corner of a colourful fixture would
// prove nothing, because the re-encode changes every pixel anyway.)
// ---------------------------------------------------------------
const black = path.join(TMP, 'black.mp4');
const blackMarked = path.join(TMP, 'black-marked.mp4');
const okBlack = run(
  ['-y', '-f', 'lavfi', '-i', 'color=c=black:duration=3:size=360x640:rate=30',
   '-c:v', 'mpeg4', '-q:v', '4', black],
  'fixture: solid black video'
);

/** Highest luminance byte in the bottom-right corner, 0 = pure black. */
function cornerMaxLuma(file) {
  const r = spawnSync(
    FF,
    ['-v', 'error', '-i', file, '-frames:v', '1',
     '-vf', 'crop=140:60:iw-150:ih-70,format=gray',
     '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 24 }
  );
  const buf = r.stdout;
  if (!buf || !buf.length) return -1;
  let max = 0;
  for (const b of buf) if (b > max) max = b;
  return max;
}

console.log('\n--- watermark actually burned in? ---');
let lumaProof = false;
if (okBlack) {
  const before = cornerMaxLuma(black);
  const marked = run(
    ['-y', '-i', black, '-i', wm,
     '-filter_complex', '[0:v][1:v]overlay=x=W-w-14:y=H-h-14[vout]',
     '-map', '[vout]', '-c:v', 'mpeg4', '-q:v', '4',
     path.join(TMP, 'black-marked.mp4')],
    'minimal-overlay on the black source'
  );
  const after = cornerMaxLuma(blackMarked);
  lumaProof = marked && before === 0 && after > 20;
  console.log(`corner luminance before=${before} (must be 0), after=${after} (must be >20)`);
  console.log(
    lumaProof
      ? 'PASS  the GEN Z mark is present in the baked pixels'
      : 'FAIL  the bake ran but the corner is still empty — the mark is NOT in the file'
  );
} else {
  console.log('FAIL  could not build the black fixture');
}

const allOk = a && b && c && d && lumaProof;
console.log(`\n${allOk ? 'ALL PLAN ARGV VALID + WATERMARK VERIFIED IN PIXELS' : 'VERIFICATION FAILED'}`);
process.exit(allOk ? 0 : 1);
