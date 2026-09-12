# Gen Z — Pre-Launch Audit

**Date:** 2026-09-12 · **Scope:** mobile app (`src/`, `App.tsx`) + admin (`admin/`) + database (`supabase/*.sql`)
**Positioning target:** "The social network for right now" — 48-hour moments, Drops, campus discovery.

> **Read this first — how honest this document is.**
> Findings are labelled **VERIFIED** (I ran a command and saw output), **READ** (I
> inspected the code/SQL and reasoned about it), or **NOT INSPECTED** (nobody has
> looked yet and you should assume nothing). I did not run the app on a device and
> did not execute a single statement against your database. Where I claim a number,
> it came from a command in this session.

---

## Part 1 — The eight questions

### 1. What already works well

| Area | Evidence |
|---|---|
| **48-hour expiry is a real engine, not a claim** | `expiry.sql` runs on pg_cron every 5 min and deletes posts *and their media*; `expiry_v2.sql` adds DB-level enforcement so a client **cannot** set or extend `expires_at`. That is the right shape — server-enforced, not client-trusted. **READ** |
| **Drops have a genuine lifecycle** | `drops.sql`: `scheduled → live (30 min) → voting → closed`, flipped every minute by pg_cron, plus auto-scheduled next Drop every 24h (`drop2.sql`). This is a real product engine. **READ** |
| **Secrets hygiene on the mobile side** | `.env` is gitignored and **was never committed** (no git history for it). Only `.env.example` is tracked. `git grep` finds no service-role key, JWT, or admin credential in any tracked source file. **VERIFIED** |
| **Admin app does not ship the service-role key** | `admin/src/lib/supabase.ts` uses only `VITE_SUPABASE_ANON_KEY`. The service key is used solely by `admin/scripts/provision-admin.mjs`, which reads it from env and is untracked. **VERIFIED** |
| **Atomic server-side RPCs for critical writes** | Conversation creation, group creation, recovery/reset and account deletion are `SECURITY DEFINER` RPCs rather than client inserts. That is the correct pattern and it is applied consistently. **READ** |
| **A real notification engine** | `notifications` table + per-type CHECK constraint, now with OS-level push delivery (`push_notifications.sql`) and a full Activity screen. **READ** |

### 2. What is broken

| # | Issue | Severity |
|---|---|---|
| 1 | **22 of 44 migrations are untracked by git.** Admin auth, password recovery, call history, realtime chat and DB-level expiry enforcement exist only on your disk. A fresh clone cannot rebuild the database. | **Blocker** |
| 2 | **A live Giphy API key was committed** in the tracked `.env.example`. | High (fixed) |
| 3 | **The mobile project's `.env` held the Supabase service-role key + admin email + plaintext admin password** that the mobile app never reads. | High (fixed) |
| 4 | **People search suggestions never worked.** `SearchResults.tsx` read `.data` off already-destructured rows, so profile/follow arrays were always empty. Not a type error — a silent feature outage. | High (fixed) |
| 5 | **Scheduled Drops display as "CLOSED"**, and their countdown counted to the wrong deadline. | Medium (part fixed) |
| 6 | `sync_hashtags()` ran an `UPDATE` with **no WHERE clause** — a fix file exists (`hashtags_where_fix.sql`) but is **untracked**, so a fresh install would ship the bug. | High |

### 3. What is unnecessarily complicated

- **The feed exposes 5 modes** — `following | foryou | live | expiring | around` — plus **5 sub-sections inside `live`** (`blowing | watching | talked | fresh | creators`) and a **4-way content filter** (`video | photo | text | chains`). That is 5 + 5 + 4 decisions a new user is asked to make before seeing anything. Priority 6 asks for the opposite. **VERIFIED**
- **47 SQL files with no ordering contract** — `chat_fix.sql` *and* `chat-fix.sql`, `expiry.sql` *and* `expiry_v2.sql`, `final_fix.sql`, `admin_hotfix.sql`, files named `_admin_part2/3`. Nobody can currently answer "which migrations does production have?" See `supabase/MIGRATIONS.md`. **VERIFIED**
- **Two duplicate `lifetime_likes` implementations** in two locations (`supabase/lifetime_likes.sql` and root `lifetime_likes_fix.sql`). **VERIFIED**
- **Two `CommentsModal` instances now coexist in `FeedScreen`** — one keyed to the feed's typed post, one to an Activity-opened drop. Deliberate and type-safe, but it is a seam worth collapsing later. **READ**

