# GENZ — Phase 1 Audit (verified)

Branch `dev/phase2-stability`, cut from `master` @ `85ba688` (which now contains the 21-commit security branch).
Method: read the SQL and the client code, quote `file:line`, and only report what the current code actually says.
Old audits were treated as claims, not evidence — two of their assertions are corrected below.

---

## 1. Verified already-fixed (do not redo)

| Area | Evidence |
|---|---|
| Private chat media | `chat-media` / `chat-thumbs` / `anon-media` are private buckets (`20261023_01:226-241`) |
| Signed access | `src/utils/privateMedia.ts:73-75` `createSignedUrl`, 3600s TTL, 45-min cache; non-`sb://` passes through (`:62-63`) |
| Upload returns refs, never public URLs | `src/utils/upload.ts:256-271`, comment `:253-254` states there is deliberately no `getPublicUrl()` branch |
| Upload path ownership | `foldername[2] = auth.uid()` on INSERT (`20261023_01:269-277`) |
| `media` enumeration closed | no SELECT policy on `media` (`:390-397`); `storage.list()` appears 0 times in `src/` |
| Service-role key absent from app | 0 matches in `src/`; only `scripts/migrate-private-media.mjs:45` uses it, server-side |
| Admin authorisation is server-side | `admin_require()` `admin_center.sql:167-187`; client `admin/src/lib/perms.ts:37-44` is nav-only |
| 7-day rule | `seven_day_expiry.sql:54` assigns `+7 days`; posts locked by `drop_creator.sql:50` |

---

## 2. Security problems — 9 verified

1. **Legacy private bytes still in the PUBLIC `media` bucket.** `schema.sql:323` creates it public; `20261023_01:43-47` refuses to flip it; `scripts/migrate-private-media.mjs` was never executed. Any pre-migration chat/anon object remains world-readable at a known path.
2. **Replayable weak policies still in the repo.** `schema.sql:331-334` (`media_read … to public using (bucket_id='media')`) and `final_fix.sql:28-44` (INSERT with only a bucket check; UPDATE `WITH CHECK` = bucket only). Re-running either file reopens enumeration and arbitrary-path writes.
3. **`conversations` has RLS but no UPDATE policy**, while the client updates it: `src/components/chat/ChatSettingsSheet.tsx:357` (`disappear_seconds`), `src/screens/GroupInfoScreen.tsx:274,477`. RLS filters silently → 0 rows, no error → these features are quietly broken.
4. **Recovery RPCs granted to `anon`**: `account_security.sql:566-572` (`recover_find_account`, `recover_send_code`, `recover_verify_and_reset`) and `genzplus.sql:118`. Unauthenticated account enumeration / code-send surface.
5. `media_cleanup_queue` RLS disabled at `expiry_v2.sql:85`, re-enabled at `security_hardening.sql:46` — order-dependent.
6. `chat_media_update_own` / `chat_media_delete_own` (`20261023_01:286-289,299-304`) omit conversation membership — a removed participant keeps update/delete on their own objects.
7. `anon_media_write_screened` (`:329-336`) has no per-sender quota — storage-abuse vector.
8. **Hardcoded secrets** in `scripts/bundle-check.js:1289`: project URL, anon JWT, and a live Giphy key in plaintext.
9. **Audit correction**: `invite_redemptions` is not deny-all (`invite_tooling.sql:77-78` grants SELECT). Live deny-all count is 13, not the 14 claimed in `SECURITY_AUDIT_2026-10-23.md` §3.2.

### RLS shape
74 RLS tables. 13 are deny-all by design (`admin_*`, `user_sessions`, `security_events`, `media_cleanup_queue`, …) with privileges revoked — correct. Every user-facing table has policies for the verbs it needs, except the three defects above (3, 4, 6).

---

## 3. Stability problems — verified

1. **Two competing expiry functions, same name.** `expiry_v2.sql:28` sets `+48 hours`; `seven_day_expiry.sql:54` sets `+7 days`. Re-running `expiry_v2` silently reverts retention to 48h *and* makes `posts_lock_timestamps` (`drop_creator.sql:50`) raise on every post UPDATE.
2. **`drop2.sql:9` is invalid SQL** (`WHERE` after `LIMIT`) — the next-drop cron defined there never exists, so scheduled drops have no automatic transition.
3. **Anonymous-media cleanup deletes `storage.objects` rows only** (`anon_notifications_cleanup.sql:102`) — bytes are orphaned in the bucket.
4. **Duplicate concepts**, unconsolidated:
   - mutes: `muted_accounts` (`profile3.sql:37`) vs `muted_users` (`feed_advanced.sql:27`)
   - reports: `schema.sql:188`, `chat_settings.sql:31`, `anonymous_messages.sql:114`, `support_and_prefs.sql:12`
   - location: `profile3.sql:9` vs `admin_center.sql:26`
5. **Migration tracking**: 74 `create table` across 70 files; `MIGRATIONS.md` documents 44. ~26 files (incl. `20261023_01–06`) are unlisted; only the numbered six are ordered.

---

## 4. Performance — verified

- **No feed pagination.** `FeedScreen.tsx:526` fetches a fixed `.limit(90)`, ranked and trimmed to 50 client-side (`:434`). No `.range()`, no `onEndReached`, no cursor. The feed dead-ends, and every refresh re-downloads the same 90 rows.
- No N+1: enrichment is batched at `:764-790`.
- FlatList has `getItemLayout`, `windowSize={5}`, `keyExtractor` (`:1719-1742`); missing `onEndReached` and `removeClippedSubviews`.

---

## 5. Phase 2 plan (proposed, ordered by risk)

| # | Work | Type | Risk |
|---|---|---|---|
| 1 | Ban the replayable weak policies (`schema.sql` / `final_fix.sql`) via a superseding migration + a guard note | SQL | low |
| 2 | Add `conversations` UPDATE policy scoped to participants | SQL | low |
| 3 | Revoke `anon` on the three recovery RPCs; keep `authenticated` | SQL | medium — login recovery must be re-tested |
| 4 | Deactivate `expiry_v2.sql`'s function definition; one canonical 7-day source | SQL | medium |
| 5 | Add membership to `chat_media_update_own` / `chat_media_delete_own` | SQL | low |
| 6 | Keyset pagination on `created_at,id` with `onEndReached` | code | medium |
| 7 | Strip secrets from `scripts/bundle-check.js`; rotate the Giphy key | code | low |
| 8 | Migrate remaining legacy bytes; then flip `media` private if nothing public needs it | data | **needs approval** |

Each SQL item gets written as a numbered migration and proven locally with `scripts/sql-verify/verify.py` (real Postgres, 49+ assertions as `authenticated`/`anon`) before any apply. Nothing is applied to production in this phase without explicit approval.

---

## 6. Not yet verified — do not treat as done

- `npx expo-doctor` has not been run.
- No device test of the current UI (dock, story viewer, light theme).
- Light theme verified only on the feed header and tab rail; Settings / Chats / Profile / Discover not inspected.
- Whether legacy private bytes actually exist in the public bucket (needs a `storage.objects` count, which is a production read).
