#!/usr/bin/env node
/**
 * privacy-audit.mjs — proofs about what ONE user can learn about ANOTHER.
 *
 * WHY THIS IS SEPARATE FROM rls-test.mjs
 *   rls-test.mjs proves the messaging boundaries. This file proves the privacy
 *   ones: private profiles, per-post visibility, view-once media, anonymous
 *   senders, drafts, notifications, profile view counts, push tokens and
 *   privilege fields a client must never be able to set on itself.
 *
 *   Every check creates its own fixtures and deletes them again, so it is safe
 *   to run against the live project repeatedly.
 *
 * USAGE
 *   node --env-file=.env --env-file=scripts/.secrets.env scripts/privacy-audit.mjs
 */
import process from 'node:process';

const BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RUN = `pv${Date.now().toString(36)}`;

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
const cleanup = { users: [], posts: [], conversationId: null, draftIds: [], tokenIds: [] };

function check(id, title, passed, evidence) {
  results.push({ id, title, passed, evidence });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id}  ${title}`);
  console.log(`         ${evidence}`);
}

async function api(path, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { apikey: ANON, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, json, text };
}

const rows = (r) => (Array.isArray(r.json) ? r.json : []);
const svc = (path, init = {}) => api(path, { ...init, headers: { ...SVC, ...(init.headers || {}) } });
const svcInsert = (table, body) =>
  svc(`/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });

