# GenZ — Pre-Launch Security Audit & Hardening

**Date:** 2026-10-23
**Branch:** `security/launch-hardening` (off `master` @ `9bffcb9`)
**Project:** `https://github.com/Wonder-Boy32/gen-z-app` · Supabase ref `fwouxamnmfdzwxpefoyb`
**Scope:** storage privacy, RLS and exposed tables, hashtag sync, retention, build reliability, auth/messaging, admin centre

---

## 0. How to read this document

Every claim below is tagged with how it was established. The brief asked for exactly this separation, so it is applied throughout rather than dropped in a disclaimer at the end.

| Tag | Meaning |
|---|---|
| **CONFIRMED (live)** | Reproduced against the production project during this audit. Evidence quoted. |
| **CONFIRMED (code)** | Read directly from the current source/SQL. Line references given. |
| **REMEDIATED** | Defect existed, fix is written, verification shown. |
| **UNVERIFIED** | Could not be established without credentials or an environment I do not have. Named individually in §11. |
| **AMBIGUOUS** | Two sources in the repo disagree; I did not pick one. See §9. |

No fix in this document is claimed as complete unless §6 shows the verification.

---

## 1. Headline

**The production database was serving private chat media to unauthenticated clients.** This is not a policy-reading inference — it was executed.

```
[200] list media ''  -> 6 entries: [<uuid>, <uuid>, 'avatars', <uuid>, 'chat', 'covers']
[200] list media 'chat' -> 4 conversation folders
[200] list media 'chat/128a0991-81f1-456b-9f0e-6648b01493fc' -> 2 files
[200] DOWNLOADED chat/128a0991-.../1791423177235.jpg  bytes=869533  ctype=image/jpeg
```

The requests carried **only the public anon key that ships inside the app**, and no user session. A stranger could enumerate the bucket, walk into a conversation folder, and download the media — or simply list `avatars/` and collect every profile picture.

Root cause is structural, not a bad policy line: **the `media` bucket is `public = true`, and public-bucket delivery never consults RLS.** No policy on `storage.objects` can make one prefix of a public bucket private. Chat and anonymous media therefore had to leave that bucket.

| # | Finding | Severity | Status |
|---|---|---|---|
| A | Anonymous list + download of all chat media | **Critical** | REMEDIATED (new writes) · data move pending §7 |
| A2 | Anonymous list + download of all anonymous-message media | **Critical** | REMEDIATED (new writes) · data move pending §7 |
| A3 | Bucket enumeration of every avatar / cover folder | **High** | REMEDIATED |
| A4 | Any signed-in user could upload to *any* path in `media` | **High** | REMEDIATED |
| A5 | `media_update` `WITH CHECK` did not pin the destination path | **High** | REMEDIATED |
| A6 | Anonymous media upload had **no** recipient authorization | **High** | REMEDIATED |
| B1 | `send_anonymous_message()` had **no** authorization at all | **High** | REMEDIATED |
| B2 | Anonymous cleanup deleted metadata rows, never the bytes | **Medium** | REMEDIATED |
| C1 | Hashtag count never recomputed for a *removed* tag | **Medium** | REMEDIATED |
| D1 | "View once" was client-side only; file stayed publicly fetchable | **High** | REMEDIATED |
| E1 | Chat "24h" expiry fully client-controlled | **Medium** | REMEDIATED |
| F1 | `admin_admin_set_role` allowed self-promotion to `super_admin` | **High** | REMEDIATED |
| G1 | Preflight accepted placeholder env values | **Medium** | REMEDIATED |
| H1 | `profiles.location` free text readable by anyone | **Low** | Open — needs product decision |
| H2 | Group avatar + chat wallpaper remain in the public bucket | **Low** | Accepted residual (R2) |

---

## 2. Priority 1 — Storage privacy

### 2.1 Full inventory of storage operations

Every call site in `src/` and `admin/src/`. The brief asked for feature, bucket, path, roles, read/write rules and retention per operation — that is what this table is.

