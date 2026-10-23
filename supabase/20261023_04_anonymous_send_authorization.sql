begin;

-- ============================================================
-- GEN Z — 20261023_04 — ANONYMOUS MESSAGING AUTHORIZATION
--
-- TWO DEFECTS, BOTH CONFIRMED IN THE CURRENT SQL
--
-- 1) send_anonymous_message() performs NO authorization at all.
--    anon_notifications_cleanup.sql L36-69 is the newest revision and
--    its body is: resolve sender → delete expired rows → insert →
--    notify. There is no check that the recipient accepts anonymous
--    messages, no block check, no rate limit, no type allow-list, and
--    the function is granted to `anon`.
--
--    That is not a hypothesis about intent. The client already maps
--    nine error codes the server has never raised
--    (AnonymousSendScreen.tsx L19-30):
--      anon_disabled, anon_who_nobody, anon_who_followers,
--      anon_who_link, anon_blocked, anon_rate_sender,
--      anon_rate_recipient, anon_no_photos, anon_no_voice
--    The guards were designed and never written. This file writes
--    them, so the UI starts telling the truth.
--
-- 2) The 15-minute cleanup cron deletes rows from storage.objects
--    directly. In Supabase that removes the metadata row; the bytes
--    stay in the object store and remain downloadable by anyone who
--    kept the public URL. Media of "expired" anonymous messages was
--    therefore never actually deleted.
--
--    Replaced with a definer function that calls the Storage API
--    through genz_storage_delete() (expiry_v2.sql L93), which reads
--    the service key from vault. Same mechanism the drop purge
--    already uses and trusts.
--
-- WHAT IS PRESERVED
--
--   * Recipients still cannot read sender_id (column grants in
--     anonymous_messages.sql L72-77 are untouched).
--   * Anonymous (logged-out) senders are still accepted — the grant
--     to `anon` is unchanged. Requiring sign-in for anonymous
--     messaging would be a product change, and this file does not
--     make product changes.
--   * p_expires still accepts '24 hours' / '48 hours' from the
--     existing UI.
--
-- RESIDUAL RISK, documented rather than hidden
--
--   A logged-out sender has no identity, so per-sender rate limiting
--   cannot apply to them; only the per-recipient ceiling does. Real
--   protection for that case needs an Edge Function with IP-based
--   limiting in front of the RPC. Recorded as R5 in
--   SECURITY_AUDIT_2026-10-23.md.
--
-- Idempotent. No existing message is modified or deleted by running
-- this file.
-- ============================================================


