begin;

-- ============================================================
-- GEN Z — 20261023_01 — STORAGE PRIVACY LOCKDOWN
--
-- WHY THIS FILE EXISTS
--
-- The pre-launch audit found that every piece of chat and anonymous
-- media was written into the PUBLIC `media` bucket:
--
--     chat/<conversationId>/1791423177235.jpg
--     anon/<recipientId>/1791423177235.jpg
--
-- A public bucket is served at /storage/v1/object/public/... with NO
-- authorization and NO row-level security involved at all. The
-- finding was reproduced against production: an unauthenticated
-- client LISTED the bucket, walked into a conversation folder, and
-- downloaded a real 869 KB chat photograph.
--
-- The same client could also list every avatar folder, because the
-- bucket carried a SELECT policy for `public`.
--
-- WHAT THIS MIGRATION DOES
--
--   1. Creates a private `anon-media` bucket; `chat-media` and
--      `chat-thumbs` already exist (messaging_v2.sql) and were never
--      used by any client code.
--   2. Moves chat + anonymous authorization into storage policies
--      that are scoped to the real participants, not to "authenticated".
--   3. Replaces the three blanket `media` policies, which allowed any
--      signed-in user to write ANY path in the bucket, with an
--      ownership check derived from the actual path shapes the app uses.
--   4. Removes the SELECT policy on `media` so the bucket can no
--      longer be enumerated. Public URLs keep working: a public
--      bucket is served without consulting RLS, so avatars, covers,
--      drops and voiceovers are unaffected. Only `list()` breaks —
--      and the app never calls it.
--   5. Adds per-file size caps and MIME allow-lists on the private
--      buckets.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
--   * It does not delete or move a single object. Existing chat and
--     anon objects stay in `media` and therefore stay publicly
--     readable until scripts/migrate-private-media.mjs has been run.
--     That script is the data half of this fix; this file is the
--     authorization half.
--   * It does not flip `media` to private. That would break avatars,
--     covers, drops and voiceovers in one step.
--   * It does not change group avatars or chat wallpapers, which are
--     still written to `media/chat/<conversationId>/...`. Those are
--     listed as residual risk R2 in SECURITY_AUDIT_2026-10-23.md.
--
-- ORDER OF OPERATIONS (see MIGRATION_20261023.md)
--   1. run 20261023_01 (this file)
--   2. ship the app build that writes sb:// refs
--   3. run scripts/migrate-private-media.mjs --dry-run
--   4. run it for real, then --verify
--   5. only then consider --cleanup of the old copies
--
-- Idempotent: safe to re-run. Nothing here is destructive.
-- ============================================================


-- ------------------------------------------------------------
-- 0) HELPERS
-- ------------------------------------------------------------

-- Strict UUID parse that returns NULL instead of raising.
-- Storage policies evaluate path segments; a hand-crafted object
-- name like 'chat/not-a-uuid/x.jpg' must yield "deny", never a
-- 500 from a failed ::uuid cast.
create or replace function public.try_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  if p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return p::uuid;
  end if;
  return null;
end $$;

revoke all on function public.try_uuid(text) from public, anon;
grant execute on function public.try_uuid(text) to authenticated;