| # | Feature | Call site | Bucket (before → after) | Path (after) | Read | Write | Retention |
|---|---|---|---|---|---|---|---|
| 1 | Post / drop media | `CreateDropScreen.tsx:1218` | `media` (public) | `<uid>/drop-<ts>-<i>.<ext>` | public | owner | 48h/7d **see §9** |
| 2 | Post video cover | `CreateDropScreen.tsx:1254` | `media` | `<uid>/cover-<ts>.jpg` | public | owner | with post |
| 3 | Avatar | `AvatarPickerModal.tsx:50`, `OnboardingScreen.tsx:152` | `media` | `avatars/<uid>/avatar-<ts>.jpg` | public | owner | permanent |
| 4 | Profile cover | `ProfileScreen.tsx:741` | `media` | `covers/<uid>/cover-<ts>.jpg` | public | owner | permanent |
| 5 | Chat photo/video | `ConversationScreen.tsx:722` | `media` → **`chat-media`** | `<conv>/<uid>/<ts>.<ext>` | participants | sender | chat retention |
| 6 | Chat camera | `ChatThread.tsx:624` | `media` → **`chat-media`** | `<conv>/<uid>/cam-<ts>.<ext>` | participants | sender | chat retention |
| 7 | Chat voice | `ConversationScreen.tsx:664`, `ChatThread.tsx:681` | `media` → **`chat-media`** | `<conv>/<uid>/voice-<ts>.m4a` | participants | sender | chat retention |
| 8 | Chat file | `ConversationScreen.tsx:820` | `media` → **`chat-media`** | `<conv>/<uid>/<ts>.<ext>` | participants | sender | chat retention |
| 9 | Chat wallpaper | `ChatSettingsSheet.tsx:147` | `media` | `chat-wallpapers/<uid>/wall-<ts>.jpg` | public (R2) | owner | permanent |
| 10 | Group avatar | `GroupInfoScreen.tsx:470` | `media` | `group-avatars/<uid>/group-<ts>.jpg` | public (R2) | owner | permanent |
| 11 | Anonymous photo | `AnonymousSendScreen.tsx:77` | `media` → **`anon-media`** | `<recipientId>/<opaque>.jpg` | recipient only | screened sender | 24h/48h/none |
| 12 | Voiceover | `VoiceoverRecorder.tsx:72` | `media` | `voiceovers/<uid>/vo-<ts>.m4a` | public | owner | with post |
| 13 | View-once bytes | `consume_view_once()` + sweep | **`chat-media`** | `<conv>/<uid>/<file>` | one-time | sweep deletes | 5 min post-consume |
| 14 | Chat delete | `ChatThread.tsx:755` | `media`/`chat-media` | derived | — | owner | — |

Notes that changed the design:

* The old comment in `final_fix.sql` claims "first folder = user id" for every path. It is false for 5 of the 14 operations. `avatars/<uid>/` and `covers/<uid>/` put the uid second; `chat/<conv>/` and `anon/<recipient>/` contain no uid at all. Any policy keyed on "segment 1 is the uid" silently mis-authorizes half the app. `media_path_owner()` encodes each real shape explicitly.
* `ConversationScreen.tsx:689` contained `const bucket = isVideo ? 'chat-media' : 'chat-media'; void bucket;` — a dead ternary whose only purpose was to suppress an unused-variable warning. The intent to use the private bucket existed and was abandoned mid-write. `chat-media` and `chat-thumbs` have been created since `messaging_v2.sql` and **no client ever wrote to either**.
* `messaging/api.ts:382` already had `signedMediaUrl()` reading `chat-media` — a read path for a bucket that was never written to.

### 2.2 What was changed

`supabase/20261023_01_storage_privacy_lockdown.sql`

1. **`anon-media` created**; `chat-media` / `chat-thumbs` enforced private with size caps and MIME allow-lists.
2. **Chat policies scoped to participants.** `chat_media_read` uses `is_conversation_member()`; writes and deletes additionally require `segment[2] = auth.uid()`.
3. **Anonymous policies scoped to recipient.** Read: `segment[1] = auth.uid()`. Write: `can_send_anon_to(segment[1])` — the check that never existed. The path deliberately omits the sender, because the recipient can list their own folder and a sender id there would de-anonymise every sender to the one person they are hiding from.
4. **`media` rewritten with ownership.** `with check (bucket_id = 'media')` → `media_path_owner(name) = auth.uid()`, on insert, update and delete. `WITH CHECK` now pins destination as well as source, closing A5.
5. **No `SELECT` policy on `media` at all.** Public delivery is unaffected (it does not consult RLS), so avatars/covers/drops still load. What dies is `list()` and signed-URL creation against that bucket — the two primitives enumeration needs. Confirmed nothing in the app calls `.list()`.
6. **`try_uuid()`** so a hand-crafted object name like `chat/not-a-uuid/x.jpg` denies cleanly instead of raising inside a policy.

