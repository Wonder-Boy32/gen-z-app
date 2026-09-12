-- ============================================================
-- GEN Z  --  REAL PUSH NOTIFICATIONS
--
-- Turns every row inserted into public.notifications into a real
-- notification in the phone's notification bar -- delivered by Postgres
-- itself through pg_net, so it still arrives when the app is closed.
--
-- Run this whole file once in the Supabase SQL editor.
-- Idempotent - safe to re-run.
--
-- Requires: pg_net (already used by pg_net_fix.sql in this project) and
-- the notifications table from notifications.sql.
-- ============================================================

create extension if not exists pg_net;

-- ------------------------------------------------------------
-- 1) devices
-- ------------------------------------------------------------
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique,
  platform text,
  device text,
  app_version text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens_select" on public.push_tokens;
create policy "push_tokens_select" on public.push_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "push_tokens_insert" on public.push_tokens;
create policy "push_tokens_insert" on public.push_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists "push_tokens_update" on public.push_tokens;
create policy "push_tokens_update" on public.push_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "push_tokens_delete" on public.push_tokens;
create policy "push_tokens_delete" on public.push_tokens
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 2) registration (called by the app on every start / login)
--    A physical phone belongs to whoever is signed in NOW, so the token
--    is moved rather than duplicated when someone switches accounts.
-- ------------------------------------------------------------
create or replace function public.register_push_token(
  p_token text,
  p_platform text default null,
  p_device text default null,
  p_app_version text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_token is null or length(trim(p_token)) = 0 then
    return;
  end if;

  delete from public.push_tokens where token = trim(p_token) and user_id <> v_uid;

  insert into public.push_tokens (user_id, token, platform, device, app_version, enabled, created_at, updated_at)
  values (v_uid, trim(p_token), p_platform, p_device, p_app_version, true, now(), now())
  on conflict (token) do update
     set user_id     = v_uid,
         platform    = coalesce(excluded.platform, public.push_tokens.platform),
         device      = coalesce(excluded.device, public.push_tokens.device),
         app_version = coalesce(excluded.app_version, public.push_tokens.app_version),
         enabled     = true,
         updated_at  = now();
end;
$$;

revoke all on function public.register_push_token(text, text, text, text) from public;
grant execute on function public.register_push_token(text, text, text, text) to authenticated;

create or replace function public.unregister_push_token(p_token text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
end;
$$;

revoke all on function public.unregister_push_token(text) from public;
grant execute on function public.unregister_push_token(text) to authenticated;

-- ------------------------------------------------------------
-- 3) message builder
--    Returns the Expo message for a notification row, or NULL when the
--    recipient has muted that kind of activity.
-- ------------------------------------------------------------
create or replace function public.build_push_message(
  p_user_id uuid,
  p_type text,
  p_actor_id uuid,
  p_post_id uuid,
  p_comment_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor text;
  v_title text;
  v_body text;
  v_channel text;
  v_preview text;
  v_unread int;
  v_allowed boolean;
begin
  select coalesce(nullif(display_name, ''), username)
    into v_actor
    from public.profiles
   where id = p_actor_id;
  v_actor := coalesce(v_actor, 'Someone');

  if p_comment_id is not null then
    select left(regexp_replace(coalesce(content, ''), '\s+', ' ', 'g'), 120)
      into v_preview
      from public.comments
     where id = p_comment_id;
  end if;

  case p_type
    when 'follow'       then v_title := 'New follower'; v_body := v_actor || ' started following you'; v_channel := 'follows';
    when 'like'         then v_title := 'New like';     v_body := v_actor || ' liked your drop';      v_channel := 'likes';
    when 'reaction'     then v_title := 'New reaction'; v_body := v_actor || ' reacted to your drop'; v_channel := 'likes';
    when 'comment_like' then v_title := 'New like';     v_body := v_actor || ' liked your comment';  v_channel := 'likes';
    when 'comment'      then v_title := 'New comment';  v_body := v_actor || ': ' || coalesce(v_preview, 'commented on your drop'); v_channel := 'comments';
    when 'reply'        then v_title := 'New reply';    v_body := v_actor || ': ' || coalesce(v_preview, 'replied to your comment'); v_channel := 'comments';
    when 'repost'       then v_title := 'New repost';   v_body := v_actor || ' reposted your drop';  v_channel := 'follows';
    when 'anon_message' then v_title := 'Anonymous message'; v_body := 'Someone sent you an anonymous message'; v_channel := 'messages';
    when 'call'         then v_title := 'Missed call';  v_body := v_actor || ' tried to call you';  v_channel := 'messages';
    else                     v_title := 'Gen Z';        v_body := 'New activity on your profile';   v_channel := 'default';
  end case;

  -- Respect the switches on the Settings page. No settings row means the
  -- user never changed anything, which means: send.
  select case
           when p_type in ('like', 'comment_like', 'reaction')  then s.notif_likes
           when p_type in ('comment', 'reply')                  then s.notif_comments
           when p_type in ('follow', 'repost')                  then s.notif_followers
           when p_type in ('anon_message', 'call')              then s.notif_messages
           else true
         end
    into v_allowed
    from public.settings s
   where s.user_id = p_user_id;

  if v_allowed is false then
    return null;
  end if;

  select count(*) into v_unread
    from public.notifications
   where user_id = p_user_id and read = false;

  return jsonb_build_object(
    'title', v_title,
    'body', v_body,
    'sound', 'default',
    'channelId', v_channel,
    'badge', coalesce(v_unread, 0),
    'priority', 'high',
    'data', jsonb_build_object(
      'type', p_type,
      'actor', v_actor,
      'postId', p_post_id,
      'commentId', p_comment_id,
      'link', case when p_post_id is not null then 'genz://post/' || p_post_id else 'genz://activity' end
    )
  );
end;
$$;

revoke all on function public.build_push_message(uuid, text, uuid, uuid, uuid) from public;

-- ------------------------------------------------------------
-- 4) delivery - one batched request to Expo for all of that user's devices
-- ------------------------------------------------------------
create or replace function public.send_push_to_user(p_user_id uuid, p_message jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_messages jsonb;
begin
  select jsonb_agg(p_message || jsonb_build_object('to', t.token))
    into v_messages
    from public.push_tokens t
   where t.user_id = p_user_id and t.enabled;

  if v_messages is null or jsonb_array_length(v_messages) = 0 then
    return;
  end if;

  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json'),
    body := v_messages,
    timeout_milliseconds := 5000
  );
end;
$$;

revoke all on function public.send_push_to_user(uuid, jsonb) from public;

-- ------------------------------------------------------------
-- 5) the trigger: every notification row becomes a real push
-- ------------------------------------------------------------
create or replace function public.notifications_send_push()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_msg jsonb;
begin
  if new.user_id = new.actor_id then
    return new;         -- never push someone about their own action
  end if;

  v_msg := public.build_push_message(new.user_id, new.type, new.actor_id, new.post_id, new.comment_id);
  if v_msg is null then
    return new;         -- muted by the recipient
  end if;

  perform public.send_push_to_user(new.user_id, v_msg);
  return new;
end;
$$;

drop trigger if exists trg_notifications_push on public.notifications;
create trigger trg_notifications_push
  after insert on public.notifications
  for each row execute function public.notifications_send_push();

-- ------------------------------------------------------------
-- Known limitation (documented, not hidden):
-- Expo reports dead tokens ("DeviceNotRegistered") in a SECOND response
-- (push receipts), which needs another HTTP round trip. This file does not
-- consume receipts, so a dead token stays in the table until that device
-- registers again. Rows are harmless - Expo just ignores them.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 6) realtime: lets the open app prepend new activity instantly (and show it
--    in the phone's bar without waiting for the push to arrive)
-- ------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception
    when duplicate_object then null;   -- already published
    when undefined_object then null;   -- publication missing on this project
  end;
end $$;

-- ------------------------------------------------------------
-- 7) verify (should return the columns above)
-- ------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_name = 'push_tokens'
 order by ordinal_position;
