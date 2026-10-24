# Migration runbook — 20261023

Companion to `SECURITY_AUDIT_2026-10-23.md`. The six migrations have been executed against a throwaway PostgreSQL and their policies asserted (Step 0). They have **not** been executed against the live project — I have no authorized SQL session and no service-role key. Treat every step below as something you run and confirm.

---

## Step 0 — verify the migrations locally (already done, re-runnable)

```bash
python -m pip install pgserver "psycopg[binary]"
python scripts/sql-verify/verify.py
```

Exit 0 means 49 assertions held. This caught two defects that reading the SQL did not:

- **`send_anonymous_message` crashed on every call.** The rewrite left a half-converted identity check referring to `p_sender`, a parameter that no longer exists, so any anonymous send raised `column "p_sender" does not exist`. The original resolved identity from `auth.uid()` alone; the function now does the same and the dead branch is gone.
- **The function was still granted to `anon`.** The guards are written `v_sender is not null and exists (...)`, so a null session satisfied the block clauses vacuously — a logged-out caller with the public anon key could send. `execute` is now revoked from `public, anon` and granted to `authenticated` only.

It also showed that `cannot_disable_last_super_admin` in `20261023_03` is unreachable through the RPC: it needs a super_admin caller and a super_admin target with no other active super, which the other two guards already prevent. The invariant still holds — a super_admin cannot disable themselves, so one always survives — but the counter is defence in depth, not the mechanism. Recorded as R9 in the audit.

---

## Execution log — 2026-10-24 (production)

Run through the Supabase SQL editor on project `fwouxamnmfdzwxpefoyb`. Every file was
wrapped in `begin; … commit;` first, so each committed whole or not at all.

**Decisions taken by the owner:** 7-day retention (already live, unchanged);
`profiles.location` stays public (option c).

**Schema.** `01`–`06` applied. Post-run verification, read from the database:

| Check | Result |
|---|---|
| `expiry_is_7d` | `true` |
| `new_fns` | 3 |
| `expected_triggers` | 3 |
| `hashtag_drift` | 0 |
| `anon_can_send` | `false` |
| `auth_can_send` | `true` |
| `cron_jobs` | 4 |

**Data.** `media` held 70 objects; 15 were private chat media.

- 13 referenced objects copied to `chat-media/<conv>/<sender>/`, and all 13 message
  references rewritten to `sb://`. `--verify`: 13 refs, 13 present, 0 missing, 0 still
  on a public URL. `--cleanup` then removed the 13 public originals.
- 2 voice rows initially blocked the rewrite with `23514`. Cause: `message_body_valid`
  requires `body ? 'durationMs'` for `msg_type='voice'`, and both legacy rows had
  `body = {}`. The constraint is `NOT VALID`, so they had been un-updatable since it was
  added — unrelated to this migration. Fixed without inventing data: the m4a durations
  were measured (5062 ms, 5271 ms) and written alongside the new reference.
- 1 unreferenced private image moved to `chat-media/<conv>/<owner>/` using the uploader
  recorded in `storage.objects.owner`, then the public original was deleted.
- 1 wallpaper (`chat/<conv>/wall-*.jpg`) deliberately **not** moved. It is public chrome
  by design, `conversation_participants.wallpaper` may reference it, and moving it would
  risk a reference whose stored format is unverified. Recorded as R11.

**Leak probes, re-run with the public anon key after the move:**

| Probe | Before | After |
|---|---|---|
| list `media` root | 6 entries | `[]` |
| list `chat/<conv>/` | 4 folders, then 2 filenames | `[]` |
| GET the chat photo that leaked | 200, 869,533 bytes | `404 Object not found` |
| GET another former chat photo | 200 | `404 Object not found` |
| GET a public avatar | 200 | 200 (unchanged) |
| GET a `chat-media` object unsigned | — | `404 Bucket not found` |

Result: `media` now holds 56 objects, none of them private message content. `chat-media`
holds 14.

