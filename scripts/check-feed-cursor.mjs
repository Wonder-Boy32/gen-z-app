#!/usr/bin/env node
/**
 * check-feed-cursor.mjs — prove the keyset cursor means what FeedScreen thinks.
 *
 * The pagination predicate in FeedScreen.tsx is:
 *
 *   or=(created_at.lt.<c>,and(created_at.eq.<c>,id.lt.<i>))
 *
 * That string is generated, never typed, so a typo would not surface as a
 * compile error — it would surface as a feed that repeats a post or silently
 * stops. This runs the real query against the real PostgREST and checks the
 * three properties the page relies on:
 *
 *   1. page 2 returns no post that page 1 already returned
 *   2. every post on page 2 is strictly older than the cursor
 *   3. the two pages together are strictly ordered by (created_at, id)
 *
 * Read-only. Loads .env. Exits non-zero if any property fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

for (const file of ['.env', '.env.local']) {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || process.env[m[1]] != null) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
// Service role when available: posts are not readable as anon (RLS), and the
// point here is the query predicate, not the policy.
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
if (!BASE || !KEY) {
  console.error('need EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(2);
}

const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const PAGE = 3;

async function page(cursor) {
  const params = new URLSearchParams({
    select: 'id,created_at',
    order: 'created_at.desc,id.desc',
    limit: String(PAGE),
  });
  if (cursor) {
    params.set(
      'or',
      `(created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id}))`
    );
  }
  const res = await fetch(`${BASE}/rest/v1/posts?${params}`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

const results = [];
const note = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${label.padEnd(56)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`);
};

const first = await page(null);
if (!first.length) {
  console.log('0 posts readable with this key — cannot exercise the predicate at all');
  process.exit(2);
}

const cursor = { created_at: first[first.length - 1].created_at, id: first[first.length - 1].id };

// Page 2 is requested even when page 1 is short. The predicate is generated
// text: the failure mode is PostgREST rejecting it or quietly ignoring it, and
// only a real round trip distinguishes those from a working filter.
const second = await page(cursor);
note('pagination predicate accepted by PostgREST', true, 'no error');

if (first.length < 2) {
  note('page 2 of a 1-post project is empty', second.length === 0, `rows=${second.length}`);
  console.log('\nNOTE: with fewer than 2 posts the ordering properties are not exercised.');
  console.log('\n' + (results.every(Boolean) ? 'PASS' : 'FAIL'));
  process.exit(results.every(Boolean) ? 0 : 1);
}

const firstIds = new Set(first.map((r) => r.id));
const overlap = second.filter((r) => firstIds.has(r.id));
note('page 2 repeats nothing from page 1', overlap.length === 0, `overlap=${overlap.length}`);

const cursorMs = Date.parse(cursor.created_at);
const tooNew = second.filter(
  (r) => Date.parse(r.created_at) > cursorMs ||
    (Date.parse(r.created_at) === cursorMs && r.id > cursor.id)
);
note('every page-2 row is strictly older than the cursor', tooNew.length === 0, `violations=${tooNew.length}`);

const all = [...first, ...second];
let ordered = true;
for (let i = 1; i < all.length; i++) {
  const a = all[i - 1], b = all[i];
  const ta = Date.parse(a.created_at), tb = Date.parse(b.created_at);
  if (ta < tb || (ta === tb && a.id < b.id)) { ordered = false; break; }
}
note('the two pages concatenate into one ordered list', ordered, `rows=${all.length}`);

console.log('\n' + (results.every(Boolean) ? 'PASS' : 'FAIL'));
process.exit(results.every(Boolean) ? 0 : 1);
