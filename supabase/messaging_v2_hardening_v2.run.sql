drop policy if exists "messages_update_own"    on public.messages;
drop policy if exists "messages_update_member" on public.messages;
create policy "messages_update_member" on public.messages
  for update to authenticated
  using (conversation_id in (select public.my_conversation_ids()))
  with check (conversation_id in (select public.my_conversation_ids()));
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid     uuid    := auth.uid();
  v_purging boolean := coalesce(current_setting('app.msg_purge', true), 'off') = 'on';
  v_open    text[]  := array['pinned_at', 'pinned_by'];
begin
  if new.sender_id <> old.sender_id then
    raise exception 'sender_id is immutable';
  end if;
  if new.conversation_id <> old.conversation_id then
    raise exception 'conversation_id is immutable';
  end if;
  if new.client_message_id is distinct from old.client_message_id then
    raise exception 'client_message_id is immutable';
  end if;
  if new.seq is distinct from old.seq then
    raise exception 'seq is immutable';
  end if;
  if not v_purging and v_uid is not null and v_uid <> old.sender_id then
    if (to_jsonb(new) - v_open) is distinct from (to_jsonb(old) - v_open) then
      raise exception 'only the author may change this message';
    end if;
  end if;
  if new.content is distinct from old.content
     or new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end $$;
drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update
  before update on public.messages
  for each row execute function public.messages_guard_update();
create or replace function public.purge_expired_messages(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  perform set_config('app.msg_purge', 'on', true);
  with expired as (
    select id from public.messages
    where expires_at is not null
      and expires_at < now()
      and deleted_at is null
    order by expires_at
    limit p_limit
  ), upd as (
    update public.messages m
       set deleted_at = now(), content = null, body = '{}'::jsonb
      from expired e
     where m.id = e.id
    returning m.id
  )
  select count(*) into v_count from upd;
  perform set_config('app.msg_purge', 'off', true);
  if to_regclass('public.media_cleanup_queue') is not null then
    execute $q$
      insert into public.media_cleanup_queue (storage_bucket, storage_path)
      select a.storage_bucket, a.storage_path
      from public.message_attachments a
      join public.messages m on m.id = a.message_id
      where m.deleted_at is not null and a.storage_path is not null
    $q$;
  end if;
  return v_count;
end $$;
revoke all on function public.purge_expired_messages(int) from public, anon;
grant execute on function public.purge_expired_messages(int) to authenticated;
drop policy if exists "realtime_join_own_conversations" on realtime.messages;
create policy "realtime_join_own_conversations"
on realtime.messages for select to authenticated
using (
  realtime.topic() in (
    select 'conv:' || cp.conversation_id::text
    from public.conversation_participants cp
    where cp.user_id = auth.uid()
  )
);