**Still open:** no client build has been produced or run, so the signed-URL rendering path
(`privateMedia.ts`) is verified only by type-check and by the reference rewrite above, not
on a device. `eas build` remains blocked.

---

## Before you start

1. **Snapshot.** Supabase → Database → Backups → confirm a recent backup exists. The migrations are additive and delete nothing, but a snapshot costs nothing and removes the argument.
2. **Note the current rule for posts** (see AMBIGUOUS-1 in the audit):
   ```sql
   select prosrc like '%7 days%' as is_seven_days from pg_proc where proname = 'enforce_48h_expiry';
   ```
   Write the answer down. Nothing in this runbook changes it.
3. **Confirm the client build you intend to ship is the one containing `privateMedia.ts`.** Deploy order depends on it.

---

## The six files

All are idempotent. None drops a table, drops a bucket, or deletes a row of user content.

| File | What it does | Destructive? |
|---|---|---|
| `20261023_01_storage_privacy_lockdown.sql` | `anon-media` bucket; participant/recipient-scoped storage policies; ownership on `media`; enumeration closed | no |
| `20261023_02_hashtag_sync_repair.sql` | recompute counts over old ∪ new tags; repair existing drift | no |
| `20261023_03_admin_role_escalation.sql` | blocks super_admin self-promotion, protects the last super_admin | no |
| `20261023_04_anonymous_send_authorization.sql` | the nine missing anon guards; `execute` revoked from `anon`; real byte deletion on expiry | no |
| `20261023_05_view_once_consumption.sql` | `consume_view_once`; 5-minute post-consumption sweep | no |
| `20261023_06_message_expiry_clamp.sql` | chat `expires_at` clamped to 24h server-side | no |