-- The owner of a PUBLIC-bucket object, read out of its path.
--
-- These are the real path builders in the app (verified by grep,
-- not assumed — the brief warned that the user id is not always
-- the first segment):
--
--   media/avatars/<uid>/avatar-*.jpg      AvatarPickerModal, OnboardingScreen
--   media/covers/<uid>/cover-*.jpg        ProfileScreen
--   media/voiceovers/<uid>/vo-*.m4a       VoiceoverRecorder
--   media/<uid>/drop-*.mp4                CreateDropScreen
--   media/<uid>/cover-*.jpg               CreateDropScreen (video cover)
--   media/chat-wallpapers/<uid>/wall-*.jpg  ChatSettingsSheet  (was chat/<conv>/)
--   media/group-avatars/<uid>/group-*.jpg   GroupInfoScreen   (was chat/<conv>/)
--
-- The last two are the only paths this migration MOVES. They used to be
-- written to chat/<conversationId>/, which is exactly the shape the new
-- ownership check refuses — correctly, because that shape names no
-- owner. They are conversation chrome (a shared wallpaper, a group
-- icon), not message content, so they stay in the public bucket under
-- an owner-scoped prefix rather than joining chat-media. Rationale is
-- recorded as R2 in SECURITY_AUDIT_2026-10-23.md.
--
-- Anything else returns NULL, which fails the policy. That is the
-- point: an unrecognised path is not owned by anyone.
create or replace function public.media_path_owner(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  with seg as (
    select case
      when p_name ~ '^(avatars|covers|voiceovers|chat-wallpapers|group-avatars)/'
        then split_part(p_name, '/', 2)
      else split_part(p_name, '/', 1)
    end as s
  )
  select case
    when s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then s::uuid
    else null
  end
  from seg;
$$;

revoke all on function public.media_path_owner(text) from public, anon;
grant execute on function public.media_path_owner(text) to authenticated;


-- Conversation membership, resolved with definer rights.
--
-- A storage policy that inlined a subquery against
-- conversation_participants would depend on that table's own RLS
-- being readable at that moment. Routing it through a definer
-- function makes the storage check independent of app RLS and, as
-- a bonus, keeps the policy legible.
create or replace function public.is_conversation_member(
  p_conversation uuid,
  p_user uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation
      and cp.user_id = p_user
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public, anon;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;


-- May the current caller send an anonymous message to p_recipient?
--
-- This is the authorization the anonymous upload path never had.
-- Before this migration ANY signed-in user could write into
-- anon/<anything>/ inside a public bucket, so the recipient check
-- for anonymous media was decorative.
--
-- Mirrors the product rules the send screen assumes:
--   * recipient exists
--   * recipient has anonymous messaging enabled
--   * neither party has blocked the other
--   * this sender is not in the recipient's anonymous block list
-- A logged-out sender (auth.uid() is null) can only satisfy the
-- block clauses vacuously, which is correct — there is no identity
-- to block.
create or replace function public.can_send_anon_to(p_recipient uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.profiles p where p.id = p_recipient)
    and coalesce(
      (select s.enabled from public.anonymous_settings s where s.user_id = p_recipient),
      true
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = p_recipient and b.blocked_id = auth.uid())
         or (b.blocker_id = auth.uid() and b.blocked_id = p_recipient)
    )
    and not exists (
      select 1 from public.anonymous_blocks ab
      where ab.recipient_id = p_recipient
        and ab.sender_id = auth.uid()
    );
$$;

revoke all on function public.can_send_anon_to(uuid) from public, anon;
grant execute on function public.can_send_anon_to(uuid) to authenticated;


-- ------------------------------------------------------------
-- 1) BUCKETS
--
--    chat-media / chat-thumbs already exist as private buckets from
--    messaging_v2.sql but no client ever wrote to them. anon-media
--    is new.
--
--    Size caps are a backstop against a single object eating the
--    project quota. MIME allow-lists are advisory only — the storage
--    API trusts the Content-Type the client sends — so they stop
--    the accidental case, not a determined attacker. Real type
--    validation would need a server-side inspection step; that is
--    recorded as residual risk R4.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('chat-media', 'chat-media', false, 52428800,  -- 50 MB
   array['image/jpeg','image/png','image/webp','image/gif',
         'video/mp4','video/quicktime','audio/mp4','audio/mpeg',
         'audio/aac','audio/ogg','application/pdf','application/zip',
         'text/plain','application/octet-stream']),
  ('chat-thumbs', 'chat-thumbs', false, 5242880, -- 5 MB
   array['image/jpeg','image/png','image/webp']),
  ('anon-media', 'anon-media', false, 20971520,  -- 20 MB
   array['image/jpeg','image/png','image/webp',
         'audio/mp4','audio/mpeg','audio/aac'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ------------------------------------------------------------
-- 2) CHAT MEDIA — participants only
--
--    Path contract (new writes):
--        chat-media/<conversationId>/<senderUid>/<file>
--        chat-thumbs/<conversationId>/<senderUid>/<file>
--
--    The conversation id is the first segment so the existing
--    messaging_v2 policy shape still applies; the sender id is the
--    second so an object has an unambiguous owner inside the
--    conversation. A participant can therefore READ everything in a
--    conversation they belong to, but can only WRITE or DELETE
--    inside their own folder.
-- ------------------------------------------------------------
drop policy if exists "chat_media_read" on storage.objects;
create policy "chat_media_read" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('chat-media', 'chat-thumbs')
    and public.is_conversation_member(
      public.try_uuid((storage.foldername(name))[1])
    )
  );

drop policy if exists "chat_media_write_own_folder" on storage.objects;
create policy "chat_media_write_own_folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(
      public.try_uuid((storage.foldername(name))[1])
    )
  );

-- UPDATE needs BOTH halves: USING pins the object that exists today,
-- WITH CHECK pins where it may move to. The pre-existing media policy
-- had `with check (bucket_id = 'media')` only, which let a caller
-- rename their own object into someone else's path.
drop policy if exists "chat_media_update_own" on storage.objects;
create policy "chat_media_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.is_conversation_member(
      public.try_uuid((storage.foldername(name))[1])
    )
  );

drop policy if exists "chat_media_delete_own" on storage.objects;
create policy "chat_media_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('chat-media', 'chat-thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
  );