### 2.3 Client contract

Private objects cannot have a permanent URL, so the database now stores a **reference**:

```
sb://chat-media/<conv>/<uid>/<file>
sb://anon-media/<recipient>/<file>
```

`src/utils/privateMedia.ts` exchanges a reference for a 1-hour signed URL, cached 45 min, batched per bucket. Anything that is not `sb://` passes through untouched — which is what lets legacy rows keep working during the data migration, and what keeps every public image unaffected.

Resolution is wired at the four places that can hand a message to the UI (`fetchTimeline`, `sendMessage`, `findByClientMessageId`, `fetchPinned`) plus the two paths that bypass `api.ts` (the optimistic bubble, and realtime inserts in `engine.ts`). A failed signature resolves to `null`, never to the raw path.

> Implemented but **not visually verified**: I cannot run the app. Type-check passes; rendering of signed URLs on a real device is UNVERIFIED (U3).

### 2.4 View-once — actual file security

Was: a local `Set` hid the bubble; the file stayed in the public bucket with a permanent URL; the recipient could reopen it by reloading.

Now (`20261023_05`): `consume_view_once(message_id)` is the only way to obtain the reference. It authorizes on conversation membership, refuses the sender, takes a row lock so two taps cannot both win, refuses a second call with `already_viewed`, writes the `message_views` row and the consumption stamp together, and returns the reference. `genz_sweep_consumed_view_once()` deletes the bytes 5 minutes after consumption — long enough for a slow connection to load the image, short enough to bound exposure.

**Documented limitations, stated plainly:**

* A recipient who captures the storage path and re-signs it inside the 5-minute window can still read the object once. Closing that needs the bytes streamed by a server component that counts reads (an Edge Function in front of the bucket). **Not implemented.**
* Screenshots and screen recording cannot be prevented. `expo-screen-capture` can detect; it cannot stop.
* Anything already downloaded before this change is gone from our control.

---

## 3. Priority 2 — RLS and exposed tables

### 3.1 Live probes (anon key, no session)

| Table | Result | Meaning |
|---|---|---|
| `user_recovery_codes` | **401** `42501 permission denied` | locked |
| `user_sessions` | **401** `42501` | locked |
| `security_events` | **401** `42501` | locked |
| `recovery_attempts` | **401** `42501` | locked |
| `media_cleanup_queue` | **401** `42501` | locked |
| `admin_users` | **401** `42501` | locked |
| `anonymous_messages` | **401** `42501` | locked (column grants) |
| `profiles` | 200 — returns `username, location, is_private, bio, …` | public by design |
| `messages`, `blocks`, `post_views`, `notifications`, `conversation_participants` | 200 `[]` | no rows leaked |
| `hashtags`, `post_hashtags` | 200 | public by design |

This answers the brief's "do not assume a historical migration is still present": **`security_hardening.sql` has been applied to production.** Those 401s cannot occur otherwise — the revokes are the only thing that produces `42501` rather than an empty 200.

### 3.2 Repository-wide RLS state

Extracted from all 70 SQL files, not sampled:

* Tables created in `public`: **74**. Every one has a `enable row level security` statement.
* Tables with at least one policy: **60**.
* Tables with RLS on and **zero** policies (deny-all, `SECURITY DEFINER` only): **14** — `admin_alerts`, `admin_audit_log`, `admin_permissions`, `admin_settings`, `admin_users`, `feature_flags`, `invite_redemptions`, `media_cleanup_queue`, `platform_notification_deliveries`, `platform_notifications`, `recovery_attempts`, `security_events`, `user_recovery_codes`, `user_sessions`.

That set is exactly the sensitive/internal list, and deny-all is the correct posture for all of it.

### 3.3 `USING (true)` inventory — 19 policies

