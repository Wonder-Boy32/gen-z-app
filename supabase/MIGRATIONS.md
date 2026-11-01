# Gen Z — Database Migration State

**Audited:** 2026-09-12 · **Scope:** `supabase/*.sql` + `lifetime_likes_fix.sql`

---

## Phase 2 batch — APPLIED to production 2026-11-01

Project `GenZ`, ref `fwouxamnmfdzwxpefoyb`. All six files below were run in the
Supabase SQL editor and then **proved with a separate read-only query**, not by
reading the green "Success" banner. There is deliberately no `_02`.

| File | What it fixes | Post-run proof |
|---|---|---|
| `20261101_01_phase2_policy_fixes.sql` | `conversations` had no UPDATE policy (every edit silently hit 0 rows); retires the pre-lockdown `media_*` storage policies; removals now revoke chat-media edit/delete | `conversations_update` = UPDATE; `media_read/upload/update/delete` count = 0; `posts.expires_at` default = `+7 days` |
| `20261101_03_drops_autoschedule_fix.sql` | `drop2.sql` put `where` after `limit 1`, so `genz-next-drop` never existed | `cron.job` has `genz-next-drop`, `*/15 * * * *`, active |
| `20261101_04_expiry_rule_assert.sql` | the 7-day window lived only in a function body that an older file could silently revert | no `EXPIRY DRIFT` raised; default `(now() + '7 days'::interval)` |
| `20261101_05_mutes_single_source.sql` | two mute tables nothing synced; muting in the feed left Settings saying "Nobody is muted" | `to_regclass('public.muted_accounts')` = NULL; `muted_users` has one `FOR ALL` policy |
| `20261101_06_profile_region_mirror.sql` | `profiles.location_region` was read by 3 admin queries and written by nothing (always empty) | trigger `profiles_sync_region` present; 2 region rows, 0 disagreeing |
| `20261101_07_feed_keyset_index.sql` | feed paged by cursor with no matching index | `posts_feed_keyset_idx` on `(created_at DESC, id DESC)` |
| `20261101_08_storage_delete_confirm.sql` | an unconfirmed `pg_net` delete was reported as success, so expired media outlived its row | `has_pessimistic_branch = true`, `has_old_branch = false` |

**Checked and cleared:** `public.conversations` has no DELETE policy. That is
correct, not a repeat of the UPDATE defect — nothing deletes a conversation.
There is no `.delete()` on `conversations` in `src/`, and no
`delete from public.conversations` or `delete_conversation` RPC anywhere in the
repo. Leaving a chat removes a `conversation_participants` row. Deny-by-default
is the intended behaviour here.

### What `_08` found, and what it cost

Measured before the fix: `posts` held 0 rows, yet 46 unreferenced post-media
objects were still in the **public** `media` bucket and still downloadable by
URL, while `media_cleanup_queue` held 0 rows — the retry queue cannot help when
nothing is ever put in it. Expired Drops had outlived their seven days.

Cause: `genz_storage_delete()` polled `net._http_response` for 5s and, on
silence, returned `ok := true, err := 'in_flight'`. The purge reads `ok` as
"deleted", drops the post row, and never queues. Silence is now a failure, so
the caller queues and the next cron run retries — and a retry that finds the
object already gone gets 404, which is accepted, so the queue still drains.

Cleanup of the existing 46 used `scripts/cleanup-orphan-media.mjs`
(`npm run cleanup:media`), not `genz_cleanup_orphan_media()`, because that
function polls per object and 32 orphans exceeded the SQL editor's statement
timeout twice. The script takes its deletion set from the server's own
`genz_find_orphan_media()` report, subtracts a locally re-derived reference set
again, never touches `avatars/`, and needs `--apply --yes`. Result: 0 auto,
0 review remaining.

Also removed: one orphaned `chat/...` image in the public bucket (the last
legacy chat object). `migrate-private-media.mjs --dry-run` reports all 13
message references already private and present, so that script has no work
left to do.

---

## The blocker you must fix first

Of the **44 SQL files in `supabase/`, 22 are tracked by git and 22 are not.**
These exist **only on your machine** and are in no repository:

```
_accsec_part2.sql                 account_security.sql
_admin_part2.sql                  admin_center.sql
_admin_part3.sql                  admin_hotfix.sql
anon_notifications_cleanup.sql    auth_upgrade.sql
calls.sql                         chat_realtime.sql
chat_recursion_fix.sql            chat_settings.sql
chat_upgrades.sql                 comment_dislikes.sql
create_direct_conversation.sql    expiry_v2.sql
lifetime_likes.sql                pg_net_fix.sql
profile_cover.sql                 profile_views.sql
push_notifications.sql            support_and_prefs.sql
```

**A fresh clone cannot rebuild your database.** Admin auth (`admin_center.sql`),
recovery/password reset (`pg_net_fix.sql`, `account_security.sql`), call history
(`calls.sql`), realtime chat and the 48h DB-level enforcement (`expiry_v2.sql`)
all live in untracked files. Commit them before launch:

```bash
git add supabase/*.sql "lifetime_likes_fix.sql"
git commit -m "chore(db): commit all production migrations"
```

---

## Recommended order for a FRESH database

Files state their own dependencies in their headers; where a file names a
prerequisite it is respected below. Order within a stage is not arbitrary —
hazards are called out at the end.

### Stage 1 — core
1. `schema.sql` — base v1 (profiles, posts, comments, likes, follows, storage)
2. `profile2.sql` — display name + bio
3. `profile3.sql` — verified, location, pronouns, privacy toggles, reposts
4. `auth_upgrade.sql` — signup-flow profile columns
5. `social.sql` — follow graph, private accounts, privacy-aware feed RLS
6. `notifications.sql` — notifications table + RLS