async function createUser(label) {
  const email = `${RUN}.${label}@example.com`;
  const password = `Pv!${RUN}${label}9x`;
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

async function makePost(ownerId, fields) {
  const r = await svcInsert('posts', {
    user_id: ownerId,
    media_url: `https://example.invalid/${RUN}.jpg`,
    media_type: 'image',
    caption: `privacy ${RUN}`,
    ...fields,
  });
  const id = rows(r)[0]?.id ?? null;
  if (id) cleanup.posts.push(id);
  return id;
}

// ------------------------------------------------------------------
(async () => {
  console.log(`\n  project: ${BASE}`);
  console.log(`  run id:  ${RUN}\n`);

  // A = the user whose privacy we are testing. C = an unrelated stranger.
  const A = await createUser('a');
  const C = await createUser('c');
  console.log('  created 2 accounts and signed in\n');

  // ------------------------------------------------ P1 private profile
  {
    const postId = await makePost(A.id, { visibility: 'everyone' });
    await svc(`/rest/v1/profiles?id=eq.${A.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ is_private: true }),
    });
    const seen = await api(`/rest/v1/posts?select=id&id=eq.${postId}`, { token: C.token });
    check(
      'P1',
      'a private profile hides its posts from a stranger',
      rows(seen).length === 0,
      `stranger saw ${rows(seen).length} of A's public post(s) while A.is_private = true`
    );
    await svc(`/rest/v1/profiles?id=eq.${A.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return-minimal' },
      body: JSON.stringify({ is_private: false }),
    });
  }

  // ------------------------------------------------ P2 post visibility
  {
    const mine = await makePost(A.id, { visibility: 'only_me' });
    const seen = await api(`/rest/v1/posts?select=id&id=eq.${mine}`, { token: C.token });
    check(
      'P2',
      "a post set to 'Only me' is invisible to everyone else",
      rows(seen).length === 0,
      `stranger saw ${rows(seen).length} row(s) for a visibility='only_me' post`
    );
  }
  {
    const followersOnly = await makePost(A.id, { visibility: 'followers' });
    const seen = await api(`/rest/v1/posts?select=id&id=eq.${followersOnly}`, { token: C.token });
    check(
      'P3',
      "a post set to 'Followers' is invisible to a non-follower",
      rows(seen).length === 0,
      `non-follower saw ${rows(seen).length} row(s) for a visibility='followers' post`
    );
  }

  // ------------------------------------------------ P4 cannot pre-age a Drop
  //
  // The first version of this check inserted a post with expires_at in 2020 and
  // expected it to be invisible. It was visible — because the BEFORE INSERT
  // trigger had already rewritten expires_at to +7 days, so there was no
  // expired row to read. The fixture was wrong, not the schema. The invariant
  // worth testing is that the clamp cannot be walked around, since that is what
  // makes "it disappears" true at all.
  {
    const created = await makePost(A.id, {
      visibility: 'everyone',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const row = await svc(`/rest/v1/posts?select=expires_at,created_at&id=eq.${created}`);
    const r = rows(row)[0];
    const lifeDays = r ? (new Date(r.expires_at) - new Date(r.created_at)) / 864e5 : -1;
    check(
      'P4',
      'a request cannot pre-age a Drop past its own expiry',
      lifeDays > 0 && lifeDays <= 7.01,
      `asked for an already-expired post; stored lifetime is ${lifeDays.toFixed(3)} days`
    );
  }

  // ------------------------------------------------ P5 privilege fields
  {
    const before = await svc(`/rest/v1/profiles?select=verified,lifetime_likes,total_likes_received&id=eq.${A.id}`);
    await api(`/rest/v1/profiles?id=eq.${A.id}`, {
      method: 'PATCH',
      token: A.token,
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ verified: true, lifetime_likes: 999999, total_likes_received: 888888 }),
    });
    const after = await svc(`/rest/v1/profiles?select=verified,lifetime_likes,total_likes_received&id=eq.${A.id}`);
    const b = rows(before)[0] ?? {};
    const a = rows(after)[0] ?? {};
    check(
      'P5',
      'a client cannot make itself verified',
      a.verified === b.verified,
      `verified was ${b.verified}, is now ${a.verified}`
    );
    check(
      'P6',
      'a client cannot inflate its own like totals',
      a.lifetime_likes === b.lifetime_likes && a.total_likes_received === b.total_likes_received,
      `lifetime_likes ${b.lifetime_likes} -> ${a.lifetime_likes}, total_likes_received ${b.total_likes_received} -> ${a.total_likes_received}`
    );
  }

  // ------------------------------------------------ P7 admin escalation
  {
    const grab = await api('/rest/v1/admin_users', {
      method: 'POST',
      token: A.token,
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: A.id, role: 'owner' }),
    });
    check(
      'P7',
      'a client cannot add itself to the admin table',
      !grab.ok || rows(grab).length === 0,
      `status ${grab.status} ${grab.text.slice(0, 100)}`
    );
  }

  // ------------------------------------------------ P8 drafts
  {
    const d = await svcInsert('drafts', { user_id: A.id, payload: { secret: RUN } });
    const id = rows(d)[0]?.id;
    if (id) cleanup.draftIds.push(id);
    const peek = await api('/rest/v1/drafts?select=payload', { token: C.token });
    check('P8', "another user cannot read someone's draft", rows(peek).length === 0, `stranger saw ${rows(peek).length} draft row(s)`);
  }

  // ------------------------------------------------ P9 notifications
  {
    await svcInsert('notifications', {
      user_id: A.id,
      actor_id: C.id,
      type: 'like',
      read: false,
      created_at: new Date().toISOString(),
    });
    const peek = await api('/rest/v1/notifications?select=id,user_id', { token: C.token });
    const leaks = rows(peek).filter((r) => r.user_id !== C.id).length;
    check('P9', "another user cannot read someone's notifications", leaks === 0, `stranger saw ${leaks} row(s) belonging to someone else`);
  }

  // ------------------------------------------------ P10 profile views
  {
    await svcInsert('profile_views', { profile_id: A.id, viewer_id: C.id, view_count: 1 }).catch(() => null);
    const peek = await api(`/rest/v1/profile_views?select=profile_id,viewer_id&profile_id=eq.${A.id}`, { token: C.token });
    const mineToSee = rows(peek)[0];
    const peekAll = await api('/rest/v1/profile_views?select=profile_id,viewer_id', { token: C.token });
    const others = rows(peekAll).filter((r) => r.profile_id !== C.id).length;
    check(
      'P10',
      "a user cannot read who viewed someone else's profile",
      others === 0,
      `stranger saw ${others} row(s) of other people's view records (own row visible: ${!!mineToSee})`
    );
  }

  // ------------------------------------------------ P11 push tokens
  {
    const t = await svcInsert('push_tokens', { user_id: A.id, token: `ExponentPushToken[${RUN}]`, platform: 'android' });
    const id = rows(t)[0]?.id;
    if (id) cleanup.tokenIds.push(id);
    const peek = await api('/rest/v1/push_tokens?select=token,user_id', { token: C.token });
    const leaks = rows(peek).filter((r) => r.user_id !== C.id).length;
    check('P11', "another user cannot read someone's push tokens", leaks === 0, `stranger saw ${leaks} foreign token(s)`);
  }

  // ------------------------------------------------ P12 anonymous sender
  {
    await svcInsert('anonymous_settings', { user_id: A.id, enabled: true, who: 'anyone' }).catch(() => null);
    const sent = await api('/rest/v1/rpc/send_anonymous_message', {
      method: 'POST',
      token: C.token,
      body: JSON.stringify({ p_recipient: A.id, p_content: `anon ${RUN}` }),
    });
    const viaView = await api(`/rest/v1/anonymous_messages_public?select=*`, { token: A.token });
    const viaBase = await api(`/rest/v1/anonymous_messages?select=sender_id`, { token: A.token });
    const leaked = rows(viaView).some((r) => 'sender_id' in r);
    const baseLeak = rows(viaBase).some((r) => r.sender_id);
    check(
      'P12',
      'the recipient cannot learn who sent an anonymous message',
      !leaked && !baseLeak,
      `sent ${sent.status}; view row exposes sender_id: ${leaked}; base table read returned ${viaBase.status} with ${rows(viaBase).length} row(s)`
    );
  }

  // ------------------------------------------------ P13 view-once media
  {
    const conv = await svcInsert('conversations', { type: 'direct', created_by: A.id });
    const convId = rows(conv)[0]?.id;
    cleanup.conversationId = convId;
    if (convId) {
      await svcInsert('conversation_participants', [
        { conversation_id: convId, user_id: A.id },
        { conversation_id: convId, user_id: C.id },
      ]);
      const msg = await svcInsert('messages', {
        conversation_id: convId,
        sender_id: C.id,
        msg_type: 'image',
        body: { url: `https://example.invalid/${RUN}-vo.jpg` },
        media_url: `https://example.invalid/${RUN}-vo.jpg`,
        view_once: true,
      });
      const msgId = rows(msg)[0]?.id;
      if (msgId) {
        const first = await api('/rest/v1/rpc/consume_view_once', {
          method: 'POST',
          token: A.token,
          body: JSON.stringify({ p_message: msgId }),
        });
        const reread = await api(`/rest/v1/messages?select=media_url,body,view_once_consumed_at&id=eq.${msgId}`, { token: A.token });
        const row = rows(reread)[0] ?? {};
        const stillHasMedia = !!(row.media_url || (row.body && row.body.url));
        const second = await api('/rest/v1/rpc/consume_view_once', {
          method: 'POST',
          token: A.token,
          body: JSON.stringify({ p_message: msgId }),
        });
        const secondRefused = !second.ok || !(second.json && second.json.media_ref);

        const senderTry = await api('/rest/v1/rpc/consume_view_once', {
          method: 'POST',
          token: C.token, // C is the sender of this moment
          body: JSON.stringify({ p_message: msgId }),
        });

        check(
          'P13',
          'view-once media is consumed by the server, once',
          first.ok &&
            !!first.json?.media_ref &&
            !stillHasMedia &&
            secondRefused,
          `consume ${first.status} (ref ${!!first.json?.media_ref}); pointer left in the row afterwards: ${stillHasMedia}; second consume refused: ${secondRefused}; sender consume ${senderTry.status}`
        );
      } else {
        check('P13', 'view-once media is consumed by the server, once', false, `fixture message could not be created: ${msg.text.slice(0, 120)}`);
      }
    }
  }

  // ------------------------------------------------ P14 message_views
  {
    if (cleanup.conversationId) {
      const anyMsg = await api(`/rest/v1/messages?select=id&conversation_id=eq.${cleanup.conversationId}&limit=1`, { headers: SVC });
      const msgId = rows(anyMsg)[0]?.id;
      if (msgId) {
        const forge = await api('/rest/v1/message_views', {
          method: 'POST',
          token: C.token,
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify([{ message_id: msgId, user_id: A.id }]),
        });
        check('P14', "a user cannot file a read receipt as someone else", !forge.ok, `status ${forge.status}`);
      }
    }
  }

  // ------------------------------------------------ P15 message integrity
  {
    if (cleanup.conversationId) {
      const mine = await svcInsert('messages', {
        conversation_id: cleanup.conversationId,
        sender_id: C.id,
        msg_type: 'text',
        content: `original ${RUN}`,
        body: { text: `original ${RUN}` },
      });
      const msgId = rows(mine)[0]?.id;
      const forge = await api(`/rest/v1/messages?id=eq.${msgId}`, {
        method: 'PATCH',
        token: A.token,
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ content: 'FORGED', body: { text: 'FORGED' } }),
      });
      const after = await svc(`/rest/v1/messages?select=content&id=eq.${msgId}`);
      const text = rows(after)[0]?.content;
      check(
        'P15',
        "a recipient cannot rewrite the sender's message",
        text !== 'FORGED',
        `PATCH ${forge.status}; stored content is ${JSON.stringify(text)}`
      );
    }
  }

  // ------------------------------------------------ report
  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('  GAPS:');
    for (const f of failed) console.log(`    ${f.id}  ${f.title} — ${f.evidence}`);
    process.exitCode = 1;
  } else {
    console.log('  Every privacy boundary held.');
  }
})()
  .catch((e) => {
    console.log(`\n  ABORTED: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log('\n  cleanup:');
    if (cleanup.conversationId) {
      const r = await svc(`/rest/v1/conversations?id=eq.${cleanup.conversationId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      console.log(`    conversation: ${r.status}`);
    }
    for (const id of cleanup.posts) {
      await svc(`/rest/v1/posts?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    for (const id of cleanup.draftIds) {
      await svc(`/rest/v1/drafts?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    for (const id of cleanup.tokenIds) {
      await svc(`/rest/v1/push_tokens?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    for (const u of cleanup.users) {
      await svc(`/rest/v1/notifications?user_id=eq.${u.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await svc(`/rest/v1/profile_views?profile_id=eq.${u.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await svc(`/rest/v1/anonymous_settings?user_id=eq.${u.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await svc(`/rest/v1/anonymous_messages?recipient_id=eq.${u.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const r = await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: SVC });
      console.log(`    user ${u.email}: ${r.status}`);
    }
  });
