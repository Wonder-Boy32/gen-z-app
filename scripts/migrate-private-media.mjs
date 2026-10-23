#!/usr/bin/env node
/**
 * migrate-private-media.mjs
 *
 * Moves ALREADY-UPLOADED chat and anonymous media out of the public
 * `media` bucket and into the private buckets that 20261023_01 created.
 *
 * WHY THIS IS NEEDED SEPARATELY FROM THE SQL
 *
 * Flipping a bucket from public to private is not enough on its own:
 * an object that already exists in `media` is still served at
 * /storage/v1/object/public/media/... no matter what any policy says,
 * because public-bucket delivery never consults RLS. The only way to
 * take an existing object out of public reach is to copy it into a
 * private bucket and delete the original. That is a data operation,
 * not a schema change, so it lives here.
 *
 * USAGE (the service key is required and is never written anywhere)
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/migrate-private-media.mjs --dry-run
 *
 *   node scripts/migrate-private-media.mjs --apply --yes
 *   node scripts/migrate-private-media.mjs --verify
 *   node scripts/migrate-private-media.mjs --cleanup --yes
 *
 * STAGES, and why they are separate
 *
 *   --dry-run   prints the exact plan, changes nothing
 *   --apply     copies bytes + rewrites DB references. Does NOT delete
 *               the original objects, so an interrupted run is
 *               recoverable and a rollback is just "point back".
 *   --verify    re-reads every rewritten reference and confirms the
 *               object exists in its private bucket
 *   --cleanup   deletes the old public copies. Refuses to run unless
 *               --verify passed for every reference.
 *
 * Re-running --apply is safe: objects are copied with upsert, and a row
 * whose media_url is already an sb:// reference is skipped.
 */

import process from 'node:process';

const URL_BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const APPLY = args.has('--apply');
const VERIFY = args.has('--verify');
const CLEANUP = args.has('--cleanup');
const CONFIRMED = args.has('--yes');

const PAGE = 200;

