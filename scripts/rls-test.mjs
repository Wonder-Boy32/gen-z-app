#!/usr/bin/env node
/**
 * rls-test.mjs — end-to-end Row Level Security proof against a LIVE project.
 *
 * WHY THIS EXISTS
 *   Policy bugs do not raise. A missing SELECT policy makes an UPDATE match
 *   zero rows and return 200, which is why `conversations` silently ignored
 *   every edit for months. You cannot catch that by reading SQL, and you
 *   cannot catch it from the service key, which bypasses RLS entirely.
 *   So this creates three real accounts, gets real JWTs, and checks that
 *   each boundary actually holds.
 *
 * WHAT IT ASSERTS
 *   T1  a user cannot write another user's profile
 *   T2  a participant CAN update their conversation   (the 01 fix, positive)
 *   T3  a non-participant CANNOT update it            (the 01 fix, negative)
 *   T4  mutes are owner-only, and cannot be forged for someone else
 *   T5  chat-media is readable by members, not by outsiders
 *   T6  a client cannot extend a Drop's life past seven days
 *   T7  messages of a conversation are invisible to a non-participant
 *
 * SAFETY
 *   Creates three clearly-named accounts, then deletes them and everything
 *   they made, in a finally block, even on failure. Only touches rows it
 *   created. Refuses to run against a project whose URL does not contain
 *   "supabase.co".
 *
 * USAGE
 *   node --env-file=.env --env-file=scripts/.secrets.env scripts/rls-test.mjs
 */
import process from 'node:process';

const BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RUN = `rls${Date.now().toString(36)}`;

