-- ============================================================
-- Gen Z — FINAL FIX (run ONCE, LAST, in Supabase SQL Editor)
-- Fixes: 1) chat creation RLS  2) avatar upload RLS
--        3) storage upserts
-- IMPORTANT: after running this, do NOT re-run schema.sql —
-- it re-creates the old broken policies.
-- ============================================================

-- 1) CHAT — allow creating a conversation + adding members
--    (schema.sql's version required a participant that can't
--     exist at creation time, which blocked every new chat)
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations
  for insert to authenticated with check (true);

drop policy if exists "participants_insert" on public.conversation_participants;
create policy "participants_insert" on public.conversation_participants
  for insert with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = conversation_id and cp.user_id = auth.uid()
    )
  );

-- 2) PROFILES — explicit WITH CHECK on update (avatar_url saves)
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 3) STORAGE (media bucket) — upload + upsert/update + delete + read
--    The app uploads to media/<user-id>/... and
--    media/avatars/<user-id>/... — first folder = user id.
drop policy if exists "media_upload" on storage.objects;
create policy "media_upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'media');

drop policy if exists "media_update" on storage.objects;
create policy "media_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media');

drop policy if exists "media_delete" on storage.objects;
create policy "media_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_read" on storage.objects;
create policy "media_read" on storage.objects
  for select to public using (bucket_id = 'media');