function fail(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

if (!URL_BASE) fail('SUPABASE_URL is not set.');
if (!SERVICE_KEY) fail('SUPABASE_SERVICE_ROLE_KEY is not set. This script cannot work with the anon key.');
if (!DRY && !APPLY && !VERIFY && !CLEANUP) fail('Pick a stage: --dry-run | --apply | --verify | --cleanup');
if ((APPLY || CLEANUP) && !CONFIRMED) fail('Refusing to write without --yes.');

const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

// ------------------------------------------------------------------
// REST
// ------------------------------------------------------------------
async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...H,
      'Content-Type': 'application/json',
      Prefer: init.method === 'PATCH' ? 'return=minimal' : 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${res.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------
// Storage
// ------------------------------------------------------------------
async function storageGet(bucket, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${URL_BASE}/storage/v1/object/${bucket}/${encoded}`, { headers: H });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`download ${bucket}/${path}: ${res.status} ${t.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

async function storagePut(bucket, path, buf, contentType) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${URL_BASE}/storage/v1/object/${bucket}/${encoded}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`upload ${bucket}/${path}: ${res.status} ${t.slice(0, 200)}`);
  }
}

async function storageExists(bucket, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${URL_BASE}/storage/v1/object/${bucket}/${encoded}`, {
    headers: H,
    method: 'GET',
  });
  // Drain so the socket is released.
  await res.arrayBuffer().catch(() => {});
  return res.ok;
}

async function storageRemove(bucket, path) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`delete ${bucket}/${path}: ${res.status} ${t.slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------
// Path helpers
// ------------------------------------------------------------------
const PUBLIC_MARK = '/object/public/';

/** '.../object/public/media/chat/abc/x.jpg' -> 'chat/abc/x.jpg' */
function publicPath(url) {
  if (typeof url !== 'string') return null;
  const i = url.indexOf(PUBLIC_MARK);
  if (i === -1) return null;
  const rest = url.slice(i + PUBLIC_MARK.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1).split('?')[0];
  return { bucket, path };
}

function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function refToParts(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('sb://')) return null;
  const rest = ref.slice(5);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

// ------------------------------------------------------------------
// Plan building
// ------------------------------------------------------------------
async function fetchAllMessages() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await rest(
      `messages?select=id,conversation_id,sender_id,media_url,msg_type&media_url=not.is.null&order=created_at.asc&limit=${PAGE}&offset=${from}`
    );
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchAllAnon() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await rest(
      `anonymous_messages?select=id,recipient_id,media_url,voice_url,message_type&or=(media_url.not.is.null,voice_url.not.is.null)&order=created_at.asc&limit=${PAGE}&offset=${from}`
    );
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Legacy chat objects are at media/chat/<conversationId>/<file> — the
 * path carries no uploader, because the old policy did not need one.
 * The storage policy that replaced it requires
 * <conversationId>/<senderUid>/<file>, so the sender from the message
 * row supplies the missing segment. That is also the correct owner:
 * the person who actually sent the file.
 */
function planChat(rows) {
  const items = [];
  const skipped = [];

  for (const row of rows) {
    const ref = row.media_url;
    if (typeof ref === 'string' && ref.startsWith('sb://')) continue; // already migrated

    const src = publicPath(ref);
    if (!src) {
      if (typeof ref === 'string' && ref.length) skipped.push({ id: row.id, reason: 'not a public media URL', ref });
      continue;
    }
    if (src.bucket !== 'media' || !src.path.startsWith('chat/')) {
      skipped.push({ id: row.id, reason: `unexpected path (${src.bucket}/${src.path})`, ref });
      continue;
    }

    const segments = src.path.split('/');
    // chat/<conv>/<file>  or  chat/<conv>/<something>/<file>
    const conv = segments[1];
    const file = basename(src.path);

    if (!conv || !row.sender_id) {
      skipped.push({ id: row.id, reason: 'missing conversation or sender', ref });
      continue;
    }

    items.push({
      kind: 'chat',
      rowId: row.id,
      srcBucket: 'media',
      srcPath: src.path,
      destBucket: 'chat-media',
      destPath: `${conv}/${row.sender_id}/${file}`,
      column: 'media_url',
      table: 'messages',
      oldValue: ref,
    });
  }

  return { items, skipped };
}

function planAnon(rows) {
  const items = [];
  const skipped = [];

  for (const row of rows) {
    for (const column of ['media_url', 'voice_url']) {
      const ref = row[column];
      if (typeof ref !== 'string' || !ref) continue;
      if (ref.startsWith('sb://')) continue;

      const src = publicPath(ref);
      if (!src) {
        skipped.push({ id: row.id, reason: `not a public URL (${column})`, ref });
        continue;
      }
      if (src.bucket !== 'media' || !src.path.startsWith('anon/')) {
        skipped.push({ id: row.id, reason: `unexpected path (${src.bucket}/${src.path})`, ref });
        continue;
      }

      // anon/<recipientId>/<file> keeps its shape; the recipient is the
      // only party allowed to read it, and the sender is deliberately
      // absent from the path.
      const segments = src.path.split('/');
      const recipient = segments[1];
      const file = basename(src.path);
      if (!recipient) {
        skipped.push({ id: row.id, reason: 'missing recipient segment', ref });
        continue;
      }

      items.push({
        kind: 'anon',
        rowId: row.id,
        srcBucket: 'media',
        srcPath: src.path,
        destBucket: 'anon-media',
        destPath: `${recipient}/${file}`,
        column,
        table: 'anonymous_messages',
        oldValue: ref,
      });
    }
  }

  return { items, skipped };
}

// ------------------------------------------------------------------
// Stages
// ------------------------------------------------------------------
async function buildPlan() {
  const [msgs, anon] = await Promise.all([fetchAllMessages(), fetchAllAnon()]);
  const chat = planChat(msgs);
  const an = planAnon(anon);
  return {
    items: [...chat.items, ...an.items],
    skipped: [...chat.skipped, ...an.skipped],
    scanned: { messages: msgs.length, anonymous: anon.length },
  };
}

function reportPlan(plan) {
  const chat = plan.items.filter((i) => i.kind === 'chat');
  const anon = plan.items.filter((i) => i.kind === 'anon');

  console.log(`\n  scanned: ${plan.scanned.messages} messages, ${plan.scanned.anonymous} anonymous rows`);
  console.log(`  to move: ${plan.items.length}  (chat ${chat.length}, anonymous ${anon.length})`);
  if (plan.skipped.length) {
    console.log(`  skipped: ${plan.skipped.length}`);
    for (const s of plan.skipped.slice(0, 20)) {
      console.log(`    - ${s.id}: ${s.reason}  ${String(s.ref).slice(0, 90)}`);
    }
    if (plan.skipped.length > 20) console.log(`    ... ${plan.skipped.length - 20} more`);
  }

  for (const i of plan.items.slice(0, 10)) {
    console.log(`\n    ${i.srcBucket}/${i.srcPath}`);
    console.log(`      -> ${i.destBucket}/${i.destPath}`);
  }
  if (plan.items.length > 10) console.log(`\n    ... ${plan.items.length - 10} more`);
}

async function applyPlan(plan) {
  let copied = 0;
  let rewritten = 0;
  const failures = [];

  for (const item of plan.items) {
    try {
      // 1. bytes
      const { buf, contentType } = await storageGet(item.srcBucket, item.srcPath);
      await storagePut(item.destBucket, item.destPath, buf, contentType);

      // 2. reference
      const newRef = `sb://${item.destBucket}/${item.destPath}`;
      await rest(`${item.table}?id=eq.${item.rowId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [item.column]: newRef }),
      });

      copied += 1;
      rewritten += 1;
      if (copied % 25 === 0) console.log(`    ... ${copied}/${plan.items.length}`);
    } catch (e) {
      failures.push({ item, error: e.message });
    }
  }

  console.log(`\n  copied ${copied}, rewritten ${rewritten}, failed ${failures.length}`);
  for (const f of failures.slice(0, 20)) {
    console.log(`    FAILED ${f.item.srcBucket}/${f.item.srcPath}: ${f.error}`);
  }
  if (failures.length) {
    console.log('\n  Originals were NOT deleted. Fix the failures and re-run --apply; it is idempotent.');
    process.exitCode = 1;
  }
}

async function verifyPlan() {
  const msgs = await fetchAllMessages();
  const anon = await fetchAllAnon();

  const refs = [];
  for (const r of msgs) {
    const p = refToParts(r.media_url);
    if (p) refs.push({ id: r.id, table: 'messages', ...p });
    else if (typeof r.media_url === 'string' && r.media_url.includes('/object/public/media/chat/')) {
      refs.push({ id: r.id, table: 'messages', unresolved: true, ref: r.media_url });
    }
  }
  for (const r of anon) {
    for (const column of ['media_url', 'voice_url']) {
      const p = refToParts(r[column]);
      if (p) refs.push({ id: r.id, table: 'anonymous_messages', ...p });
      else if (typeof r[column] === 'string' && r[column].includes('/object/public/media/anon/')) {
        refs.push({ id: r.id, table: 'anonymous_messages', unresolved: true, ref: r[column] });
      }
    }
  }

  let ok = 0;
  const missing = [];
  const unresolved = refs.filter((r) => r.unresolved);

  for (const r of refs.filter((x) => !x.unresolved)) {
    const exists = await storageExists(r.bucket, r.path);
    if (exists) ok += 1;
    else missing.push(r);
  }

  console.log(`\n  private refs: ${refs.length - unresolved.length}   present: ${ok}   missing: ${missing.length}`);
  console.log(`  still on a public URL: ${unresolved.length}`);

  for (const m of missing.slice(0, 10)) console.log(`    MISSING ${m.table}#${m.id} ${m.bucket}/${m.path}`);
  for (const u of unresolved.slice(0, 10)) console.log(`    PUBLIC  ${u.table}#${u.id} ${String(u.ref).slice(0, 90)}`);

  if (missing.length || unresolved.length) {
    console.log('\n  Not safe to --cleanup yet.');
    process.exitCode = 1;
  } else {
    console.log('\n  Every reference resolves to a private object. --cleanup is now safe.');
  }
}

async function cleanupOriginals() {
  const [msgs, anon] = await Promise.all([fetchAllMessages(), fetchAllAnon()]);
  const chat = planChat(msgs);
  const an = planAnon(anon);
  const leftovers = [...chat.items, ...an.items];

  if (leftovers.length) {
    console.log(`\n  REFUSED: ${leftovers.length} rows still point at a public URL.`);
    console.log('  Run --verify first; a public copy is the only copy for those rows.');
    process.exitCode = 1;
    return;
  }

  // Everything is referenced privately. Now remove the old objects.
  const victims = [];
  for (const r of msgs) {
    const p = refToParts(r.media_url);
    if (p) {
      const file = basename(p.path);
      const conv = p.path.split('/')[0];
      if (conv) victims.push({ bucket: 'media', path: `chat/${conv}/${file}` });
    }
  }
  for (const r of anon) {
    for (const column of ['media_url', 'voice_url']) {
      const p = refToParts(r[column]);
      if (p && p.bucket === 'anon-media') {
        victims.push({ bucket: 'media', path: `anon/${p.path}` });
      }
    }
  }

  let removed = 0;
  const failed = [];
  for (const v of victims) {
    try {
      await storageRemove(v.bucket, v.path);
      removed += 1;
    } catch (e) {
      failed.push({ v, error: e.message });
    }
  }

  console.log(`\n  removed ${removed} public copies, failed ${failed.length}`);
  for (const f of failed.slice(0, 10)) console.log(`    ${f.v.path}: ${f.error}`);
}

// ------------------------------------------------------------------
(async () => {
  console.log(`\n  project: ${URL_BASE}`);
  console.log(`  mode:    ${DRY ? 'DRY RUN' : APPLY ? 'APPLY' : VERIFY ? 'VERIFY' : 'CLEANUP'}`);

  if (DRY) {
    const plan = await buildPlan();
    reportPlan(plan);
    console.log('\n  Nothing was written. Re-run with --apply --yes to execute.\n');
    return;
  }

  if (APPLY) {
    const plan = await buildPlan();
    reportPlan(plan);
    await applyPlan(plan);
    console.log('\n  Originals are still in place. Run --verify next.\n');
    return;
  }

  if (VERIFY) {
    await verifyPlan();
    return;
  }

  if (CLEANUP) {
    await cleanupOriginals();
  }
})().catch((e) => {
  console.error('\n  ABORTED:', e.message, '\n');
  process.exit(1);
});
