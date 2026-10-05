#!/usr/bin/env node
/**
 * preflight-env.js — refuse to build a dead app.
 *
 * WHY THIS EXISTS
 *
 * A build shipped where src/supabase/client.ts threw at module load ("Missing
 * Supabase env vars"), because the .env file it depends on had been excluded
 * from the upload. In a release build that throw is not a red box — the process
 * dies. The symptom was "the splash shows and then it drops back to my home
 * screen": no message, no log, nothing to search. That is the single most
 * expensive kind of bug to diagnose, and it is entirely preventable at build
 * time, because a missing env var is a BUILD configuration error.
 *
 * So this runs before the build and stops it, loudly, with the reason.
 *
 * Run: node scripts/preflight-env.js
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
// The three values client.ts and the Giphy picker read via process.env.
const REQUIRED = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_GIPHY_API_KEY',
];

/** Parse a dotenv-style file into a plain map. No dependency needed. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes, as dotenv does.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const envPath = path.join(root, '.env');
const env = readEnvFile(envPath);
const problems = [];

if (!fs.existsSync(envPath)) {
  problems.push('.env does not exist at the project root.');
}

for (const key of REQUIRED) {
  const v = env[key];
  if (v === undefined) problems.push(`${key} is not defined in .env`);
  else if (!v.trim()) problems.push(`${key} is present but empty`);
}

// The failure mode that caused the outage: the file exists on disk (so a naive
// existence check passes) but the build will not receive it.
const easignore = path.join(root, '.easignore');
if (fs.existsSync(easignore)) {
  const lines = fs
    .readFileSync(easignore, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const line of lines) {
    // Match the entry forms that would exclude .env from the archive.
    if (/^!?\.env$/.test(line) || /^\.env\b/.test(line) || line === '*') {
      problems.push(
        `.easignore excludes env files ("${line}"). The build uploads this ` +
          'project and Metro reads .env from it, so this produces an app that ' +
          'dies on launch with no visible error.'
      );
    }
  }
}

if (problems.length) {
  console.error('\n  BUILD BLOCKED — this build would ship a broken app:\n');
  for (const p of problems) console.error('    - ' + p);
  console.error(
    '\n  A missing EXPO_PUBLIC_* value makes src/supabase/client.ts throw at\n' +
      '  module load. In a release build that is a process death after the\n' +
      '  splash screen, with no error the user can report.\n'
  );
  process.exit(1);
}

console.log('  preflight ok — .env present, complete, and not excluded by .easignore');
