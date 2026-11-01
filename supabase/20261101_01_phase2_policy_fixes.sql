-- ============================================================
-- 20261101_01 — Phase 2 policy fixes
-- ============================================================
--
-- Four verified defects from PHASE1_AUDIT.md §2. No data is moved and no
-- expired content is touched, so this is safe to apply to production once
-- reviewed. Every statement is idempotent: re-running the file is a no-op.
--
-- APPLIED to production 2026-11-01 (ref fwouxamnmfdzwxpefoyb). Verified after
-- the run: conversations_update exists as UPDATE; the four legacy media_* storage
-- policies return 0 rows; posts.expires_at default reads +7 days.
-- Local proof before the live run: npm run verify:sql
--
-- begin;

-- ------------------------------------------------------------
-- 1. conversations has SELECT and INSERT policies but no UPDATE,
--    so every conversation edit silently affected zero rows.
--
--    Evidence: schema.sql:264-271 (select + insert only);
--    src/components/chat/ChatSettingsSheet.tsx:357 writes
--    disappear_seconds, src/screens/GroupInfoScreen.tsx:274 writes
--    name/avatar. RLS filters rather than raising, so the UI reports
--    success and nothing changes.
--
--    Scoped to participants, and WITH CHECK repeats the predicate so a
--    participant cannot reassign a conversation to someone else.
-- ------------------------------------------------------------
drop policy if exists "conversations_update" on public.conversations;
create policy "conversations_update" on public.conversations
  for update to authenticated
  using (
    exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = conversations.id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = conversations.id
        and p.user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 2. Retire the pre-lockdown storage policy names.
--
--    schema.sql:331-334 and final_fix.sql define media_read / media_upload /
--    media_update / media_delete with a bucket-only predicate. They are
--    superseded by media_upload_own_path & friends (20261023_01), but the
--    files are still in the repo and their own headers tell operators to run
--    them "ONCE, LAST" — so one rerun reopens enumeration and lets any
--    authenticated user write into any path.
--
--    Dropping by name here means a rerun of those files is immediately
--    corrected by re-applying this migration. It cannot prevent the brief
--    window between the two, which is why the real fix is the guard note
--    added to MIGRATIONS.md in the same commit.
-- ------------------------------------------------------------
drop policy if exists "media_read" on storage.objects;
drop policy if exists "media_upload" on storage.objects;
drop policy if exists "media_update" on storage.objects;
drop policy if exists "media_delete" on storage.objects;

-- ------------------------------------------------------------
-- 3. Removed participants kept update/delete on their own chat objects.
--
--    Evidence: 20261023_01:286-296 and :299-304 check
--    foldername[2] = auth.uid() but not membership, so someone who has left
--    or been removed from a conversation can still edit and delete files in
--    it. Membership is added; the ownership check stays.
-- ------------------------------------------------------------
drop policy if exists "chat_media_update_own" on storage.objects;
create policy "chat_media_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1]))
  )
  with check (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1]))
  );

drop policy if exists "chat_media_delete_own" on storage.objects;
create policy "chat_media_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(public.try_uuid((storage.foldername(name))[1]))
  );

-- ------------------------------------------------------------
-- 4. Re-assert the 7-day default.
--
--    expiry_v2.sql:28 still defines the same function with +48 hours while
--    seven_day_expiry.sql:54 uses +7 days. Whichever file ran last wins, and
--    the column default is set independently at seven_day_expiry.sql:69.
--    Re-asserting the default here makes the intent explicit and idempotent;
--    the function body itself is NOT redefined in this migration because it
--    needs to be read and tested as a unit (Phase 3).
-- ------------------------------------------------------------
alter table public.posts
  alter column expires_at set default (now() + interval '7 days');

-- commit;