### Stage 2 — content, feed, discovery
7. `drops.sql` — Drops engine + lifecycle (`scheduled → live → voting → closed`, pg_cron)
8. `drop2.sql` — auto-schedules the next Drop every 24h
9. `drop_creator.sql` — visibility, interaction toggles, sound, trim window
10. `feed2.sql` — carousel/text posts, audio, view counters
11. `feed_advanced.sql` — drop chains, personalisation, watch signals
12. `discover.sql` — hashtag extraction + `sync_hashtags()`
13. `search.sql` — search history + trending RPC
14. `sound_picker.sql` — song metadata
15. `profile_cover.sql` — cover photo

### Stage 3 — expiry and engagement
16. `expiry.sql` — 48h auto-expiry engine (cron, deletes posts + media)
17. `expiry_v2.sql` — DB-level 48h enforcement (clients cannot extend `expires_at`)
18. `hashtags_where_fix.sql` — **required**: fixes `sync_hashtags()` running an UPDATE with no WHERE clause
19. `comment_likes.sql` — comment likes + comment-like notifications
20. `comment_dislikes.sql` — optional thumbs-down
21. `lifetime_likes.sql` — permanent likes-received counter
22. `streak.sql` — streaks engine

### Stage 4 — chat
23. `chat-fix.sql` — conversation creation RLS
24. `chat2.sql` — groups, typed/media messages, replies, soft delete, seen *(header says: after `chat-fix.sql` + `streak.sql`)*
25. `chat_upgrades.sql` — `create_group_conversation` RPC
26. `create_direct_conversation.sql` — DM creation RPC
27. `chat_recursion_fix.sql` — fixes infinite recursion in a policy
28. `chat_realtime.sql` — realtime for chat
29. `chat_settings.sql` — per-user chat settings + calls
30. `anonymous_messages.sql` — anonymous messaging + chat schema upgrade

### Stage 5 — account security
31. `account_security.sql` — account + security system
32. `_accsec_part2.sql` — verify & reset, recovery codes, sessions, enforcement
33. `pg_net_fix.sql` — recovery RPCs (uses `pg_net` + `vault`)
34. `anon_notifications_cleanup.sql` — anonymous bell notifications + expiry cleanup
35. `calls.sql` — call history *(also widens the notification type CHECK)*
36. `support_and_prefs.sql` — support reports + real notification preferences

### Stage 6 — admin (server-side only)
37. `_admin_part2.sql` — moderation, anon, chat, safety, flags, analytics, admins
38. `_admin_part3.sql` — pulse, analytics, regions, discovery, enforcement
39. `admin_center.sql` — admin control center *(header says: after all other SQL)*
40. `admin_hotfix.sql` — analytics column fixes (`sender_id` / `follower_id`)

### Stage 7 — newest features
41. `profile_views.sql` — "who viewed my profile"
42. `push_notifications.sql` — real push delivery (needs `pg_net`; enables the realtime publication for `notifications`)
43. `final_fix.sql` — chat creation RLS + avatar upload RLS *(header says: ONCE, LAST)*

### Stage 8 — security hardening (after `final_fix.sql`)

44. `security_hardening.sql` — applies the pre-launch RLS audit fixes. Enables RLS
    and revokes privileges on four `account_security` tables that had neither
    (`user_recovery_codes`, `user_sessions`, `security_events`,
    `recovery_attempts`); scopes the previously world-readable `blocks` and
    `post_views` policies; and rate-limits notification inserts so one user
    cannot push-spam another. Idempotent, deny-only, and it grants nothing new —
    your `SECURITY DEFINER` RPCs keep working because definer code runs as its
    owner and is not subject to RLS.

---

## Ordering hazards — read before running anything

**1. Never re-run `anon_notifications_cleanup.sql` on a live database.**
It adds `notifications_type_check` **without** dropping it first, and its type
list is *narrower* than the current one — it omits `'call'`. Because
`calls.sql` and `comment_likes.sql` both `drop ... if exists` before adding,
they are safe to re-run. This one is not. Run it once, early, then leave it.

**2. `notifications_type_check` is the single source of truth for notification
types.** Current allowed set (from `calls.sql`, the widest):

```
follow, like, comment, reply, reaction, repost,
comment_like, anon_message, call
```

Any new notification type must extend this constraint *and* the matching
`case` in `push_notifications.sql`.

**3. Duplicate/superseded files — do not run both:**

| Files | Situation |
|---|---|
| `chat-fix.sql` **and** `chat_fix.sql` | Two names, two different fixes (creation RLS vs start fix). Likely both needed; confirm before deleting either. |
| `expiry.sql` (v2 engine) and `expiry_v2.sql` | `expiry_v2` supersedes; keep `expiry.sql` only for the cron job it creates. |
| `admin_hotfix.sql` vs `_admin_part2/3.sql` | Hotfix patches the parts; order matters (parts first). |
| `lifetime_likes.sql` (in `supabase/`) and `lifetime_likes_fix.sql` (repo root) | Duplicates of the same feature in two locations. Pick one, delete the other. |

**4. Untracked files prefixed `_`** (`_admin_part2/3`, `_accsec_part2`) look
like scratch names but contain production logic. Rename them to something
honest when you commit (`admin_part2_moderation.sql` etc.).

---

## Verify a fresh install

After running stages 1–7, check the essentials:

```sql
-- tables that must exist
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;

-- every public table must have RLS on (expect zero rows)
select tablename from pg_tables
 where schemaname = 'public' and rowsecurity = false;

-- scheduled jobs: drop lifecycle + 48h expiry
select jobname, schedule from cron.job;
```

Expected: no table without RLS, and cron jobs for drop status and expiry.