Order matters only for 01 → 02 (02 calls `_tag_live_count`, which it also defines) and 04 → 05 (05's sweep uses `storage_ref_parts` from 04). Run 01,02,03,04,05,06.

---

## Step 1 — schema

Open SQL Editor, paste each file in full, run, and check the verification block at the end of each.

Expected output of `20261023_01`:

```
private_buckets                 3
media_public_policies           3      <- insert/update/delete; SELECT intentionally absent
media_select_policy_still_present  (0 rows)
chat_policies                   4
anon_policies                   3
```

Expected output of `20261023_02`:

```
drift      0
triggers   2
```

`20261023_03` / `04` return booleans that must all read `true`. `20261023_05` returns `columns=2`, `rpc=1`. `20261023_06` returns `clamp_trigger=1`.

**If `private_buckets` is not 3:** `anon-media` was not created. Check the `insert into storage.buckets` statement ran — a permissions error on `storage.buckets` means the SQL editor role is not `postgres`.

---

## Step 2 — ship the client

Backward compatible by construction: a row holding an `https://…` URL renders exactly as before, and a row holding `sb://…` is signed. Nothing breaks if some clients are still on the old build — they will, however, keep writing chat media into the public bucket until they update, and those uploads will be **refused** by the new ownership policy (a `chat/<conv>/…` path has no owner). That refusal is the fix doing its job, but it looks like a bug to a user on an old build. Ship promptly.

---

## Step 3 — move existing objects

This is the step that actually ends the leak for files already uploaded.

```bash
cd <project>
export SUPABASE_URL=https://fwouxamnmfdzwxpefoyb.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...        # never commit, never paste into chat

node scripts/migrate-private-media.mjs --dry-run
```

Read the plan. Expect `to move: N (chat … , anonymous …)`. Anything in `skipped` with reason `unexpected path` needs a look before continuing.

```bash
node scripts/migrate-private-media.mjs --apply --yes
node scripts/migrate-private-media.mjs --verify
```

`--verify` must print `missing: 0` and `still on a public URL: 0`. If either is non-zero, **stop**: those rows are still publicly readable and still have a public copy as their only copy.

```bash
node scripts/migrate-private-media.mjs --cleanup --yes
```

`--cleanup` refuses to run unless the previous state was clean. It deletes only the old copies under `media/chat/` and `media/anon/`.

---

## Step 4 — prove it

Run the probes in §10 of the audit. The two that matter:

```bash
# must NOT return a JSON array any more
curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/media" \
  -H "apikey: $ANON" -H "Content-Type: application/json" -d '{"prefix":"","limit":10}'

# must NOT return 200
curl -s -o /dev/null -w "%{http_code}\n" \
  "$SUPABASE_URL/storage/v1/object/public/media/chat/<conv>/<file>"
```

Before this work, both succeeded. If either still succeeds, the data move did not complete for those paths.

Also confirm public content still works: open a profile avatar and a live drop. They must render — if they do not, `media` was made private by mistake; it must stay `public = true`.

---

## Rollback

### Per migration

Each file ends with its own rollback block for the policies it created. In summary:

```sql
-- 01
drop policy if exists "media_upload_own_path"       on storage.objects;
drop policy if exists "media_update_own_path"       on storage.objects;
drop policy if exists "media_delete_own_path"       on storage.objects;
drop policy if exists "chat_media_read"             on storage.objects;
drop policy if exists "chat_media_write_own_folder" on storage.objects;
drop policy if exists "chat_media_update_own"       on storage.objects;
drop policy if exists "chat_media_delete_own"       on storage.objects;
drop policy if exists "anon_media_read_recipient"   on storage.objects;
drop policy if exists "anon_media_write_screened"   on storage.objects;
drop policy if exists "anon_media_delete_recipient" on storage.objects;
-- then re-run section 3 of supabase/final_fix.sql to restore the previous media policies
```

Rolling back 01 re-opens the enumeration hole. Only do it together with a client rollback.

For 02 / 03 / 04 / 05 / 06, rolling back means re-running the previous definition of the function, which lives in the files named in the audit §4 and §5 (`hashtags_locations_v2.sql`, `admin_center.sql`, `anon_notifications_cleanup.sql`). Triggers added by 05 / 06 are dropped with `drop trigger if exists … on public.messages`. Columns added by 05 / 06 (`view_once_consumed_at/by`) are additive and harmless if left.

### Data migration

`--apply` never deletes the originals, so as long as `--cleanup` has not run, rollback is a reference rewrite back to the old URL:

```sql
-- only for rows you want to revert; the objects still exist in media/
update public.messages
   set media_url = replace(media_url, 'sb://chat-media/', '<project>/storage/v1/object/public/media/chat/')
 where media_url like 'sb://chat-media/%';
```

After `--cleanup` the old copies are gone and this is no longer possible. That is why cleanup is a separate, last, confirmed step.

---

## If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Chat image uploads fail with a storage RLS error | Client is on the old build, writing `chat/<conv>/…` to `media` | Ship the new build; or temporarily restore `media_upload` from `final_fix.sql` — accepting the A4 hole again |
| Avatars / covers / drops 404 | `media` was made private | `update storage.buckets set public = true where id = 'media';` |
| Chat images load for sender, not recipient | Recipient not in `conversation_participants` for that conversation | `select * from conversation_participants where conversation_id = '<conv>';` — missing membership is the bug |
| Anonymous inbox shows broken images | Refs not signed, or `anon-media` policy rejecting the recipient | check `(storage.foldername(name))[1] = auth.uid()` matches the recipient id in the path |
| "Already viewed" on a first open | `consume_view_once` ran twice (double tap) | sender may need to resend; this is the intended refusal |
| New posts vanish at 48h but the team expected 7 days (or the reverse) | AMBIGUOUS-1 was never decided | run the one-line `prosrc` query; change `enforce_48h_expiry` deliberately, not by accident |

---

## What to schedule afterwards

`20261023_04` and `05` register cron jobs (`anon_expiry_cleanup` every 15 min, `genz_view_once_sweep` every 2 min). Confirm they exist:

```sql
select jobname, schedule, active from cron.job where jobname like 'genz%' or jobname like 'anon%';
```

If `pg_cron` is unavailable on the project, both files raise a notice and continue — the functions still exist and must be driven from an external scheduler. `genz_purge_expired()` (posts) was already scheduled by `expiry_v2.sql`.