### 4. What should be kept

Keep, unchanged: the 48h expiry engine and its cron jobs; the Drop lifecycle + auto-scheduling; `comment_likes` and the notification engine; the atomic `SECURITY DEFINER` RPCs; the anonymous-message *architecture* (server retains sender identity for moderation — correct design); DMs/groups/reactions/streaks; the dark navy + orange identity; the push + Activity work shipped this cycle.

### 5. What should be simplified

1. **Feed modes** — surface one feed. Keep `foryou` as the default and move the rest behind a single, quiet filter (or behind Discover). Do not delete the queries; stop advertising them.
2. **Drop status chip** — one status line, not three conditionals that disagree with the countdown.
3. **Migration surface** — collapse 44 files into an ordered, numbered set (`001_`…`0NN_`) once `MIGRATIONS.md` order is confirmed against production.

### 6. What is a security risk

| # | Risk | Status |
|---|---|---|
| 1 | Service-role key in plaintext in the **mobile** project directory (bypasses every RLS policy if ever leaked or committed). | **Fixed** — removed |
| 2 | Live Giphy key committed to the repo. | **Fixed** — placeholder |
| 3 | `scripts/bundle-check.js` — a **186,516-line Metro bundle dump** with every `EXPO_PUBLIC_*` value inlined, plus `.verifiedfix.js`. Untracked today, one `git add .` from being committed. | **Fixed** — gitignored |
| 4 | `anon_notifications_cleanup.sql` re-run on a live DB would **break call notifications** (adds a narrower CHECK constraint without dropping it, omitting `'call'`). | **Documented** in MIGRATIONS.md |
| 5 | **RLS policy matrix never audited.** I verified the *admin client* does not use the service key, and that `profile_views`/`push_tokens` (written this cycle) are owner-scoped with `SECURITY DEFINER` writers and no client INSERT/UPDATE path. **I did not review the policy blocks in the other migrations** — 16 tracked SQL files contain `create policy` statements, and no count of the untracked ones was taken. | **NOT INSPECTED** |
| 6 | **IDOR sweep not performed** — no systematic check that every `select` by id is scoped by `auth.uid()`. | **NOT INSPECTED** |
| 7 | **Storage bucket policies not reviewed.** | **NOT INSPECTED** |
| 8 | **Anonymous-message abuse controls not reviewed** (rate limiting, harassment, blocking, reporting). | **NOT INSPECTED** |

**The honest summary: item 6 is where your real risk lives now.** The credential
problems are fixed; the authorization problems are unexamined.

### 7. What is a performance risk

- **Not measured.** No profiling was done; the app was never run. What follows is read from code, not from data.
- **Realtime subscriptions are the main suspect** — chat, notifications and Activity each open channels. Activity's is per-user and scoped by filter (good); there is no evidence of a global leak, but nobody has counted concurrent channels. **READ**
- **Media budget** — Drops, carousels and 48h expiry mean heavy media churn. Compression settings and cache behaviour were not inspected. **NOT INSPECTED**
- Feed queries pull with `limit(...)` and the search screen pulls `profiles` up to 200 + `follows` up to 1000 rows, then joins in JS. That is O(n) memory on low-end devices and belongs in an RPC. **READ**

### 8. What must be fixed before public launch

**Must:**
1. Commit all 22 untracked migrations, then prove a fresh install from an empty database using `MIGRATIONS.md`.
2. Rotate the Supabase service-role key (it sat in plaintext in two project directories; I cannot verify whether it was ever shared, copied into a backup, or synced to cloud storage — and this project lives in OneDrive).
3. Audit the RLS policy matrix + IDOR sweep (item 6 above).
4. Review storage bucket policies.
5. Review anonymous-messaging abuse controls.

**Should:**
6. Reduce the feed to one obvious mode.
7. Fix the scheduled-Drop status chip.
8. Add error/empty-state passes on the main screens.

---

## Part 2 — Changes made this pass

