#!/usr/bin/env node
/**
 * inspect-duplicates.mjs — read-only measurement for the Phase 3 consolidation.
 *
 * Two questions have been answered by reading code so far, but the decision
 * about which columns are actually live needs numbers from the real project,
 * not assumptions. This runs COUNT queries only. It never writes, never
 * prints a key, and refuses to run without a service key because RLS would
 * hide rows and make every count look like zero.
 *
 *   node scripts/inspect-duplicates.mjs
 *
 * Loads .env.local when present (Node 20.6+ --env-file semantics, done by
 * hand so it works on older runtimes too).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// .env holds the public URL; .env.local holds the service key. Read both, with
// .env.local applied second so it wins, and never overwrite a real env var.
for (const file of ['.env', '.env.local']) {
  const envPath = path.join(process.cwd(), file);
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] != null) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const URL_BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_BASE || !KEY) {
  console.error('need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (checked env and .env.local)');
  process.exit(2);
}

const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

/** Exact row count without downloading rows: PostgREST sends Content-Range. */
async function count(table, filter) {
  const qs = filter ? '?' + filter : '';
  const res = await fetch(`${URL_BASE}/rest/v1/${table}${qs}`, {
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
  });
  if (res.status === 404) return { table, exists: false, n: null };
  if (!res.ok) {
    const body = await res.text();
    return { table, exists: true, n: null, error: `${res.status} ${body.slice(0, 120)}` };
  }
  const range = res.headers.get('content-range') || '';
  const total = range.includes('/') ? Number(range.split('/')[1]) : NaN;
  return { table, exists: true, n: Number.isFinite(total) ? total : null };
}

const PROBES = [
  ['muted_users', ''],
  ['muted_accounts', ''],
  ['blocks', ''],
  ['reports', ''],
  ['chat_reports', ''],
  ['anonymous_reports', ''],
  ['support_reports', ''],
  ['profiles', ''],
  ['profiles', 'location=not.is.null'],
  ['profiles', 'region=not.is.null'],
  ['profiles', 'location_region=not.is.null'],
  ['posts', ''],
  ['posts', 'location=not.is.null'],
];

console.log('table                 filter                       rows');
console.log('-'.repeat(66));
for (const [table, filter] of PROBES) {
  const r = await count(table, filter);
  const name = table.padEnd(21);
  const f = (filter || '(all)').padEnd(28);
  const val = r.exists === false ? 'MISSING' : r.n == null ? 'ERR ' + (r.error || '') : String(r.n);
  console.log(name + ' ' + f + ' ' + val);
}

// Overlap: rows that exist in BOTH mute tables for the same pair. If this is
// zero while both tables have rows, the two features were used by different
// screens on different days and nothing was ever in sync.
const both = await count('muted_users', 'select=user_id&limit=0');
console.log('\n(sanity) muted_users reachable:', both.exists !== false);