Triaged individually. Public-by-design and left alone: `comments`, `likes`, `follows`, `reposts`, `post_reactions`, `comment_likes`, `comment_dislikes`, `sounds`, `hashtags`, `post_hashtags`, `drops`, `profile_status`, `realtime.messages`, `message_kinds`, `link_previews`, `payment_config`, `presence`.

Not public-by-design, already replaced by `security_hardening.sql`:

| Policy | Was | Now |
|---|---|---|
| `blocks.blocks_select` | `using (true)` — anyone could map who blocked whom | `blocks_select_own`: `blocker_id = auth.uid()` |
| `post_views.post_views_select` | `using (true)` — anyone could enumerate every viewer of every post | `post_views_select_scoped`: own row, or post owner |
| `profiles.profiles_select` | `using (true)` | unchanged — see §3.4 |

Caveat, stated rather than glossed: I can confirm the *file* defines the replacement and that the file is applied, but an anonymous probe returns `[]` for both tables either way (empty table), so I could not **independently** distinguish "scoped" from "world-readable but empty". Recorded as **U1**.

Tables whose policies are defined in more than one file — a real maintenance hazard, since replaying an old file silently reverts a newer policy: `conversations.conversations_insert` (5 files), `conversation_participants.participants_insert` (4), `messages.messages_update_member` (4), `messages.messages_update_own` (3), `posts.posts_select_active` (4), `profiles.profiles_update` (2), `reposts.*` (2), `storage.objects.media_*` (2), `polls.polls_select` (2), `conversation_requests.requests_update_recipient` (2), `realtime.messages.realtime_join_own_conversations` (4). Consolidating these into a single ordered migration path is recommended before the next schema change — **not done here**, because it is a refactor, not a fix.

### 3.4 Profiles and location

`profiles_select` is `using (true)`, and `profiles.location` is free text. Live probe returned one populated row with `"location": "United States"` — coarse, harmless in practice.

The risk is prospective: nothing stops a user typing a hall or street address, and that is then readable by logged-out callers. `security_hardening.sql` §5 flagged this as a decision for the product owner and deliberately did not change it. **I have not changed it either.** Silently making the column private would break the profile UI; silently truncating it would destroy user data. It needs one product decision, listed as **H1 / AMBIGUOUS-2**.

### 3.5 Database functions

188 `SECURITY DEFINER` functions. One was missing `set search_path`:

* `public.messages_guard_update` (`messaging_v2_hardening.sql:9`) — no `search_path`, therefore searchable-hijackable in principle.

It **is** redefined with `set search_path = public` in `messaging_v2_hardening_v2.sql:71`, and the live `hashtag_*` RPCs prove v2 ran. So the live definition is almost certainly safe; the stale v1 definition is a trap for anyone who replays that file. Reported, not patched — rewriting it would be undone by the next v2 run, the same reasoning that made `20261023_06` a separate trigger rather than an edit.

Everything else is already correct: explicit `search_path`, `revoke all … from public, anon`, and narrow `grant execute` (typically `authenticated` only).

---

## 4. Priority 3 — Hashtags

**Deployed state, verified by RPC rather than by reading files:**

```
POST rpc/hashtag_suggest {p_prefix:'',p_limit:3}  -> 200 []
POST rpc/hashtag_count   {p_tag:'genz'}           -> 200 0
POST rpc/location_suggest{p_prefix:'',p_limit:3}  -> 200 []
POST rpc/_tag_live_count {p_tag:'genz'}           -> 200 0
```

All four functions from `hashtags_locations_v2.sql` exist live, including the private helper. **v2 is applied.** The "missing migration" question in the brief is therefore answered for v2.

Two documentation problems found:

* `hashtags_where_fix.sql` says `sync_hashtags()` "ran an UPDATE without a WHERE clause". The version in `discover.sql` has a `WHERE` clause. The premise of that file does not match the code it claims to fix. It is stale; treat v2 as authoritative.
* `discover.sql` never inserted missing rows into `hashtags`, only updated existing ones — so a brand-new tag could never appear. v2 fixed this with an upsert. Live data shows one legacy artefact: `{tag:"ganagan", count:0}`, a zero-count row that v2's `delete … where count = 0` did not catch because it was written afterwards.

**The real bug, still present:**

