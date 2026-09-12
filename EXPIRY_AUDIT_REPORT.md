# GENZ — 48-Hour Post Expiration & Storage Cleanup: Live Audit Report

Date: 2026-08-29 · Project: `fwouxamnmfdzwxpefoyb` · Verified against the LIVE Supabase database (not just the repo)

---

## 1. Was `pg_cron` actually enabled? — YES

`pg_cron 1.6.4` was enabled and running. Also confirmed live: `pg_net 0.20.4`, `supabase_vault 0.3.1`, `pgcrypto 1.3`.

## 2. Was the expiration job actually running? — YES (but the old, incomplete version)

- The job **existed and was active**: `genz-purge-expired-posts`, schedule `*/5 * * * *`, command was the **raw delete** (`delete from public.posts where expires_at <= now();`).
- So the repo's `expiry.sql` *had* been deployed — but the job only deleted post **rows**. It explicitly did **not** delete Storage media (the file even says so), so media files from expired posts accumulated as orphans.
- After the fix, the job is re-pointed at the new function and **confirmed firing every 5 minutes and succeeding** (live `cron.job_run_details`: jobid 9, succeeded at 21:10, 21:15, 21:20, `return_message = 1 row`).

## 3. What was wrong

| # | Issue | Status |
|---|-------|--------|
| 1 | Expiry cleanup only deleted `posts` rows — **Storage media was never removed** → orphans accumulated (27 auto + 12 review already in the bucket) | **Fixed** |
| 2 | **No DB-level enforcement of the 48h rule on INSERT** — `expires_at` was a column default only; a client could send `expires_at = 2099` and it would be honored | **Fixed** (trigger) |
| 3 | Old job used a raw `DELETE` — no failure isolation, no retry, no observability | **Fixed** (function + retry queue) |
| 4 | Pre-existing, unrelated: `genz-next-drop` cron fails with a SQL syntax error; `anon_expiry_cleanup` cron fails because it deletes `storage.objects` rows directly, which Supabase now blocks (`storage.protect_delete()` — "Use the Storage API instead") | **Not in scope — flagged** (§8) |

## 4. Files / functions changed

- **NEW** `supabase/expiry_v2.sql` — the complete system (idempotent, applied live, re-runnable):
  - `enforce_48h_expiry()` + trigger `posts_enforce_48h` (BEFORE INSERT/UPDATE): on INSERT, `created_at := now()` (client value ignored) and `expires_at := created_at + 48 hours`; on UPDATE, `expires_at` recomputed so it can never be extended. Existing `posts_lock_timestamps` immutability is preserved.
  - `genz_media_path(url)` / `genz_media_paths(posts)` — extracts Storage object paths from `media_url`, `media_items[].url`, `cover_url`, `voiceover_url`, `sound_url` (all in the `media` bucket).
  - `media_cleanup_queue` — internal retry/audit table (RLS off, revoked from all client roles).
  - `genz_storage_delete(bucket, path)` — SECURITY DEFINER; reads the service-role key + project URL **from the vault at runtime** (never exposed to clients); issues `net.http_delete` to the Storage API (`/storage/v1/object/{bucket}/{path}`); treats 200/404/400 as success; in-flight (async pg_net) as success — reconciliation is the safety net.
  - `genz_purge_expired()` — retries the queue first, then for each expired post deletes **media first**, then the post row (FK cascades clean likes/comments/views/reposts/saves). Per-post failure isolation: one bad object queues and never blocks the batch.
  - `genz_find_orphan_media(dry_run boolean default true)` — reference set = all posts' media + profiles' covers/avatars + pending queue; classifies unreferenced objects into **auto** (post-media patterns only: `voiceovers/…`, `{uuid}/drop-…`) and **review** (everything else — e.g. `{uuid}/cover-*.jpg` is ambiguous with profile covers and is **never** auto-deleted).
  - `genz_cleanup_orphan_media(limit)` — deletes only **auto** orphans via the Storage API; failures go to the retry queue.
