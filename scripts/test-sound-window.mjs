// ============================================================
// Asserts the sound-window rules in src/utils/soundWindow.ts.
//
//   node scripts/test-sound-window.mjs
//
// These are the two bugs reported against the feed/create sound:
// a chosen track stopped before the video ended, and it could not be
// trimmed to an exact point. Both were arithmetic, so they are
// checked here instead of on a phone.
// ============================================================

// The module under test is TypeScript, and this repo is not an ES-module
// package, so it is transpiled in-process with the TypeScript compiler that is
// already a devDependency. No flags, no build step, same result everywhere.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/utils/soundWindow.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('exports', 'module', js)(mod.exports, mod);
const { EDGE, loopAction, resolveSoundWindow } = mod.exports;

let pass = 0;
const fails = [];

const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    return;
  }
  fails.push(`${label}\n    expected ${e}\n    actual   ${a}`);
};

const near = (label, actual, expected, tol = 0.001) => {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) {
    pass += 1;
    return;
  }
  fails.push(`${label}\n    expected ~${expected}\n    actual   ${actual}`);
};

// ---- resolveSoundWindow ------------------------------------

// A stored end past the file is clamped: this is what made the wrap
// unreachable and the video go mute after the sound ran out.
{
  const w = resolveSoundWindow(0, 30, 24);
  eq('end 30 on a 24s file clamps to the file', w, { from: 0, to: 24 });
}

// No end stored = play the whole track. The old code early-returned here
// and never looped at all.
{
  const w = resolveSoundWindow(5, null, 24);
  eq('null end means the whole remaining track', w, { from: 5, to: 24 });
}

// An end at or before the start is not a window.
{
  eq('end equal to start falls back to the file end', resolveSoundWindow(10, 10, 24), {
    from: 10,
    to: 24,
  });
  eq('end before start falls back to the file end', resolveSoundWindow(10, 4, 24), {
    from: 10,
    to: 24,
  });
}

// A window inside the file is left exactly as the user set it.
{
  const w = resolveSoundWindow(4.3, 12.7, 30);
  eq('an in-range window is preserved to the tenth', w, { from: 4.3, to: 12.7 });
}

// A start that sits on (or past) the last samples is pulled back, so a
// re-trim after the track was replaced cannot seek past the bytes.
{
  near('a start 0.05s from the file end is pulled back', resolveSoundWindow(23.95, null, 24).from, 23.8);
  eq('a start past the file end is pulled back', resolveSoundWindow(99, null, 24).from, 23.8);
  eq('negative starts are zero', resolveSoundWindow(-3, null, 24), { from: 0, to: 24 });
}

// Duration not measured yet: nothing can be clamped, and nothing should be
// invented. to stays null so the loop stays quiet until the file reports.
{
  eq('unmeasured duration leaves the window open-ended', resolveSoundWindow(2, null, 0), {
    from: 2,
    to: null,
  });
  eq('unmeasured duration keeps a stored end as-is', resolveSoundWindow(2, 30, 0), {
    from: 2,
    to: 30,
  });
}

// ---- loopAction --------------------------------------------

const win = (from, to) => ({ from, to });

// playing, inside the end band -> wrap
eq(
  'playing at the window end wraps',
  loopAction({ currentTime: 12 - 0.05, playing: true }, win(4, 12), 30),
  'wrap'
);
eq(
  'playing exactly at the window end wraps',
  loopAction({ currentTime: 12, playing: true }, win(4, 12), 30),
  'wrap'
);
eq(
  'the wrap band is EDGE wide, not wider',
  loopAction({ currentTime: 12 - EDGE - 0.01, playing: true }, win(4, 12), 30),
  null
);
eq(
  'playing mid-window does nothing',
  loopAction({ currentTime: 6, playing: true }, win(4, 12), 30),
  null
);

// The reported bug: a 24s track on a 40s video. The file ends before the
// window does, the player goes idle at the last sample, and the old code had
// no path back -> silence for the rest of the video.
eq(
  'an idle player at the file end restarts',
  loopAction({ currentTime: 24, playing: false }, win(4, 30), 24),
  'restart'
);
eq(
  'restart tolerates the last samples not being reported exactly',
  loopAction({ currentTime: 23.8, playing: false }, win(4, 30), 24),
  'restart'
);

// A user-paused track mid-file must NOT be restarted — that would make pausing
// impossible.
eq(
  'an idle player mid-file is left alone',
  loopAction({ currentTime: 9, playing: false }, win(4, 30), 24),
  null
);

// Nothing to restart when the duration is unknown.
eq(
  'no restart without a measured duration',
  loopAction({ currentTime: 5, playing: false }, win(0, null), 0),
  null
);

// An open-ended window still restarts when the file runs out.
eq(
  'an open window restarts at the file end',
  loopAction({ currentTime: 24, playing: false }, win(0, null), 24),
  'restart'
);

// Nonsense positions are ignored rather than seeking anywhere.
eq('NaN time does nothing', loopAction({ currentTime: NaN, playing: true }, win(0, 10), 24), null);
eq('negative time does nothing', loopAction({ currentTime: -1, playing: true }, win(0, 10), 24), null);

// ---- report ------------------------------------------------

const total = pass + fails.length;
if (fails.length) {
  console.error(`\nFAIL — ${fails.length} of ${total} sound-window checks failed:\n`);
  for (const f of fails) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`PASS — ${total} sound-window checks`);