```sql
-- hashtags_locations_v2.sql L61-79
delete from public.post_hashtags where post_id = new.id;
... re-insert new tags ...
update public.hashtags h set count = ...
 where h.tag in (select tag from public.post_hashtags where post_id = new.id);
```

The `WHERE` list is the **new** tags only — and the old association rows were just deleted. A tag removed by an edit is never recomputed and keeps its old count forever, because the DELETE trigger only fires on row deletion.

Test case from the brief, "editing a caption to remove a hashtag": post `#lagos #party` → edit to `#lagos` → `#party` still counts a post that no longer mentions it.

**Fix** — `supabase/20261023_02_hashtag_sync_repair.sql`: recompute over `unnest(new_tags || old_tags)`. Everything else preserved: live-count definition, auto-creation of tag rows, v2's DELETE trigger unchanged, no tag rows deleted. Migration also repairs existing drift by upsert and ships a drift query that must return 0.

Other hashtag criteria, assessed:

| Requirement | Result |
|---|---|
| Inserts sync | yes (v2) |
| Updates sync | **no — the bug above**; fixed |
| Deletes sync | yes (v2 DELETE trigger) |
| Duplicate tags handled | yes — `distinct` + `on conflict do nothing` |
| Expired posts excluded | yes — `expires_at > now() and removed_at is null` |
| Clients cannot move counters | yes — SELECT-only, no write policy on either table, trigger is definer |
| Function permissions | correct |
| Idempotent replay | yes — `create or replace`, `on conflict` |

---

## 5. Priority 4 — Retention

### 5.1 Retention matrix

Authoritative for what the code does **today**. Where the repo disagrees with itself it is marked and not decided.

| Content | Field | Lifetime | Enforced by | Recoverable |
|---|---|---|---|---|
| Posts / drops | `posts.expires_at` | **ambiguous 48h vs 7d** | `enforce_48h_expiry` BEFORE INSERT+UPDATE — client value overwritten | no |
| Post media / cover | storage object | deleted with the post | `genz_purge_expired()` every 5 min; failures → `media_cleanup_queue` | no |
| Post voiceover | `posts.voiceover_url` | with post | same purge | no |
| Profile status / mood | `profile_status.expires_at` | 24h default, 48h max | column default + CHECK | no |
| Chat message (normal) | `messages.expires_at` NULL | indefinite | — | soft-delete only |
| Chat message (24h mode) | `messages.expires_at` | 24h, now **server-clamped** | `messages_clamp_expiry` (new) | no |
| Chat attachment | storage object | with message | `purge_expired_messages` → `media_cleanup_queue` | no |
| View-once attachment | storage object | **consumed + 5 min** | `consume_view_once` + `genz_sweep_consumed_view_once` (new) | no |
| Anonymous message | `anonymous_messages.expires_at` | 24h / 48h / **never if the sender picks none** | client `p_expires` | no |
| Anonymous media | storage object | with message | `genz_purge_expired_anon` every 15 min (new — previously metadata-only) | no |
| Notifications | — | **never expire** | nothing | yes |
| Orphan media | — | until reconciled | `genz_find_orphan_media`; auto-deletes only `voiceovers/` and `<uid>/drop-*` | dry-run first |
| Security events / audit log | — | **no retention policy** | nothing | yes |
| Calls | — | indefinite | nothing | yes |

### 5.2 What was fixed

* `20261023_06` — chat expiry was entirely client-supplied; a modified client could set `expires_at` a decade out and the purge would obey. Now clamped server-side to `created_at + 24h` on insert and update. Shortening is still honoured; already-expired values are left for the purge rather than pulled forward.
* `20261023_04` — anonymous cleanup deleted `storage.objects` rows directly. In Supabase that removes metadata; **the bytes stay in the object store** and remain downloadable by anyone who kept the public URL. So "expired" anonymous media was never actually deleted. Replaced with a definer function calling the Storage API through `genz_storage_delete()`.

### 5.3 What is still open

Expiration is enforced in the database for posts, view-once, anonymous cleanup and (now) chat. Two gaps remain and are **not** fixed:

* Notifications and audit/security records have no retention at all. Intentional for audit; a growing liability for notifications.
* `genz_find_orphan_media` deliberately excludes `avatars/`, `chat/` and `anon/`, so private-bucket orphans are never reconciled. Needs a follow-up sweep scoped to `chat-media` that checks `messages.media_url`.

