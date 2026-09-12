#!/usr/bin/env node
/**
 * GEN Z — Admin provisioning (run ONCE after applying admin_center.sql)
 *
 * Creates the initial Super Admin account from environment variables only.
 * The password is hashed by Supabase Auth (bcrypt) — it is NEVER stored
 * in source code, seed files or committed config.
 *
 * Uses plain fetch against the Supabase REST API (no SDK) so it runs on
 * any Node >= 18 without WebSocket requirements.
 *
 * Required env (see .env.example — do NOT commit .env):
 *   ADMIN_EMAIL            e.g. wonderfuldeveloper43@gmail.com
 *   ADMIN_PASSWORD         strong password (min 10 chars)
 *   ADMIN_ROLE             super_admin | admin | moderator | support | analytics
 *   SUPABASE_URL           project URL
 *   SUPABASE_SERVICE_ROLE_KEY  service role key (server-side only)
 *
 * Usage:  npm run provision
 */
import 'dotenv/config';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const role = process.env.ADMIN_ROLE ?? 'super_admin';
const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !password || !url || !key) {
  console.error('Missing env: ADMIN_EMAIL, ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see .env.example).');
  process.exit(1);
}
if (password.length < 10) {
  console.error('ADMIN_PASSWORD must be at least 10 characters.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function call(res) {
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// 1) does the auth user already exist?
const list = await call(await fetch(`${url}/auth/v1/admin/users?per_page=1000`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
}));
let userId = null;
if (list.ok && Array.isArray(list.body?.users)) {
  userId = list.body.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id ?? null;
}

if (!userId) {
  const created = await call(await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  }));
  if (!created.ok) {
    console.error('createUser failed:', JSON.stringify(created.body));
    process.exit(1);
  }
  userId = created.body.id;
  console.log(`✓ Auth user created for ${email}`);
} else {
  console.log(`✓ Auth user already exists (${email})`);
}

// 2) grant the admin role — prefer the RPC (admin_center.sql), fall back
//    to a direct service-role upsert of admin_users.
const rpc = await call(await fetch(`${url}/rest/v1/rpc/admin_admin_add`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ p_email: email, p_role: role }),
}));
if (rpc.ok) {
  console.log(`✓ admin_users row set via RPC — role=${role}`);
} else {
  const upsert = await call(await fetch(`${url}/rest/v1/admin_users`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: userId, role, status: 'active' }),
  }));
  if (!upsert.ok) {
    console.error('Provisioning failed:', JSON.stringify(upsert.body));
    console.error('Did you run supabase/admin_center.sql first?');
    process.exit(1);
  }
  console.log(`✓ admin_users row upserted (service role) — role=${role}`);
}

console.log('Done. Sign in at the admin app with that email, then enable 2FA.');