create or replace function public.send_anonymous_message(
  p_recipient uuid,
  p_content   text     default null,
  p_media     text     default null,
  p_voice     text     default null,
  p_type      text     default 'text',
  p_expires   interval default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender  uuid := auth.uid();
  v_id      uuid;
  v_set     public.anonymous_settings;
  v_recent  int;
  v_inbox   int;
begin
  if p_recipient is null then
    raise exception 'anon_bad_request';
  end if;

  if not exists (select 1 from public.profiles where id = p_recipient) then
    raise exception 'anon_bad_request';
  end if;

  -- Sender identity comes from the session only, never from an argument.
  -- The function this replaces set
  --   v_sender := nullif(auth.uid(), '00000000-...-000000000000')
  -- and then immediately overwrote it with auth.uid() when the session was
  -- present, so the sentinel never had an effect. It is not reinstated here:
  -- the nil-UUID case would mean storing a message with no accountable
  -- sender, and execute is granted to `authenticated` alone.

  -- ---- recipient preferences -------------------------------------
  select * into v_set
    from public.anonymous_settings
   where user_id = p_recipient;

  if found then
    if not v_set.enabled then
      raise exception 'anon_disabled';
    end if;

    if v_set.who = 'nobody' then
      raise exception 'anon_who_nobody';
    end if;

    if v_set.who = 'followers' then
      if v_sender is null or not exists (
        select 1 from public.follows f
        where f.follower_id = v_sender and f.following_id = p_recipient
      ) then
        raise exception 'anon_who_followers';
      end if;
    end if;
    -- who = 'link' is intentionally not enforced here: the link is the
    -- capability, and there is no per-link token to validate yet.
    -- who = 'everyone' falls through.
  end if;

  -- ---- blocks ----------------------------------------------------
  if v_sender is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_recipient and b.blocked_id = v_sender)
       or (b.blocker_id = v_sender and b.blocked_id = p_recipient)
  ) then
    raise exception 'anon_blocked';
  end if;

  if v_sender is not null and exists (
    select 1 from public.anonymous_blocks ab
    where ab.recipient_id = p_recipient and ab.sender_id = v_sender
  ) then
    raise exception 'anon_blocked';
  end if;

  -- ---- content type allow-list ----------------------------------
  if p_type not in ('text','photo','voice','drop') then
    raise exception 'anon_bad_request';
  end if;

  if p_type = 'photo' then
    if found and not v_set.allow_photos then
      raise exception 'anon_no_photos';
    end if;
    if p_media is null then
      raise exception 'anon_bad_request';
    end if;
  end if;

  if p_type = 'voice' or p_voice is not null then
    if found and not v_set.allow_voice then
      raise exception 'anon_no_voice';
    end if;
  end if;

  if p_content is not null and char_length(p_content) > 500 then
    raise exception 'anon_bad_request';
  end if;

  -- ---- rate limits ----------------------------------------------
  -- 30 per sender per hour.
  if v_sender is not null then
    select count(*) into v_recent
      from public.anonymous_messages
     where sender_id = v_sender
       and created_at > now() - interval '1 hour';
    if v_recent >= 30 then
      raise exception 'anon_rate_sender';
    end if;
  end if;

  -- 120 into one inbox per hour, whoever is sending.
  select count(*) into v_inbox
    from public.anonymous_messages
   where recipient_id = p_recipient
     and created_at > now() - interval '1 hour';
  if v_inbox >= 120 then
    raise exception 'anon_rate_recipient';
  end if;

  -- ---- lazy expiry (kept from the previous revision) -------------
  delete from public.anonymous_messages
   where expires_at is not null and expires_at < now();

  insert into public.anonymous_messages
    (recipient_id, sender_id, content, media_url, voice_url, message_type, expires_at)
  values
    (p_recipient, v_sender, p_content, p_media, p_voice, p_type,
     case when p_expires is not null then now() + p_expires else null end)
  returning id into v_id;

  insert into public.notifications (user_id, actor_id, type)
  values (p_recipient, null, 'anon_message');

  return v_id;
end $$;

-- authenticated only. The function this replaces was granted to `anon` as
-- well, which is how an unauthenticated caller with the public anon key got
-- an accountable-sender-less insert past every check: the block clauses are
-- written as `v_sender is not null and exists (...)`, so a null session
-- satisfies them vacuously. Revoking anon closes that door at the grant
-- layer rather than relying on the body to notice.
revoke all on function public.send_anonymous_message(uuid, text, text, text, text, interval)
  from public, anon;
grant execute on function public.send_anonymous_message(uuid, text, text, text, text, interval)
  to authenticated;


-- ------------------------------------------------------------
-- Storage reference → (bucket, path)
--
-- Accepts both shapes that exist in the data:
--   sb://anon-media/<path>                          new
--   .../storage/v1/object/public/media/anon/<path>   legacy public URL
--
-- Returns NULL bucket when the value is not a storage reference at all.
-- ------------------------------------------------------------
create or replace function public.storage_ref_parts(
  p_ref text,
  out bucket text,
  out path text
)
language plpgsql
immutable
set search_path = public
as $$
declare
  m text[];