**Security**
- `.env.example` — the committed live Giphy key replaced with a placeholder, plus a comment explaining that `EXPO_PUBLIC_*` is public by definition because it ships in the bundle.
- `.env` (mobile) — removed `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_ROLE`. Verified first that **nothing** in the mobile project reads them. The file now contains only the three `EXPO_PUBLIC_*` keys. *Consequence: run `admin/scripts/provision-admin.mjs` from inside `admin/`, not the repo root, or it will no longer find those values.*
- `.gitignore` — `scripts/bundle-check.js` and `.verifiedfix.js` added.

**TypeScript — both projects now at ZERO errors** (**VERIFIED**, `tsc --noEmit` exit 0 on each)
- `presets.ts` — `isPreset` is now a type predicate (`url is string`). The old `boolean` return meant `presetById` could not narrow `url`; a predicate is the correct fix and benefits every caller.
- `SearchResults.tsx` — removed three bogus `.data` reads that had silently emptied the arrays (real bug fix, not a type workaround).
- `DropCountdown.tsx` — `mode` now includes `'scheduled'`, rendering "STARTS IN 2H 10M" with a neutral (non-red) treatment. A Drop that has not started is anticipation, not urgency.
- `DropExperienceScreen.tsx` — the countdown now receives `starts_at` while scheduled instead of counting to the wrong deadline.
- `tsconfig.json` — `admin` excluded from the **mobile** project. The admin app has its own `tsconfig.json` that already declares `vite/client`; the two were being compiled as one program, which is why `import.meta.env` and `./theme.css` reported errors. No suppression, no `@ts-ignore`.

**Database documentation**
- `supabase/MIGRATIONS.md` — verified file counts, a 7-stage fresh-install order, four ordering hazards, a duplicate-file register, and verification queries.

---

## Part 3 — Remaining risks

1. **Nothing was executed against a database or a device.** Every SQL statement and every UI behaviour in this report is unproven at runtime.
2. **Service-role key rotation is outstanding** and is a manual dashboard action I cannot perform.
3. **RLS/IDOR/storage/abuse: not audited** (see §6).
4. **Scheduled-Drop status chip still reads "CLOSED"** — located at `DropExperienceScreen.tsx` around line 197. Not fixed because that line contains emoji literals and I will not risk a UTF-8 write to a 730-line file for a cosmetic change; the fix is to branch on `drop.status === 'scheduled'`.
5. **`lifetime_likes_fix.sql` (root) vs `supabase/lifetime_likes.sql`** — duplicates; pick one.
6. **No CI.** Nothing prevents a red typecheck from being merged, and nothing enforces that migrations are committed.

---

## Part 4 — Recommended next steps for the first university beta

**Week 1 — make it reproducible and safe**
1. Commit the 22 migrations. Stand up a throwaway Supabase project and run `MIGRATIONS.md` stages 1–7 against it. Fix whatever breaks — something will, and it is far cheaper now.
2. Rotate the service-role key; store it only in `admin/.env`.
3. Audit the RLS matrix. For every `public` table: RLS enabled, and each of SELECT/INSERT/UPDATE/DELETE deliberate. Verify with:
   ```sql
   select tablename from pg_tables
    where schemaname = 'public' and rowsecurity = false;  -- expect zero rows
   ```
4. Add CI — **verified: there is no `.github/workflows` today**, so a red typecheck cannot currently stop a merge. Two commands, one job: `npx tsc --noEmit` and `npx tsc -p admin/tsconfig.json --noEmit`.

**Week 2 — sharpen the core loop**
5. Collapse the feed to one mode; move the rest behind a filter.
6. Make the Drop card the loudest thing on screen: status, countdown, participant count, join.
7. Make expiry legible: every post shows *when* it dies ("expires in 6h"), not just that it will.

**Week 3 — campus identity**
8. Campus/community as a first-class field on the profile, and campus Drops as the default Drop.
9. Verify anonymous-message abuse controls end to end before promoting the feature to students.

**Week 4 — instrument before you invite**
10. Instrument the funnel with the events you listed (signup → onboarding → first post → first Drop join → social interaction → D1/D7 → invite). Keep payloads minimal and avoid storing message content.

**Do not, yet:** ads, paid features, or new surface area. Your own brief says retention first — and the audit agrees: the fastest way to lose a first cohort of students is to hand them a feed with seven modes and a database nobody can rebuild.
