-- ============================================================
-- GEN Z — CHAT SETTINGS + CALLS (run ONCE, additive + idempotent)
--  1) per-user chat settings on conversation_participants
--  2) shared disappearing-messages timer on conversations
--  3) chat_reports table (Report from chat settings)
--  4) RLS fixes: participants may update/delete messages in their
--     conversations (reactions, view-once viewed_by, disappearing
--     sweeps) — sender-only update was breaking those features.
-- ============================================================

-- ------------------------------------------------------------
-- 1) PER-USER CHAT SETTINGS (each participant sees THEIR OWN
--    view: mute / nickname / chat color / wallpaper / sounds)
-- ------------------------------------------------------------
alter table public.conversation_participants add column if not exists muted boolean not null default false;
alter table public.conversation_participants add column if not exists muted_until timestamptz;
alter table public.conversation_participants add column if not exists nickname text;
alter table public.conversation_participants add column if not exists chat_color text not null default 'orange';
alter table public.conversation_participants add column if not exists wallpaper text not null default 'glow';
alter table public.conversation_participants add column if not exists sound_enabled boolean not null default true;

-- ------------------------------------------------------------
-- 2) DISAPPEARING MESSAGES — chat-level timer (both sides share it)
--    null = off; 86400 / 604800 / 2592000 = 24h / 7d / 90d
-- ------------------------------------------------------------
alter table public.conversations add column if not exists disappear_seconds int;

-- ------------------------------------------------------------
-- 3) CHAT REPORTS (from the ⋮ chat settings sheet)
-- ------------------------------------------------------------
create table if not exists public.chat_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reported_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.chat_reports enable row level security;

drop policy if exists "chat_reports_insert" on public.chat_reports;
create policy "chat_reports_insert" on public.chat_reports
  for insert to authenticated with check (reporter_id = auth.uid());

drop policy if exists "chat_reports_select_own" on public.chat_reports;
create policy "chat_reports_select_own" on public.chat_reports
  for select to authenticated using (reporter_id = auth.uid());

-- ------------------------------------------------------------
-- 4) RLS FIXES
--    messages: participants of a conversation may update any
--    message inside it (reactions, view-once "Opened", soft
--    deletes) and delete expired ones (disappearing messages).
-- ------------------------------------------------------------
drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_member" on public.messages
  for update to authenticated
  using (conversation_id in (select public.my_conversation_ids()))
  with check (conversation_id in (select public.my_conversation_ids()));

drop policy if exists "messages_delete_member" on public.messages;
create policy "messages_delete_member" on public.messages
  for delete to authenticated
  using (conversation_id in (select public.my_conversation_ids()));

-- ------------------------------------------------------------
-- 5) BLOCK ALSO REMOVES THE OTHER SIDE'S CONVERSATION ACCESS —
--    when you block someone, drop both participant rows so the
--    chat disappears for both. (Existing blocks table is reused.)
-- ------------------------------------------------------------
create or replace function public.block_chat_user(p_other uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'not authenticated';
  end if;
  insert into public.blocks (blocker_id, blocked_id)
  values (v_me, p_other)
  on conflict do nothing;
  delete from public.conversation_participants
  where user_id = v_me
    and conversation_id in (
      select cp.conversation_id
      from public.conversation_participants cp
      where cp.user_id = p_other
    );
end $$;

revoke all on function public.block_chat_user(uuid) from public, anon;
grant execute on function public.block_chat_user(uuid) to authenticated;