if (!BASE || !ANON || !SERVICE) {
  console.error('Need SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!BASE.includes('supabase.co')) {
  console.error(`Refusing to run against ${BASE}`);
  process.exit(1);
}

const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const results = [];
const cleanup = { users: [], conversationId: null, postId: null, storage: [] };

function check(id, title, passed, evidence) {
  results.push({ id, title, passed, evidence });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id}  ${title}\n        ${evidence}`);
}

async function api(path, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { apikey: ANON, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, json, text };
}

async function createUser(label) {
  const email = `rls.${RUN}.${label}@example.com`;
  const password = `Rls!${RUN}${label}9x`;
  const made = await api('/auth/v1/admin/users', {
    method: 'POST',
    headers: SVC,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!made.ok) throw new Error(`create ${label}: ${made.status} ${made.text.slice(0, 200)}`);
  const id = made.json.id;
  cleanup.users.push({ id, email });

  const signin = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) throw new Error(`signin ${label}: ${signin.status} ${signin.text.slice(0, 200)}`);
  return { id, email, token: signin.json.access_token };
}

// ------------------------------------------------------------------
(async () => {
  console.log(`\n  project: ${BASE}`);
  console.log(`  run id:  ${RUN}\n`);

  const A = await createUser('a');
  const B = await createUser('b');
  const C = await createUser('c');
  console.log(`  created 3 accounts (a,b,c) and signed in\n`);

  // Seed a DM between A and B using the service key (bypasses RLS).
  const conv = await api('/rest/v1/conversations', {
    method: 'POST',
    headers: { ...SVC, Prefer: 'return=representation' },
    body: JSON.stringify({ type: 'direct', created_by: A.id }),
  });
  const convId = conv.json[0].id;
  cleanup.conversationId = convId;
  await api('/rest/v1/conversation_participants', {
    method: 'POST',
    headers: { ...SVC, Prefer: 'return=minimal' },
    body: JSON.stringify([
      { conversation_id: convId, user_id: A.id },
      { conversation_id: convId, user_id: B.id },
    ]),
  });

  // ---- T1: profile write isolation -------------------------------
  const t1 = await api(`/rest/v1/profiles?id=eq.${B.id}`, {
    method: 'PATCH',
    token: A.token,
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'pwned-by-A' }),
  });
  const bAfter = await api(`/rest/v1/profiles?select=display_name&id=eq.${B.id}`, { headers: SVC });
  const changed = Array.isArray(t1.json) && t1.json.length > 0;
  const bName = bAfter.json?.[0]?.display_name ?? null;
  check('T1', 'A cannot write B\'s profile', !changed && bName !== 'pwned-by-A',
    `PATCH returned ${changed ? t1.json.length : 0} row(s); B.display_name is now ${JSON.stringify(bName)}`);

  // ---- T2: participant CAN update the conversation ----------------
  const t2 = await api(`/rest/v1/conversations?id=eq.${convId}`, {
    method: 'PATCH',
    token: A.token,
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: `${RUN} renamed by A` }),
  });
  check('T2', 'participant can update the conversation', t2.ok && Array.isArray(t2.json) && t2.json.length === 1,
    `status ${t2.status}, ${Array.isArray(t2.json) ? t2.json.length : 'n/a'} row(s) affected`);

  // ---- T3: non-participant CANNOT update it ----------------------
  const t3 = await api(`/rest/v1/conversations?id=eq.${convId}`, {
    method: 'PATCH',
    token: C.token,
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: `${RUN} renamed by C` }),
  });
  const convAfter = await api(`/rest/v1/conversations?select=name&id=eq.${convId}`, { headers: SVC });
  const convName = convAfter.json?.[0]?.name ?? null;
  check('T3', 'non-participant cannot update it', !(Array.isArray(t3.json) && t3.json.length > 0) && convName !== `${RUN} renamed by C`,
    `status ${t3.status}, ${Array.isArray(t3.json) ? t3.json.length : 0} row(s) affected; name is ${JSON.stringify(convName)}`);

  // ---- T4: mutes are owner-only ----------------------------------
  const own = await api('/rest/v1/muted_users', {
    method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: A.id, muted_id: B.id }),
  });
  const forged = await api('/rest/v1/muted_users', {
    method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: B.id, muted_id: C.id }),
  });
  const visible = await api('/rest/v1/muted_users?select=user_id,muted_id', { token: A.token });
  const leaks = Array.isArray(visible.json) ? visible.json.filter((r) => r.user_id !== A.id).length : -1;
  check('T4', 'mutes are owner-only and cannot be forged',
    own.ok && !forged.ok && leaks === 0,
    `own insert ${own.status}, forged insert ${forged.status} (want non-2xx), other users' rows visible to A: ${leaks}`);

  // ---- T5: chat-media readable by members only -------------------
  const objectPath = `${convId}/${A.id}/rls-${RUN}.txt`;
  const up = await fetch(`${BASE}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${A.token}`, 'Content-Type': 'text/plain', 'x-upsert': 'true' },
    body: `probe ${RUN}`,
  });
  cleanup.storage.push({ bucket: 'chat-media', path: objectPath });
  const asMember = await fetch(`${BASE}/storage/v1/object/chat-media/${objectPath}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${B.token}` },
  });
  await asMember.arrayBuffer().catch(() => {});
  const asOutsider = await fetch(`${BASE}/storage/v1/object/chat-media/${objectPath}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${C.token}` },
  });
  await asOutsider.arrayBuffer().catch(() => {});
  check('T5', 'chat-media: member reads, outsider cannot',
    up.ok && asMember.ok && !asOutsider.ok,
    `upload ${up.status}, member read ${asMember.status} (want 200), outsider read ${asOutsider.status} (want 4xx)`);

  // ---- T6: cannot extend a Drop past seven days ------------------
  const insertPost = await api('/rest/v1/posts', {
    method: 'POST', token: A.token, headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: A.id,
      media_url: `https://example.invalid/${RUN}.jpg`,
      media_type: 'image',
      caption: `rls ${RUN}`,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    }),
  });
  const postId = Array.isArray(insertPost.json) ? insertPost.json[0]?.id : null;
  cleanup.postId = postId;
  let t6ok = false;
  let t6ev = `insert ${insertPost.status} ${insertPost.text.slice(0, 120)}`;
  if (postId) {
    const row = await api(`/rest/v1/posts?select=created_at,expires_at&id=eq.${postId}`, { headers: SVC });
    const r = row.json?.[0];
    if (r) {
      const lifeDays = (new Date(r.expires_at) - new Date(r.created_at)) / 864e5;
      t6ok = lifeDays > 0 && lifeDays <= 7.01;
      t6ev = `requested 30 days, stored lifetime ${lifeDays.toFixed(3)} days`;
    }
  }
  check('T6', 'a client cannot extend a Drop past 7 days', t6ok, t6ev);

  // ---- T7: messages invisible to non-participant -----------------
  await api('/rest/v1/messages', {
    method: 'POST', headers: { ...SVC, Prefer: 'return=minimal' },
    // `messages.body` is JSONB and messages_body_valid_chk requires the shape
    // be right for the kind: a 'text' message must carry { "text": ... }.
    // A plain string is rejected with 23514, which is the constraint doing its
    // job — this fixture was wrong the first time, not the schema.
    body: JSON.stringify({
      conversation_id: convId,
      sender_id: A.id,
      msg_type: 'text',
      body: { text: `secret ${RUN}` },
      content: `secret ${RUN}`,
    }),
  });
  const asC = await api(`/rest/v1/messages?select=id&conversation_id=eq.${convId}`, { token: C.token });
  const asA = await api(`/rest/v1/messages?select=id&conversation_id=eq.${convId}`, { token: A.token });
  check('T7', 'messages: participant reads, outsider sees none',
    Array.isArray(asC.json) && asC.json.length === 0 && Array.isArray(asA.json) && asA.json.length > 0,
    `C saw ${Array.isArray(asC.json) ? asC.json.length : 'n/a'}, A saw ${Array.isArray(asA.json) ? asA.json.length : 'n/a'}`);
})()
  .catch((e) => {
    console.log(`\n  ABORTED: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // ---------------------------------------------------------------
    // CLEANUP — always, in reverse order. The conversation cascades to
    // participants and messages; the users cascade to their profiles.
    // ---------------------------------------------------------------
    console.log('\n  cleanup:');
    for (const s of cleanup.storage) {
      const res = await fetch(`${BASE}/storage/v1/object/${s.bucket}`, {
        method: 'DELETE',
        headers: { ...SVC },
        body: JSON.stringify({ prefixes: [s.path] }),
      }).catch(() => null);
      console.log(`    storage ${s.bucket}/${s.path}: ${res ? res.status : 'error'}`);
    }
    if (cleanup.postId) {
      const r = await api(`/rest/v1/posts?id=eq.${cleanup.postId}`, { method: 'DELETE', headers: { ...SVC, Prefer: 'return=minimal' } });
      console.log(`    post: ${r.status}`);
    }
    if (cleanup.conversationId) {
      const r = await api(`/rest/v1/conversations?id=eq.${cleanup.conversationId}`, { method: 'DELETE', headers: { ...SVC, Prefer: 'return=minimal' } });
      console.log(`    conversation (cascades participants+messages): ${r.status}`);
    }
    for (const u of cleanup.users) {
      await api('/rest/v1/muted_users?user_id=eq.' + u.id, { method: 'DELETE', headers: { ...SVC, Prefer: 'return=minimal' } });
      const r = await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: SVC });
      console.log(`    user ${u.email}: ${r.status}`);
    }

    const failed = results.filter((r) => !r.passed);
    console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log(`  FAILED: ${failed.map((f) => f.id).join(', ')}\n`);
      process.exitCode = 1;
    } else {
      console.log('  Every boundary held.\n');
    }
  });
