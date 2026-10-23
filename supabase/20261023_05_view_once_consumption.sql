-- ============================================================
-- GEN Z — 20261023_05 — SERVER-ENFORCED VIEW-ONCE
--
-- THE DEFECT
--
-- "View once" was entirely a client decision. ConversationScreen
-- recorded a view (message_views, correctly) and then hid the bubble
-- locally. The FILE was never touched:
--
--   * the object stayed in the public `media` bucket
--   * messages.media_url kept the URL
--   * the same recipient could close and reopen the viewer, or reload
--     the thread, and fetch it again
--   * anyone holding the URL — including anyone who listed the bucket
--     — could fetch it with no account at all
--
-- A client-side flag cannot make a file private, and hiding a bubble
-- is not consumption.
--
-- WHAT THIS DOES
--
--   1. Adds an explicit consumption record on the message
--      (view_once_consumed_at / view_once_consumed_by).
--   2. consume_view_once() — the only way a recipient obtains the
--      media reference. It authorizes on conversation membership,
--      refuses the sender, refuses a second consumption, writes the
--      message_views row and the consumption stamp together, then
--      returns the private reference. A second call raises
--      'already_viewed' regardless of anything the client does.
--   3. genz_sweep_consumed_view_once() — deletes the BYTES five
--      minutes after consumption (long enough for the viewer to load
--      and for a slow connection to finish) and nulls media_url.
--
-- WHAT THIS DOES NOT DO — stated plainly
--
--   A recipient who captures the storage path and re-signs it during
--   the five-minute window can still read the object once. Closing
--   that requires the bytes to be streamed by a server component that
--   counts reads, i.e. an Edge Function in front of the bucket.
--   Screenshots and screen recording are also not preventable — the
--   app can detect them (expo-screen-capture) but not stop them.
--   Both are recorded as R1 in SECURITY_AUDIT_2026-10-23.md.
--
-- The five-minute window is a deliberate trade of a small re-fetch
-- risk against every recipient seeing a broken image on a slow link.
-- Tighten it by changing the interval below.
--
-- Idempotent. No message content modified by running this file.
-- ============================================================


alter table public.messages
  add column if not exists view_once_consumed_at timestamptz,
  add column if not exists view_once_consumed_by uuid;

create index if not exists messages_view_once_consumed_idx
  on public.messages (view_once_consumed_at)
  where view_once_consumed_at is not null;


create or replace function public.consume_view_once(p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.messages;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select * into v_row from public.messages where id = p_message;
  if not found then
    raise exception 'not_found';
  end if;

  if not coalesce(v_row.view_once, false) then
    raise exception 'not_view_once';
  end if;

  -- The sender sees their own moment without consuming it.
  if v_row.sender_id = v_uid then
    raise exception 'sender_cannot_consume';
  end if;

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = v_row.conversation_id
      and cp.user_id = v_uid
  ) then
    raise exception 'forbidden';
  end if;

  -- Serialize concurrent opens: two taps must not both succeed.
  perform 1 from public.messages where id = p_message for update;

  select * into v_row from public.messages where id = p_message;
  if v_row.view_once_consumed_at is not null then
    raise exception 'already_viewed';
  end if;

  insert into public.message_views (message_id, user_id)
  values (p_message, v_uid)
  on conflict do nothing;

  update public.messages
     set view_once_consumed_at = now(),
         view_once_consumed_by = v_uid
   where id = p_message;

  return jsonb_build_object(
    'ok', true,
    'media_ref', v_row.media_url,
    'kind', v_row.msg_type
  );
end $$;

revoke all on function public.consume_view_once(uuid) from public, anon;
grant execute on function public.consume_view_once(uuid) to authenticated;


-- ------------------------------------------------------------
-- Byte deletion, five minutes after consumption.
-- Reuses genz_storage_delete() so the service key never leaves vault.
-- ------------------------------------------------------------
create or replace function public.genz_sweep_consumed_view_once(p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.messages;
  v_bucket text;
  v_path   text;
  v_del    record;
  v_rows   int := 0;
  v_files  int := 0;
  v_fail   int := 0;
begin
  for v_row in
    select * from public.messages
     where view_once_consumed_at is not null
       and view_once_consumed_at < now() - interval '5 minutes'
       and media_url is not null
     order by view_once_consumed_at
     limit p_limit
  loop
    select s.bucket, s.path into v_bucket, v_path
      from public.storage_ref_parts(v_row.media_url) s;

    if v_bucket is not null then
      select * into v_del from public.genz_storage_delete(v_bucket, v_path);
      if v_del.ok then
        v_files := v_files + 1;
      else
        v_fail := v_fail + 1;
        insert into public.media_cleanup_queue (bucket, object_path, attempts, last_error)
        values (v_bucket, v_path, 1, v_del.err)
        on conflict (bucket, object_path) do update
          set attempts = media_cleanup_queue.attempts + 1,
              last_error = excluded.last_error,
              updated_at = now();
      end if;
    end if;

    -- The pointer goes away whether or not the byte delete succeeded;
    -- a failed delete is retried from media_cleanup_queue.
    update public.messages set media_url = null where id = v_row.id;
    v_rows := v_rows + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'rows', v_rows, 'files_deleted', v_files, 'file_failures', v_fail
  );
end $$;

revoke all on function public.genz_sweep_consumed_view_once(int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'genz_view_once_sweep') then
    perform cron.unschedule('genz_view_once_sweep');
  end if;
  perform cron.schedule('genz_view_once_sweep', '*/2 * * * *',
    $job$ select public.genz_sweep_consumed_view_once(100); $job$);
exception when others then
  raise notice 'pg_cron unavailable — schedule genz_sweep_consumed_view_once manually: %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- VERIFY
-- ------------------------------------------------------------
select 'columns' as check_name, count(*) as n
from information_schema.columns
where table_schema = 'public' and table_name = 'messages'
  and column_name in ('view_once_consumed_at', 'view_once_consumed_by');

select 'rpc' as check_name, count(*) as n
from pg_proc where proname = 'consume_view_once';


-- ============================================================
-- ACCEPTANCE TESTS (two real accounts, one view-once message)
--
--   1. recipient: select public.consume_view_once('<mid>');
--      -> {ok:true, media_ref:"sb://chat-media/..."}
--   2. recipient again:
--      -> ERROR already_viewed
--   3. sender:
--      -> ERROR sender_cannot_consume
--   4. third account, not a participant -> ERROR forbidden
--   5. logged out -> ERROR unauthorized
--   6. after 5 minutes, genz_sweep_consumed_view_once()
--      -> media_url null, object gone from storage
-- ============================================================
