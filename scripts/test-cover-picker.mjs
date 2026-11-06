// ============================================================
// scripts/test-cover-picker.mjs
// ============================================================
// The cover policy is the only part of "pick the best cover" that can be
// proven without a native ffmpeg build. The ffmpeg half is a claim; this half
// is a test.
//
// Transpiles src/utils/coverPicker.ts in-process so there is no build step and
// no dependency on the app runner.
//
//   node scripts/test-cover-picker.mjs

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src/utils/coverPicker.ts');

const raw = fs.readFileSync(SRC, 'utf8');
const js = ts.transpileModule(raw, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const mod = { exports: {} };
new Function('exports', 'module', js)(mod.exports, mod);
const { coverWindows, coverScore, pickBestCover, LUMA_BLACK, LUMA_IDEAL, LUMA_WHITE } = mod.exports;

let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- windows
{
  const w = coverWindows(60);
  check('60s clip scans three windows', w.length === 3, JSON.stringify(w));
  check('60s clip starts at 0', w[0] === 0, JSON.stringify(w));
  check(
    '60s clip never scans the closing second',
    w.every((t) => t <= 58.8),
    JSON.stringify(w)
  );
  check('60s windows ascend', w[0] < w[1] && w[1] < w[2], JSON.stringify(w));
}
{
  const w = coverWindows(1.5);
  check('very short clip collapses to one window', w.length === 1, JSON.stringify(w));
  check('very short clip window is the opening', w[0] === 0, JSON.stringify(w));
}
{
  const w = coverWindows(2);
  check('2s clip does not ask for a window past the end', w.every((t) => t <= 0.8), JSON.stringify(w));
}
{
  const w = coverWindows(0);
  check('unknown duration probes fixed points', w.join(',') === '0,2,5', JSON.stringify(w));
}
{
  const w = coverWindows(NaN);
  check('NaN duration behaves like unknown', w.join(',') === '0,2,5', JSON.stringify(w));
}
{
  const w = coverWindows(null);
  check('null duration behaves like unknown', w.join(',') === '0,2,5', JSON.stringify(w));
}
{
  // A 3s clip: 0, 0.36, 0.9 — the last two are 0.54 apart, so both survive.
  const w = coverWindows(3);
  check('no two windows decode the same frames', w.every((t, i) => i === 0 || t - w[i - 1] >= 0.4), JSON.stringify(w));
}

// ----------------------------------------------------------------- scores
check('pure black scores zero', coverScore(0) === 0, String(coverScore(0)));
check('ideal luma scores one', Math.abs(coverScore(LUMA_IDEAL) - 1) < 1e-9, String(coverScore(118)));
check('well exposed beats near-black', coverScore(118) > coverScore(LUMA_BLACK + 5));
check('well exposed beats blown out', coverScore(118) > coverScore(250));
check('mid-dark beats near-black', coverScore(70) > coverScore(10));
check('mid-bright beats blown out', coverScore(190) > coverScore(252));
check('pure white scores near zero', coverScore(255) < 0.05, String(coverScore(255)));
check('out-of-range input is clamped', coverScore(-40) === 0 && coverScore(400) < 0.05);
check('NaN scores zero', coverScore(NaN) === 0);
check(
  'the black band really is at or below LUMA_BLACK',
  coverScore(LUMA_BLACK - 1) < 0.05,
  String(coverScore(LUMA_BLACK - 1))
);
check('LUMA_WHITE is above ideal', LUMA_WHITE > LUMA_IDEAL && LUMA_IDEAL > LUMA_BLACK);

// ------------------------------------------------------------------ picks
{
  const cands = [
    { at: 0, yavg: 4, path: 'a' }, // black intro
    { at: 7.2, yavg: 122, path: 'b' }, // good
    { at: 18, yavg: 16, path: 'c' }, // dark outro
  ];
  const best = pickBestCover(cands);
  check('picks the well-exposed frame over the black intro', best.path === 'b', best.path);
}
{
  // The exact reported case: a clip whose opening second is black.
  const cands = [
    { at: 0, yavg: 0, path: 'black-first-frame' },
    { at: 5, yavg: 95, path: 'real-content' },
  ];
  check('never returns the black first frame', pickBestCover(cands).path === 'real-content');
}
{
  const cands = [
    { at: 0, yavg: 240, path: 'white' },
    { at: 5, yavg: 150, path: 'ok' },
  ];
  check('blown-out frame loses to a normal one', pickBestCover(cands).path === 'ok');
}
{
  const cands = [
    { at: 0, yavg: NaN, path: 'x' },
    { at: 6, yavg: NaN, path: 'y' },
    { at: 15, yavg: NaN, path: 'z' },
  ];
  const best = pickBestCover(cands);
  check(
    'with no measurable frames it takes the middle window, not the opening',
    best.path === 'y',
    best.path
  );
}
{
  const cands = [
    { at: 0, yavg: NaN, path: 'x' },
    { at: 6, yavg: 118, path: 'y' },
  ];
  check('one measurable frame wins over unmeasurable ones', pickBestCover(cands).path === 'y');
}
check('empty candidate list yields null', pickBestCover([]) === null);

// ------------------------------------------------------------------ report
if (fails.length) {
  console.error(`FAIL — ${fails.length} cover-picker check(s) failed:`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASS — ${pass} cover-picker checks`);