- **UPDATED** `supabase/expiry.sql` — now schedules the same job calling `genz_purge_expired()` (re-running it is safe — it re-points the existing job, it can't regress it to the raw delete).

## 5. How Storage cleanup now works (server-side only)

1. Every 5 minutes the cron job calls `genz_purge_expired()`.
2. For each expired post, every media path is deleted via the **Storage Admin API** (`net.http_delete` with the vault service key — no client exposure, no privileged logic in React Native).
3. Only then is the post row deleted (cascades).
4. Any definitive failure is written to `media_cleanup_queue` and retried at the start of the next run; in-flight async requests are left to `genz_cleanup_orphan_media()` as the self-healing sweep.
5. Direct `storage.objects` deletion is impossible anyway — the platform blocks it with `storage.protect_delete()` — so the API is the only valid path.

## 6. Existing orphaned media

**Live dry-run** (`genz_find_orphan_media(true)`):
- **27 auto-orphans** (safe to delete): 24× `54eacca3-…/drop-*` (a user whose posts have all expired — the old job deleted rows but never the files), 2× `7f41a383-…/drop-*`, 1× our test file.
- **12 review items**: old top-level `.mp4` files and `cover-*.jpg` under both users (ambiguous with profile covers) — never auto-deleted.

**Decision:** the 26 real-user orphan files were **left untouched** — deleting real user media is your call. When you're ready:
- Dry-run first: `select public.genz_find_orphan_media(true);`
- Then clean: `select public.genz_cleanup_orphan_media(1000);` (deletes only the auto list)
- Review items require a manual decision per file (they're expired-post leftovers too, but conservatively classified).

All **test artifacts** I created were removed (test user, 4 test media files, a stray object named `remove` from a probe). Bucket now contains only the 2 real user folders + `avatars/` + `chat/`.

## 7. How the 48-hour lifecycle was tested (live)

| Step | Method | Result |
|------|--------|--------|
| Post created | Real user token insert | `created_at = now()`, `expires_at = created_at + 48.00h` exactly |
| Client tries to extend | Insert with `expires_at = 2099-01-01` | **Ignored** — DB returned `+48.00h` (trigger) |
| Visible while active | User-token feed query (`.gt('expires_at', now)`) | Post returned |
| Invisible after expiry | Expired row present in DB (backdated), queried with real user token | **Not returned** (RLS `expires_at > now()`) |
| Cleanup | `genz_purge_expired()` (same code the cron runs) | `posts_deleted: 2`, `media_failures_queued: 0` |
| Storage removed | `storage.objects` + public URL check | drop-TEST objects **gone** (HTTP 200 → gone) |
| Queue empty | `select * from media_cleanup_queue` | 0 rows |
| Idempotency | Second purge run | `posts_deleted: 0` |
| Retry scenario | Queued bogus path (3 prior failures) | Retried, cleared (400 = already gone = success) |
| Cron firing | `cron.job_run_details` jobid 9 | Succeeded at 21:10 / 21:15 / 21:20 |
| No regressions | Post count, existing RLS, feeds | Back to the original 2 active posts; no policies touched |

## 8. Remaining risks / recommended improvements

1. **The 26 real-user orphan files** are still in storage (invisible to users, but they cost space). Run `genz_cleanup_orphan_media(1000)` when you're comfortable, or schedule it — e.g. `select cron.schedule('genz-media-reconcile', '0 * * * *', $$ select public.genz_cleanup_orphan_media(500); $$);`
2. **`anon_expiry_cleanup` cron is broken** (pre-existing): it deletes `storage.objects` rows directly, which Supabase blocks. Anonymous-message media is therefore never cleaned and the job errors every 15 min. Fix: port it to `net.http_delete` (same pattern as `genz_storage_delete`) + delete rows afterwards. Happy to do this next.
3. **`genz-next-drop` cron is broken** (pre-existing): SQL syntax error in its command. The drops scheduling feature is not running.
4. Cleanup is sequential per object (≈0.5–1 s each) — fine at this scale; if the app grows, batch via `net.http_post` to the Storage `/remove` endpoint or raise the polling parallelism.
5. `genz_storage_delete` treats "no response within 5 s" as in-flight success; the orphan sweep is the backstop. If you want stricter guarantees, schedule the reconcile job from (1).
6. Security posture verified: service-role key exists only in the vault; all privileged functions are `SECURITY DEFINER` with execute revoked from `anon`/`authenticated`; `media_cleanup_queue` is internal-only; RLS policies untouched.
