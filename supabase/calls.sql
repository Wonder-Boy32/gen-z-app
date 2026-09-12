-- ============================================================
-- GEN Z — CALL HISTORY (WhatsApp-style)
-- Persists voice/video calls per conversation so calls appear
-- inside the chat thread, and missed calls create a bell
-- notification. Idempotent — safe to re-run.
-- ============================================================

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'completed', 'declined', 'missed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration int
);

create index if not exists calls_conversation_idx on public.calls (conversation_id, started_at);
create index if not exists calls_callee_idx on public.calls (callee_id, started_at);

alter table public.calls enable row level security;

drop policy if exists "calls_select" on public.calls;
create policy "calls_select" on public.calls
  for select using (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists "calls_insert" on public.calls;
create policy "calls_insert" on public.calls
  for insert with check (caller_id = auth.uid());

-- ------------------------------------------------------------
-- start a call (returns the call id used for signaling)
-- ------------------------------------------------------------
create or replace function public.calls_start(p_conversation_id uuid, p_callee_id uuid, p_kind text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_kind not in ('audio', 'video') then
    raise exception 'invalid kind';
  end if;
  -- both users must be participants of the conversation
  if not exists (
    select 1
    from public.conversation_participants
    where conversation_id = p_conversation_id
      and user_id in (auth.uid(), p_callee_id)
    group by conversation_id
    having count(distinct user_id) = 2
  ) then
    raise exception 'participants only';
  end if;
  insert into public.calls (conversation_id, caller_id, callee_id, kind)
  values (p_conversation_id, auth.uid(), p_callee_id, p_kind)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.calls_start(uuid, uuid, text) from public, anon;
grant execute on function public.calls_start(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------
-- update a call's lifecycle (participants only)
-- ------------------------------------------------------------
create or replace function public.calls_set_status(p_call_id uuid, p_status text, p_duration int default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_status not in ('ringing', 'active', 'completed', 'declined', 'missed') then
    raise exception 'invalid status';
  end if;
  update public.calls c
    set status = p_status,
        ended_at = case
          when p_status in ('completed', 'declined', 'missed') then coalesce(c.ended_at, now())
          else c.ended_at
        end,
        duration = case
          when p_status = 'completed'
            then coalesce(p_duration, greatest(0, extract(epoch from (now() - c.started_at))::int))
          else c.duration
        end
    where c.id = p_call_id
      and (c.caller_id = v_uid or c.callee_id = v_uid);
end $$;

revoke execute on function public.calls_set_status(uuid, text, int) from public, anon;
grant execute on function public.calls_set_status(uuid, text, int) to authenticated;

-- ------------------------------------------------------------
-- missed call → bell notification for the callee
-- ------------------------------------------------------------
drop trigger if exists calls_missed_notify on public.calls;

create or replace function public.calls_missed_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'missed' and old.status is distinct from 'missed' then
    insert into public.notifications (user_id, actor_id, type)
    values (new.callee_id, new.caller_id, 'call');
  end if;
  return new;
end $$;

create trigger calls_missed_notify after update on public.calls
  for each row execute function public.calls_missed_notify();

-- ------------------------------------------------------------
-- extend the notification type allow-list with 'call'
-- ------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('follow', 'like', 'comment', 'reply', 'reaction', 'repost', 'comment_like', 'anon_message', 'call'));
