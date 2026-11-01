#!/usr/bin/env node
/**
 * check-theme.mjs — the one light-theme rule that can be checked mechanically.
 *
 * THE BUG CLASS
 *   Chrome written as a literal instead of a token. `rgba(255,255,255,0.05)` is
 *   a subtle raised surface on the dark palette and *literally invisible* on
 *   White mode, because the page behind it is white too. The chip, divider or
 *   row disappears while its text, which does use `colors.text`, turns near
 *   black and stays readable — so the UI looks broken rather than unthemed.
 *
 *   That is the shape of the complaint that started this: "it look too busy and
 *   flashy especially the tops headers and navs backgrounds".
 *
 * WHY ONLY THIS RULE
 *   Near-black literals are NOT flagged. Most of them are media wells, video
 *   scrims and placeholder frames, which are supposed to stay dark in both
 *   themes (see theme.ts: price/media notes). Flagging those would produce a
 *   list nobody reads, and a check nobody reads is worse than none.
 *
 *   Two FilterCarousel entries are allowlisted below: those are colour effects
 *   applied to video frames, not chrome.
 *
 * Usage:  node scripts/check-theme.mjs
 *         node scripts/check-theme.mjs --inventory   also list near-black chrome
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.join(process.cwd(), 'src');

// file -> reason. Keep this short and justified; it is the whole escape hatch.
const ALLOW = {
  'components/create/FilterCarousel.tsx':
    'filter tints/glows applied to video frames, not chrome',
};

// Only sub-10% whites are the defect. A 10-40% white ring, scrim or hairline
// sits over media (a shutter button, a story progress rail, a border on a
// video thumbnail) and is meant to stay white in both themes, because the media
// underneath is dark in both themes. A 3-8% white SURFACE only has meaning
// against a dark page — against a white one it is nothing at all. That
// threshold is the difference between 22 findings and the real ones.
const WHITE = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/;
const CHROME_PROP = /\b(backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor)\s*:\s*'([^']+)'/g;
const NEAR_BLACK = /^#0[0-9a-fA-F]{5}$|^#1[0-9a-fA-F]{5}$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && entry.name !== 'theme.ts') out.push(p);
  }
  return out;
}

const offences = [];
const inventory = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    let m;
    CHROME_PROP.lastIndex = 0;
    while ((m = CHROME_PROP.exec(line)) !== null) {
      const value = m[2];
      const w = WHITE.exec(value);
      if (w && Number(w[1]) < 0.1 && !ALLOW[rel]) {
        offences.push({ rel, line: i + 1, prop: m[1], value });
      }
      if (NEAR_BLACK.test(value)) {
        inventory.push({ rel, line: i + 1, prop: m[1], value });
      }
    }
  });
}

console.log('rule: no white-alpha chrome literals (invisible in White mode)');
if (offences.length === 0) {
  console.log('  PASS — 0 found');
} else {
  console.log(`  FAIL — ${offences.length} found`);
  for (const o of offences) {
    console.log(`    ${o.rel}:${o.line}  ${o.prop}: '${o.value}'  -> use colors.chrome / colors.chromeBorder`);
  }
}

if (Object.keys(ALLOW).length) {
  console.log('\nallowlisted (not chrome):');
  for (const [f, why] of Object.entries(ALLOW)) console.log(`  ${f} — ${why}`);
}

if (process.argv.includes('--inventory')) {
  console.log(`\ninventory: ${inventory.length} near-black chrome literal(s) — NOT enforced`);
  console.log('  most are media wells/scrims, which stay dark by design; listed so the');
  console.log('  remainder is visible instead of forgotten');
  for (const o of inventory) console.log(`    ${o.rel}:${o.line}  ${o.prop}: '${o.value}'`);
}

process.exit(offences.length === 0 ? 0 : 1);