Admin cannot restore an expired post: `genz_purge_expired` deletes the row and the bytes first. `admin_drop_restore` therefore only works on `removed_at` (moderation-removed), not on expiry-deleted, which matches the spec's "expiration is immutable".

---

## 6. Priority 5 — Build, types, tests

Baseline captured **before any edit**, on a clean tree:

```
npx tsc --noEmit   -> exit 0        (TypeScript 6.0.3, zero errors)
```

After the full change set:

```
npx tsc --noEmit   -> exit 0
npm run check:types -> exit 0
node --check scripts/migrate-private-media.mjs -> exit 0
```

Scripts added to `package.json` (there was no type-check or general test script, as the brief suspected):

```json
"check:types": "tsc --noEmit",
"check":       "node scripts/preflight-env.js && tsc --noEmit",
"migrate:media": "node scripts/migrate-private-media.mjs"
```

### Environment preflight — was not doing its job

`scripts/preflight-env.js` only checked that keys **exist and are non-empty**. Copying `.env.example` to `.env` — the documented first step — yields every key present and every value a placeholder, which passed:

```
.env = YOUR-PROJECT / YOUR_ANON_KEY / YOUR_GIPHY_KEY
$ node scripts/preflight-env.js
  preflight ok — .env present, complete, and not excluded by .easignore     exit 0
```

Fixed with placeholder detection plus a shape check on the Supabase URL. Verified both directions:

```
real .env                     -> preflight ok                        exit 0
placeholder .env              -> BUILD BLOCKED for all three keys    exit 1
missing GIPHY key             -> BUILD BLOCKED                       exit 1
```

### What could not be run

| Command | Why |
|---|---|
| `npm ci` | Would rewrite `node_modules` and invalidate the working install mid-audit. The existing install type-checks clean. |
| `npx expo-doctor` | Needs registry access; its verdict is UNVERIFIED. |
| `eas build` | Already blocked before this audit — bundled `eas-cli` 24.8.0 is broken and the newer one will not finish downloading inside the process window. **Still unbuilt.** |
| Device/emulator run | No Android runtime available here. Every runtime claim in §2.3 / §4 is UNVERIFIED. |

No automated tests exist in the project and I did not add a framework — adding Jest to a React Native 0.86 / React 19 tree without being able to run it once would be untested infrastructure pretending to be coverage. The SQL migrations instead carry executable acceptance tests in comments (§2.2, §4, §5 of each file), which is verification the operator can actually run.

---

## 7. The data migration — required to finish Priority 1

**The code fix alone does not stop the leak for existing files.** An object already in `media` is still served from `/object/public/media/...` no matter what any policy says. It must be copied into a private bucket and removed.

`scripts/migrate-private-media.mjs` — four stages, no stage deletes anything until verification passes:

```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-private-media.mjs --dry-run
node scripts/migrate-private-media.mjs --apply --yes
node scripts/migrate-private-media.mjs --verify
node scripts/migrate-private-media.mjs --cleanup --yes
```

`--apply` copies bytes and rewrites references but **keeps the originals**, so an interrupted run is recoverable and rollback is "point back". `--cleanup` refuses to run while any row still points at a public URL. `--apply` is idempotent; rows already on `sb://` are skipped.

Path mapping — legacy chat objects carry no uploader, and the new policy requires one:

```
media/chat/<conv>/<file>            ->  chat-media/<conv>/<senderId>/<file>
media/anon/<recipient>/<file>       ->  anon-media/<recipient>/<file>
```

The sender is taken from the message row, which is also the correct owner: the person who actually sent the file.

**This script has not been executed.** It needs the service-role key, which the brief forbids me from holding, and it is a production data move requiring explicit authorization. Running it is step 3 of §8.

---

## 8. Deployment order (order matters)

1. Run `20261023_01` … `20261023_06` in the Supabase SQL editor, in numeric order. All idempotent, none destructive.
2. Ship the client build. New uploads use private buckets; legacy URLs still render, so this is backward compatible.
3. `migrate-private-media.mjs --dry-run` → `--apply --yes` → `--verify`.
4. `--cleanup --yes` to remove the old public copies.
5. Re-run the anonymous probe in §10 — it must fail.

