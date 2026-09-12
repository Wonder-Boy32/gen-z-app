-- ============================================================
-- GEN Z — ANONYMOUS: BELL NOTIFICATIONS + EXPIRY CLEANUP
-- Run ONCE in the Supabase SQL editor (additive + idempotent).
--  1) Bell notification when an anonymous message arrives
--     (actor_id stays NULL — the sender remains anonymous).
--  2) Expired anonymous messages are deleted:
--     - lazily inside the send RPC (on every send),
--     - and by a pg_cron job every 15 minutes (+ their media).
-- ============================================================

-- ------------------------------------------------------------
-- 1) NOTIFICATIONS — allow actorless rows + the new type
-- ------------------------------------------------------------
alter table public.notifications alter column actor_id drop not null;

-- drop any existing check constraint on the type column (name may vary)
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'c'
      and conname like '%type%check%'
  loop
    execute format('alter table public.notifications drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.notifications add constraint notifications_type_check
  check (type in ('follow', 'like', 'comment', 'reply', 'reaction', 'repost', 'comment_like', 'anon_message'));

-- ------------------------------------------------------------
-- 2) SEND RPC — lazy expiry cleanup + recipient notification
-- ------------------------------------------------------------
create or replace function public.send_anonymous_message(
  p_recipient uuid,
  p_content text default null,
  p_media text default null,
  p_voice text default null,
  p_type text default 'text',
  p_expires interval default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sender uuid := nullif(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
  v_id uuid;
begin
  if auth.uid() is not null then
    v_sender := auth.uid();
  end if;

  -- lazy expiry cleanup: drop rows that already expired (keeps the table lean)
  delete from public.anonymous_messages
    where expires_at is not null and expires_at < now();

  insert into public.anonymous_messages
    (recipient_id, sender_id, content, media_url, voice_url, message_type, expires_at)
  values
    (p_recipient, v_sender, p_content, p_media, p_voice, p_type,
     case when p_expires is not null then now() + p_expires else null end)
  returning id into v_id;

  -- bell notification — actor_id NULL so the sender stays anonymous
  insert into public.notifications (user_id, actor_id, type)
  values (p_recipient, null, 'anon_message');

  return v_id;
end $$;

grant execute on function public.send_anonymous_message(uuid, text, text, text, text, interval)
  to anon, authenticated;

-- ------------------------------------------------------------
-- 3) SCHEDULED CLEANUP — every 15 minutes (pg_cron)
--    Deletes expired rows AND their uploaded media. If pg_cron
--    is unavailable on this project, the lazy cleanup in the
--    RPC still handles expiry on every send.
-- ------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule(jobid) from cron.job where jobname = 'anon_expiry_cleanup';

  perform cron.schedule('anon_expiry_cleanup', '*/15 * * * *', $job$
    -- media of expired messages first (rows still exist at this point)
    with expired as (
      select media_url, voice_url
      from public.anonymous_messages
      where expires_at is not null and expires_at < now()
    ),
    urls as (
      select media_url as u from expired where media_url is not null
      union all
      select voice_url  as u from expired where voice_url  is not null
    ),
    paths as (
      select substring(u from position('/object/public/' in u) + length('/object/public/')) as p
      from urls where u like '%/object/public/%'
    )
    delete from storage.objects o
    using paths
    where (o.bucket_id || '/' || o.name) = paths.p;

    -- then the rows themselves
    delete from public.anonymous_messages
    where expires_at is not null and expires_at < now();
  $job$);
exception when others then
  raise notice 'pg_cron unavailable — skipping scheduled cleanup: %', sqlerrm;
end $$;
