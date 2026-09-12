# GEN Z — Admin Control Center

A separate, secure, mobile-first admin web app for the GEN Z platform.
Works beautifully on phones, tablets and desktop browsers.

```
GEN Z USER APP  →  Supabase (RLS + SECURITY DEFINER RPCs)  ←  GEN Z ADMIN
```

**Security model:** the admin app is a normal web client with the anon key.
It has zero direct access to admin tables (grants revoked). Every admin call
is a SECURITY DEFINER RPC that checks `admin_users` + `admin_permissions`
server-side. Roles can never be forged from the client, localStorage, URL
params or request payloads. Every action is written to `admin_audit_log`.

---

## 1. Database (one-time)

Run these in the Supabase SQL editor **in order** (all idempotent):

1. `supabase/schema.sql` (and any other migrations you've already applied)
2. `supabase/admin_center.sql` ← the admin backend (roles, audit, RPCs, analytics, enforcement)

No other setup is needed — the SQL creates everything: `admin_users`,
`admin_permissions`, `admin_audit_log`, `admin_settings`, `feature_flags`,
`platform_notifications`, moderation columns, ban-enforcement triggers and
~30 admin RPC functions.

## 2. Provision the Super Admin (one-time)

The password is **never** in source code. Create `admin/.env` from
`admin/.env.example` and set:

```
ADMIN_EMAIL=wonderfuldeveloper43@gmail.com
ADMIN_PASSWORD=<your strong password>
ADMIN_ROLE=super_admin
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Then:

```bash
cd admin
npm install
npm run provision   # creates the auth user + admin_users row (password bcrypt-hashed by Supabase)
```

**After provisioning, delete `ADMIN_PASSWORD` (and ideally the service role
key) from `.env`.** Add more admins later from the Admins module in the app
(super admin only), or by re-running `npm run provision` with a new email.

## 3. Run locally

```bash
cd admin
npm run dev        # http://localhost:5174
```

## 4. Deploy (HTTPS-only)

Host the `admin/dist` output (after `npm run build`) on any static host:

- **Vercel:** import the `admin/` folder → framework "Vite" → build `npm run build`, output `dist`. Set the `VITE_*` env vars in the project settings.
- **Netlify:** build command `npm run build`, publish directory `dist`, same env vars.

Enforce HTTPS (default on both hosts). Optionally put it behind a lock with
your auth provider, but the app's own role checks are the real gate.

## 5. Enable 2FA

Sign in with the super admin → **Settings** section is protected, then go to
**Admins → your account** and enable 2FA (TOTP): the app shows a QR code to
scan in your authenticator. After that, every sign-in requires the 6-digit
code. `admin_users.mfa_enabled` is tracked and audited.

## 6. Security checklist (built-in)

- [x] Password hashing — Supabase Auth (bcrypt), never in repo
- [x] Server-side role enforcement — `admin_require()` on every RPC
- [x] Admin tables RPC-only (grants revoked, RLS enabled)
- [x] Audit log for every admin action
- [x] 2FA (TOTP) challenge on sign-in when enrolled
- [x] Login rate limiting — Supabase Auth built-in + `admin_login_attempts`
- [x] Session management — Supabase refresh-token sessions
- [x] HTTPS-only deployment instructions
- [x] Banned/suspended users blocked from posting via DB triggers

## 7. The 48-hour rule (untouchable by design)

`posts.expires_at` is immutable at the database level
(`lock_drop_timestamps` trigger). No admin RPC reads, writes, extends or
resets it. Admin "remove" is a soft flag (`removed_at`) and "restore" only
works while the drop is still inside its original 48h window.

Create → 48h → expire → disappear. Forever.

## 8. Adding future features (permanent rule)

Every new product feature ships with its admin counterpart. Add:

1. A module entry in `src/lib/perms.ts` (label, icon, permission)
2. Admin RPCs in `supabase/admin_center.sql` (gated by `admin_require()`)
3. A screen in `src/screens/` + register it in `src/App.tsx`

The permission matrix is data-driven (`admin_permissions`), so new roles
(e.g. Finance) are just rows — no schema redesign.