Do not run step 4 before step 3 verifies. Do not deploy the client before step 1, or new chat uploads will be refused by the ownership check (they would land in `media/chat/…`, which now has no owner).

Full runbook and rollback: `MIGRATION_20261023.md`.

---

## 9. Two things I did not decide

**AMBIGUOUS-1 — 48 hours or 7 days for posts.** The repo contains both, and both claim the same trigger:

* `expiry_v2.sql` L22-30 — `enforce_48h_expiry()` sets `created_at + 48 hours`.
* `seven_day_expiry.sql` L47-56 — replaces the same function (name kept on purpose) with `+ 7 days`, changes the column default, and backfills existing rows.

`seven_day_expiry.sql` is written as the successor and says so explicitly, which is why the parameter names and comments still say 48h. The brief says the intended rule is 48h for designated temporary content. **I changed neither.** Deciding wrong silently would either delete content a week early or retain it five days too long, and both are irreversible.

I could not settle it empirically either: `posts` is currently empty (`GET /rest/v1/posts?limit=5` → `[]`), so there was no row to measure `expires_at - created_at` on. One query settles it — run it and tell me which is intended:

```sql
select prosrc like '%7 days%' as is_seven_days from pg_proc where proname = 'enforce_48h_expiry';
```

**AMBIGUOUS-2 — is `profiles.location` allowed to be public?** See §3.4. Options: stop collecting free text; keep the column but return only coarse location to non-owners; or accept it as public. Each changes visible product behaviour, so I left it alone.

---

## 10. How to verify this yourself

Run the same probe I ran, with the anon key from `.env` and no session:

```bash
# 1. enumeration must FAIL after migration (403/400, not a JSON array)
curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/media" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"prefix":"","limit":10}'

# 2. the previously-working anonymous download must FAIL
curl -s -o /dev/null -w "%{http_code}\n" \
  "$SUPABASE_URL/storage/v1/object/public/media/chat/<conv>/<file>"

# 3. sensitive tables must stay locked (expect 401 / 42501)
curl -s "$SUPABASE_URL/rest/v1/user_recovery_codes?select=*&limit=1" -H "apikey: $ANON"

# 4. hashtag drift must be zero
#    select count(*) from hashtags h where h.count <> public._tag_live_count(h.tag);

# 5. policy inventory
#    select policyname, cmd, qual, with_check from pg_policies
#     where schemaname='storage' and tablename='objects' order by policyname;
```

Test 1 currently **succeeds** for an attacker (returns the folder list). It must stop.

---

## 11. Unverified — named, not hidden

| # | Item | Why |
|---|---|---|
| U1 | `blocks` / `post_views` scoping actually live | Needs an authenticated probe with a seeded relationship; both tables are empty, so anon results cannot distinguish scoped from world-readable |
| U2 | Full live `pg_policies` dump | No SQL access (no service key). The matrix is from repo SQL plus behavioural probes |
| U3 | Signed-URL rendering on device | No runtime available |
| U4 | `expo-doctor`, `eas build`, production APK | Blocked as described in §6 |
| U5 | Authenticated-role policies across all 60 tables | Only the anon role was probed |
| U6 | Storage policy behaviour **on the live project** after migration | Narrowed from 'never executed': `scripts/sql-verify/verify.py` runs all six migrations on a real throwaway PostgreSQL and asserts 49 properties (§11a). Still unproven against the deployed schema and data, which needs the runbook |
| U7 | `cannot_disable_last_super_admin` actually firing | Unreachable through `admin_admin_remove`: it needs a super_admin caller, a super_admin target and no other active super_admin, which the self-removal and non-super guards already preclude. The invariant is upheld by the self-removal guard (R9) |

### 11a. What local execution established

`scripts/sql-verify/verify.py` applies the six migrations to a throwaway PostgreSQL (via
`pgserver`) over `scripts/sql-verify/stub_schema.sql` — a minimal Supabase-shaped schema —
then asserts 49 properties as the `authenticated` and `anon` roles. 49/49 hold.

Two defects were found this way and fixed; neither was visible by reading the SQL:

1. **`send_anonymous_message` raised on every call.** The rewrite kept a half-converted
   identity check referencing `p_sender`, a parameter the signature does not have, so the
   function was dead on arrival. The original resolved identity from `auth.uid()` only.
