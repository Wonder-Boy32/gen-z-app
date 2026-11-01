#!/usr/bin/env node
/**
 * cleanup-orphan-media.mjs
 *
 * Deletes storage objects in the public `media` bucket that no row
 * references. Exists because `genz_cleanup_orphan_media()` deletes one
 * object at a time through pg_net with a 0.5s poll per object, so a run
 * of 32 orphans exceeds the SQL editor's statement timeout and dies
 * halfway. This talks to the Storage API directly instead: one batch
 * DELETE, no polling.
 *
 * USAGE
 *   node --env-file=.env --env-file=scripts/.secrets.env \
 *     scripts/cleanup-orphan-media.mjs            # dry run, prints the plan
 *   ... scripts/cleanup-orphan-media.mjs --apply --yes
 *
 * SAFETY
 *   The deletion set is never computed here. It is the `auto_orphans` and
 *   `review_orphans` arrays returned by genz_find_orphan_media(), which is
 *   the server's own reference check over posts.media_url,
 *   profiles.avatar_url, profiles.cover_url and the retry queue.
 *
 *   Three guards on top of that:
 *     1. Anything still referenced by a post or a profile is subtracted
 *        again locally, so a stale RPC result cannot delete live content.
 *     2. `avatars/` is never touched. An avatar is the single most
 *        user-visible object in the bucket and a wrong guess is not
 *        recoverable from the app.
 *     3. Deletion needs both --apply and --yes.
 */
import process from 'node:process';

const BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--yes');
const BUCKET = 'media';

if (!BASE) { console.error('SUPABASE_URL is not set.'); process.exit(1); }
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is not set.'); process.exit(1); }
if (APPLY && !CONFIRMED) { console.error('Refusing to delete without --yes.'); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rpc(fn, body) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${fn}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function rest(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`rest ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

/** '/object/public/media/a/b.jpg' -> 'a/b.jpg' ; handles sb:// too */
function toPath(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref.startsWith('sb://')) {
    const rest = ref.slice(5);
    const slash = rest.indexOf('/');
    return slash === -1 ? null : rest.slice(slash + 1);
  }
  const mark = '/object/public/';
  const i = ref.indexOf(mark);
  if (i === -1) return null;
  const after = ref.slice(i + mark.length);
  const slash = after.indexOf('/');
  return slash === -1 ? null : after.slice(slash + 1).split('?')[0];
}

// ---------------------------------------------------------------
// 1. What does the server say is orphaned?
// ---------------------------------------------------------------
const report = await rpc('genz_find_orphan_media', { dry_run: true });
const auto = Array.isArray(report?.auto_orphans) ? report.auto_orphans : [];
const review = Array.isArray(report?.review_orphans) ? report.review_orphans : [];

// ---------------------------------------------------------------
// 2. Re-derive the live reference set locally and subtract it
// ---------------------------------------------------------------
const posts = await rest('posts?select=media_url');
const profiles = await rest('profiles?select=avatar_url,cover_url');

const referenced = new Set();
for (const p of posts) {
  const path = toPath(p.media_url);
  if (path) referenced.add(path);
}
for (const p of profiles) {
  for (const column of ['avatar_url', 'cover_url']) {
    const path = toPath(p[column]);
    if (path) referenced.add(path);
  }
}

const candidates = [...new Set([...auto, ...review])];
const protectedHits = [];
const deletable = [];
for (const path of candidates) {
  if (referenced.has(path)) { protectedHits.push(path); continue; }
  if (path.startsWith('avatars/')) { protectedHits.push(path); continue; }
  deletable.push(path);
}

console.log(`\n  project:      ${BASE}`);
console.log(`  mode:         ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  posts rows:   ${posts.length}   profiles rows: ${profiles.length}`);
console.log(`  server says:  ${auto.length} auto, ${review.length} review`);
console.log(`  candidates:   ${candidates.length}`);
console.log(`  protected:    ${protectedHits.length}${protectedHits.length ? '  <- kept' : ''}`);
console.log(`  to delete:    ${deletable.length}`);

for (const p of protectedHits.slice(0, 25)) console.log(`    KEEP ${p}`);
for (const p of deletable.slice(0, 40)) console.log(`    DEL  ${p}`);
if (deletable.length > 40) console.log(`    ... ${deletable.length - 40} more`);

if (!APPLY) {
  console.log('\n  Nothing deleted. Re-run with --apply --yes to execute.\n');
  process.exit(0);
}
if (!deletable.length) {
  console.log('\n  Nothing to delete.\n');
  process.exit(0);
}

// ---------------------------------------------------------------
// 3. Batch delete through the Storage API
// ---------------------------------------------------------------
const res = await fetch(`${BASE}/storage/v1/object/${BUCKET}`, {
  method: 'DELETE',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefixes: deletable }),
});
const body = await res.text();
console.log(`\n  storage delete -> ${res.status} ${body.slice(0, 200)}`);
if (!res.ok) process.exit(1);

// ---------------------------------------------------------------
// 4. Prove it, from the server's own count
// ---------------------------------------------------------------
const after = await rpc('genz_find_orphan_media', { dry_run: true });
console.log(`  after: ${after.auto_count} auto, ${after.review_count} review remaining\n`);
if (after.auto_count === 0 && after.review_count === 0) {
  console.log('  Every unreferenced object is gone.\n');
} else {
  console.log('  Some objects remain — re-run to see what the server still classifies.\n');
}