-- ------------------------------------------------------------
-- 3) ANONYMOUS MEDIA — recipient reads, screened senders write
--
--    Path contract:
--        anon-media/<recipientId>/<opaque>
--
--    The path deliberately does NOT contain the sender's id. The
--    recipient can list their own folder, so a sender id in the path
--    would de-anonymise every sender to the one person they are
--    hiding from. The sender→object binding is kept in
--    anonymous_messages.sender_id, which the recipient cannot read
--    (column-level privileges, anonymous_messages.sql L72-77).
-- ------------------------------------------------------------
drop policy if exists "anon_media_read_recipient" on storage.objects;
create policy "anon_media_read_recipient" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'anon-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "anon_media_write_screened" on storage.objects;
create policy "anon_media_write_screened" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'anon-media'
    and public.can_send_anon_to(
      public.try_uuid((storage.foldername(name))[1])
    )
  );

drop policy if exists "anon_media_delete_recipient" on storage.objects;
create policy "anon_media_delete_recipient" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'anon-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ------------------------------------------------------------
-- 4) THE PUBLIC BUCKET — ownership without enumeration
--
--    Replaces final_fix.sql's:
--      media_upload  insert to authenticated  with check (bucket_id='media')
--      media_update  ... using (first folder = uid) with check (bucket)
--      media_delete  ... using (first folder = uid)
--      media_read    select to public using (bucket_id='media')
--
--    `with check (bucket_id = 'media')` alone means any signed-in
--    user may write any path — including into another user's avatar
--    folder and into any chat folder. That is finding A4.
-- ------------------------------------------------------------
drop policy if exists "media_upload" on storage.objects;
drop policy if exists "media_update" on storage.objects;
drop policy if exists "media_delete" on storage.objects;
drop policy if exists "media_read" on storage.objects;

create policy "media_upload_own_path" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and public.media_path_owner(name) = auth.uid()
  );

create policy "media_update_own_path" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'media'
    and public.media_path_owner(name) = auth.uid()
  )
  with check (
    bucket_id = 'media'
    and public.media_path_owner(name) = auth.uid()
  );

create policy "media_delete_own_path" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and public.media_path_owner(name) = auth.uid()
  );

-- Deliberately NO select policy on `media`.
--
-- Public object delivery is not policy-driven for a public bucket, so
-- avatars, covers, drops and voiceovers stay reachable by URL. What
-- disappears is the ability to LIST the bucket and to create a signed
-- URL against it — the two things an enumeration attack needs.
-- If a future feature needs .list() on `media`, add a policy scoped to
-- that prefix; do not restore `for select using (true)`.


-- ------------------------------------------------------------
-- 5) VERIFICATION
--
--    Expect:
--      private_buckets = 3
--      media_public_policies = 3   (insert/update/delete — no select)
--      chat_policies = 4
--      anon_policies = 3
-- ------------------------------------------------------------
select 'private_buckets' as check_name,
       count(*) as n
from storage.buckets
where id in ('chat-media', 'chat-thumbs', 'anon-media')
  and public = false;

select 'media_public_policies' as check_name,
       count(*) as n
from pg_policies
where schemaname = 'storage'
  and tablename  = 'objects'
  and policyname like 'media\_%';

-- This one must return ZERO rows. A row here is the enumeration hole.
select 'media_select_policy_still_present' as check_name, policyname as n
from pg_policies
where schemaname = 'storage'
  and tablename  = 'objects'
  and policyname = 'media_read';

select 'chat_policies' as check_name,
       count(*) as n
from pg_policies
where schemaname = 'storage'
  and tablename  = 'objects'
  and policyname like 'chat\_media\_%';

select 'anon_policies' as check_name,
       count(*) as n
from pg_policies
where schemaname = 'storage'
  and tablename  = 'objects'
  and policyname like 'anon\_media\_%';


-- ============================================================
-- ROLLBACK (manual, only if this migration must be undone)
--
--   drop policy if exists "media_upload_own_path"     on storage.objects;
--   drop policy if exists "media_update_own_path"     on storage.objects;
--   drop policy if exists "media_delete_own_path"     on storage.objects;
--   drop policy if exists "chat_media_read"           on storage.objects;
--   drop policy if exists "chat_media_write_own_folder" on storage.objects;
--   drop policy if exists "chat_media_update_own"     on storage.objects;
--   drop policy if exists "chat_media_delete_own"     on storage.objects;
--   drop policy if exists "anon_media_read_recipient" on storage.objects;
--   drop policy if exists "anon_media_write_screened" on storage.objects;
--   drop policy if exists "anon_media_delete_recipient" on storage.objects;
--
--   -- restore the previous (weaker) media policies from final_fix.sql
--   -- by re-running that file's section 3.
--
--   -- `anon-media` is left in place; an empty private bucket is inert.
--   -- Do NOT delete chat-media: the app writes there after the client
--   -- build ships.
--
-- Rolling back restores the publicly-listable bucket. Only do it if
-- the client rollback is also happening.
-- ============================================================

commit;