2. **`execute` was still granted to `anon`.** The guards read `v_sender is not null and
   exists (...)`, so a null session satisfied them vacuously — a logged-out caller could
   send. Revoked from `public, anon`; granted to `authenticated` only.

Every refusal was checked for its *reason*, not just for failing: storage denials surface as
`new row violates row-level security policy`, admin self-promotion as `permission_denied`,
anonymous blocking as `anon_blocked` (the code the UI maps), and an unauthenticated send as
`permission denied for function`. Assertions on visibility count rows rather than expecting
an error, because RLS filters a `SELECT` silently; the same applies to a client `UPDATE` of a
hashtag counter, which is recorded as succeeding while changing nothing.

---

## 12. Files changed

| File | Change |
|---|---|
| `supabase/20261023_01_storage_privacy_lockdown.sql` | new — buckets, policies, helpers, limits |
| `supabase/20261023_02_hashtag_sync_repair.sql` | new — union(old,new) recompute + drift repair |
| `supabase/20261023_03_admin_role_escalation.sql` | new — super_admin guards |
| `supabase/20261023_04_anonymous_send_authorization.sql` | new — send guards + real byte cleanup |
| `supabase/20261023_05_view_once_consumption.sql` | new — server-enforced consumption + sweep |
| `supabase/20261023_06_message_expiry_clamp.sql` | new — server-clamped chat expiry |
| `scripts/migrate-private-media.mjs` | new — 4-stage data migration |
| `scripts/preflight-env.js` | placeholder + URL-shape detection |
| `src/utils/privateMedia.ts` | new — `sb://` resolver, batched signing, cache |
| `src/utils/upload.ts` | `uploadPrivateMedia()`, bucket-aware progress upload |
| `src/messaging/api.ts` | hydrate refs on every read path; `consumeViewOnce()` |
| `src/messaging/engine.ts` | hydrate optimistic + realtime messages |
| `src/messaging/index.ts` | export `consumeViewOnce` |
| `src/components/chat/ConversationScreen.tsx` | chat → `chat-media`; view-once via RPC; dead ternary removed |
| `src/components/chat/ChatSettingsSheet.tsx` | wallpaper → owner-scoped path |
| `src/screens/GroupInfoScreen.tsx` | group avatar → owner-scoped path |
| `src/screens/AnonymousSendScreen.tsx` | `anon-media`, sender omitted from path |
| `src/screens/AnonymousInboxScreen.tsx` | resolve refs on load |
| `src/screens/ChatThread.tsx` | same contract for the legacy screen |
| `package.json` | `check:types`, `check`, `migrate:media` |
| `SECURITY_AUDIT_2026-10-23.md` | this document |
| `MIGRATION_20261023.md` | runbook + rollback |

---

## 13. Residual risks

| # | Risk | Accepted because |
|---|---|---|
| R1 | View-once: a captured path can be re-signed inside the 5-min window; screenshots unpreventable | Needs a byte-counting proxy; out of scope for this pass |
| R2 | Group avatars + chat wallpapers stay in the public bucket at owner-scoped paths | Conversation chrome, not message content; already visible to every participant; making them private needs async resolution threaded through the chat list. Enumeration is closed, so they are only fetchable by known URL |
| R3 | `media` bucket remains public, so `avatars/`, `covers/`, `voiceovers/`, drops are readable by exact URL | Intended — these are public by product design; enumeration now blocked |
| R4 | MIME allow-lists are advisory; the Storage API trusts client `Content-Type` | Real validation needs server-side inspection |
| R5 | Logged-out anonymous senders have no identity, so only the per-recipient rate limit applies to them | Authenticated senders get 30/hour; IP limiting needs an Edge Function |
| R6 | `media_cleanup_queue` retries are unbounded | Needs a max-attempts + dead-letter policy |
| R7 | 11 policy names defined in multiple migration files | Replaying an old file can revert a newer policy |
| R8 | Notifications and audit logs never expire | Deliberate for audit; needs a decision for notifications |
| R9 | `cannot_disable_last_super_admin` is unreachable through the admin RPC | Defence in depth only. One active super_admin is guaranteed by the self-removal guard, not by this counter. Any future path that disables admins directly (SQL, service role) must re-check it |