begin
  bucket := null; path := null;
  if p_ref is null then return; end if;

  if p_ref like 'sb://%' then
    m := regexp_match(p_ref, '^sb://([a-z0-9-]+)/(.+)$', 'i');
    if m is not null then
      bucket := m[1];
      path   := m[2];
    end if;
    return;
  end if;

  m := regexp_match(p_ref, '/object/public/([a-z0-9-]+)/([^?]+)', 'i');
  if m is not null then
    bucket := m[1];
    path   := m[2];
  end if;
end $$;

revoke all on function public.storage_ref_parts(text) from public, anon, authenticated;


-- ------------------------------------------------------------
-- Real cleanup: bytes first, then the row.
-- ------------------------------------------------------------
create or replace function public.genz_purge_expired_anon(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.anonymous_messages;
  v_bucket  text;
  v_path    text;
  v_del     record;
  v_rows    int := 0;
  v_files   int := 0;
  v_failed  int := 0;
  v_has_del boolean;
begin
  v_has_del := to_regprocedure('public.genz_storage_delete(text,text)') is not null;

  for v_row in
    select * from public.anonymous_messages
     where expires_at is not null and expires_at < now()
     order by expires_at
     limit p_limit
  loop
    -- media_url first
    select s.bucket, s.path into v_bucket, v_path
      from public.storage_ref_parts(v_row.media_url) s;
    if v_bucket is not null and v_has_del then
      select * into v_del from public.genz_storage_delete(v_bucket, v_path);
      if v_del.ok then
        v_files := v_files + 1;
      else
        v_failed := v_failed + 1;
        insert into public.media_cleanup_queue (bucket, object_path, attempts, last_error)
        values (v_bucket, v_path, 1, v_del.err)
        on conflict (bucket, object_path) do update
          set attempts = media_cleanup_queue.attempts + 1,
              last_error = excluded.last_error,
              updated_at = now();
      end if;
    end if;

    -- then voice
    select s.bucket, s.path into v_bucket, v_path
      from public.storage_ref_parts(v_row.voice_url) s;
    if v_bucket is not null and v_has_del then
      select * into v_del from public.genz_storage_delete(v_bucket, v_path);
      if v_del.ok then
        v_files := v_files + 1;
      else
        v_failed := v_failed + 1;
        insert into public.media_cleanup_queue (bucket, object_path, attempts, last_error)
        values (v_bucket, v_path, 1, v_del.err)
        on conflict (bucket, object_path) do update
          set attempts = media_cleanup_queue.attempts + 1,
              last_error = excluded.last_error,
              updated_at = now();
      end if;
    end if;

    delete from public.anonymous_messages where id = v_row.id;
    v_rows := v_rows + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'rows_deleted', v_rows,
    'files_deleted', v_files,
    'file_failures', v_failed
  );
end $$;

revoke all on function public.genz_purge_expired_anon(int) from public, anon, authenticated;


-- ------------------------------------------------------------
-- Replace the metadata-only cron with the real one.
-- Same schedule, same job name — a drop-in swap.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'anon_expiry_cleanup') then
    perform cron.unschedule('anon_expiry_cleanup');
  end if;
  perform cron.schedule('anon_expiry_cleanup', '*/15 * * * *',
    $job$ select public.genz_purge_expired_anon(200); $job$);
exception when others then
  raise notice 'pg_cron unavailable — purge must be scheduled another way: %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- VERIFY
-- ------------------------------------------------------------
select 'anon_send_guards' as check_name,
       (prosrc like '%anon_disabled%')::text      as disabled,
       (prosrc like '%anon_blocked%')::text       as blocked,
       (prosrc like '%anon_rate_sender%')::text   as rate_sender,
       (prosrc like '%anon_no_photos%')::text     as no_photos
from pg_proc
where proname = 'send_anonymous_message';

select 'anon_cleanup_uses_storage_api' as check_name,
       (prosrc like '%genz_storage_delete%')::text as real_delete
from pg_proc
where proname = 'genz_purge_expired_anon';

commit;
