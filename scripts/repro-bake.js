// Local reproduction of bakeDownloadVideo's ffmpeg command (mirrors the
// exact args + filtergraph the app builds). Lets us debug parse errors
// without a device build cycle.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FF = require('ffmpeg-static');
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.repro');
fs.mkdirSync(TMP, { recursive: true });

const wm = path.join(ROOT, 'assets', 'wm-genz.png');
const jingle = path.join(ROOT, 'assets', 'genz_jingle.wav');
const videoIn = path.join(TMP, 'test_in.mp4'); // with audio
const videoNoAud = path.join(TMP, 'test_noaudio.mp4'); // silent video
const musicIn = path.join(TMP, 'test_music.m4a');
const out = path.join(TMP, 'out.mp4');

function run(args, tag) {
  console.log(`\n=== ${tag} ===`);
  console.log('ffmpeg', args.join(' ').slice(0, 400));
  const r = spawnSync(FF, args, { encoding: 'utf8' });
  const log = (r.stderr || '').split('\n').filter((l) => l.trim()).slice(-12).join('\n');
  console.log('exit:', r.status, '\n--- last log lines ---\n' + log);
  return r.status;
}

// ---- fixtures ----
console.log('creating fixtures…');
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=360x640:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=44100', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', videoIn], 'fixture video');
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=360x640:rate=24', '-c:v', 'mpeg4', '-q:v', '4', '-an', videoNoAud], 'fixture silent video');
run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8:sample_rate=44100', '-c:a', 'aac', musicIn], 'fixture music');

const wmW = 120; // clamp(round(360*0.22),120,260)
const durSec = 5;
const jingleDelayMs = Math.max(0, Math.round((durSec - 1.9) * 1000));

// ---- exact logic from bakeDownloadVideo (normalize + mode variants) ----
const J = `[2:a]adelay=${jingleDelayMs}:all=1,aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[jing]`;
function mkFc(mode) {
  const fc = [];
  fc.push(`[1:v]scale=${wmW}:-1[wm]`);
  fc.push(`[0:v][wm]overlay=W-w-14:H-h-14:enable='gte(t,0.4)',format=yuv420p[vout]`);
  if (mode === 'music') {
    fc.push(`[3:a]atrim=duration=${durSec},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[mus]`);
    fc.push(J);
    fc.push(`[mus][jing]amix=inputs=2:duration=first[aout]`);
  } else if (mode === 'orig') {
    fc.push(`[0:a]aformat=sample_rates=44100:sample_fmts=fltp:channel_layouts=mono[orig]`);
    fc.push(J);
    fc.push(`[orig][jing]amix=inputs=2:duration=first[aout]`);
  } else {
    fc.push(J);
    fc.push(`anullsrc=r=44100:cl=mono[ns]`);
    fc.push(`[jing][ns]amix=inputs=2:duration=first[aout]`);
  }
  return fc;
}
function bake(input, music, modes) {
  let ok = false;
  for (const mode of modes) {
    const a = ['-y', '-i', input, '-i', wm, '-i', jingle];
    if (music) a.push('-stream_loop', '-1', '-i', music);
    const fc = mkFc(mode);
    a.push('-filter_complex', fc.join(';'));
    a.push('-map', '[vout]', '-map', '[aout]');
    a.push('-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
    a.push('-shortest');
    a.push(out);
    if (run(a, `BAKE ${mode}`) === 0) { ok = true; break; }
  }
  return ok;
}

let fail = 0;
if (!bake(videoIn, null, ['orig', 'silent'])) fail++; // video WITH audio, no music
if (!bake(videoNoAud, null, ['silent'])) fail++; // silent video, no music
if (!bake(videoIn, musicIn, ['music'])) fail++; // video with attached music
console.log('\n' + (fail ? `FAILED: ${fail} scenario(s)` : 'ALL 3 SCENARIOS OK — out size: ' + (fs.existsSync(out) ? fs.statSync(out).size : 'n/a') + ' bytes'));
process.exit(fail ? 1 : 0);
