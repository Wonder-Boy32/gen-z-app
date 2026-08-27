-- ============================================================
-- GEN Z — ANONYMOUS MESSAGES + CHAT SCHEMA UPGRADE
-- Run this whole file in the Supabase SQL editor.
-- It is additive: creates new tables/policies, ALTERs messages.
-- It does NOT touch existing chat policies or the 48-hour Drop system.
-- ============================================================

-- ------------------------------------------------------------
-- 1) MESSAGES UPGRADE — message types, read receipts, replies, pins
-- ------------------------------------------------------------
-- NOTE: messages already uses msg_type / reply_to / deleted_at from earlier
-- migrations — only the new status columns are added here.
alter table public.messages
  add column if not exists read_at timestamptz,
  add column if not exists pinned boolean not null default false,
  add column if not exists drop_id uuid;

create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_read_idx on public.messages (read_at);

-- ------------------------------------------------------------
-- 2) ANONYMOUS MESSAGES
--    sender_id is INTERNAL (accountability / abuse prevention).
--    Recipients can NEVER read it — they query the public view below,
--    and direct table access is revoked from app roles.
-- ------------------------------------------------------------
create table if not exists public.anonymous_messages (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  content text check (char_length(content) <= 500),
  media_url text,
  voice_url text,
  message_type text not null default 'text'
    check (message_type in ('text', 'photo', 'voice', 'drop')),
  reaction text,
  expires_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists anon_msgs_recipient_idx on public.anonymous_messages (recipient_id, created_at desc);
create index if not exists anon_msgs_sender_idx on public.anonymous_messages (sender_id, created_at desc);
create index if not exists anon_msgs_expires_idx on public.anonymous_messages (expires_at);

-- Public (recipient-facing) view — sender_id and identity are ABSENT.
-- security_invoker = the CALLER's RLS (base table) applies to view rows.
-- NOTE: policies live on the BASE TABLE only (Postgres forbids policies on views).
create or replace view public.anonymous_messages_public
  with (security_invoker = true) as
  select id, recipient_id, content, media_url, voice_url, message_type,
         reaction, expires_at, read_at, created_at
  from public.anonymous_messages;

-- --- Base-table RLS (applies automatically through the invoker view) ---
alter table public.anonymous_messages enable row level security;

drop policy if exists "anon_msgs_select_own" on public.anonymous_messages;
create policy "anon_msgs_select_own" on public.anonymous_messages
  for select using (recipient_id = auth.uid());

drop policy if exists "anon_msgs_update_own" on public.anonymous_messages;
create policy "anon_msgs_update_own" on public.anonymous_messages
  for update using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

drop policy if exists "anon_msgs_delete_own" on public.anonymous_messages;
create policy "anon_msgs_delete_own" on public.anonymous_messages
  for delete using (recipient_id = auth.uid());

-- --- Grants: recipient can read/update/delete their rows, but the
--     sender_id COLUMN is never granted (column-level privilege) ---
revoke select, insert, update, delete on public.anonymous_messages from anon, authenticated;
grant select (id, recipient_id, content, media_url, voice_url, message_type,
              reaction, expires_at, read_at, created_at)
  on public.anonymous_messages to anon, authenticated;
grant update (reaction, read_at) on public.anonymous_messages to anon, authenticated;
grant delete on public.anonymous_messages to anon, authenticated;

-- View grants (callers query the view; inserts only via the RPC below)
grant select, update, delete on public.anonymous_messages_public to anon, authenticated;

-- ------------------------------------------------------------
-- 3) ANONYMOUS SETTINGS — recipient controls
-- ------------------------------------------------------------
create table if not exists public.anonymous_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  enabled boolean not null default true,
  who text not null default 'everyone'
    check (who in ('everyone', 'followers', 'link', 'nobody')),
  allow_text boolean not null default true,
  allow_photos boolean not null default true,
  allow_voice boolean not null default true,
  allow_drops boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.anonymous_settings enable row level security;

drop policy if exists "anon_settings_select_own" on public.anonymous_settings;
create policy "anon_settings_select_own" on public.anonymous_settings
  for select using (user_id = auth.uid());

drop policy if exists "anon_settings_insert_own" on public.anonymous_settings;
create policy "anon_settings_insert_own" on public.anonymous_settings
  for insert with check (user_id = auth.uid());

drop policy if exists "anon_settings_update_own" on public.anonymous_settings;
create policy "anon_settings_update_own" on public.anonymous_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4) ANONYMOUS REPORTS — recipient reports, stored with moderation metadata
-- ------------------------------------------------------------
create table if not exists public.anonymous_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.anonymous_messages (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists anon_reports_msg_idx on public.anonymous_reports (message_id);
create index if not exists anon_reports_reporter_idx on public.anonymous_reports (reporter_id);

alter table public.anonymous_reports enable row level security;

drop policy if exists "anon_reports_insert" on public.anonymous_reports;
create policy "anon_reports_insert" on public.anonymous_reports
  for insert with check (
    reporter_id = auth.uid()
    and exists (
      select 1 from public.anonymous_messages m
      where m.id = message_id and m.recipient_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 5) ANONYMOUS BLOCKS — recipient blocks the underlying sender (internal)
-- ------------------------------------------------------------
create table if not exists public.anonymous_blocks (
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (recipient_id, sender_id)
);

alter table public.anonymous_blocks enable row level security;

drop policy if exists "anon_blocks_select_own" on public.anonymous_blocks;
create policy "anon_blocks_select_own" on public.anonymous_blocks
  for select using (recipient_id = auth.uid());

drop policy if exists "anon_blocks_insert_own" on public.anonymous_blocks;
create policy "anon_blocks_insert_own" on public.anonymous_blocks
  for insert with check (recipient_id = auth.uid() and sender_id is not null);

drop policy if exists "anon_blocks_delete_own" on public.anonymous_blocks;
create policy "anon_blocks_delete_own" on public.anonymous_blocks
  for delete using (recipient_id = auth.uid());

-- ------------------------------------------------------------
-- 6) BACKEND ENFORCEMENT — permissions + anti-spam trigger
--    The trigger is the FINAL authority: it checks the recipient's
--    settings and blocks before any anonymous message is stored.
-- ------------------------------------------------------------
create or replace function public.anon_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s record;
begin
  -- recipient must exist and have a profile
  if new.recipient_id is null then
    raise exception 'recipient_required';
  end if;

  -- fetch recipient's anonymous settings (defaults if unset)
  select enabled, who, allow_text, allow_photos, allow_voice, allow_drops
    into s
    from public.anonymous_settings
    where user_id = new.recipient_id;
  if not found then
    s.enabled := true; s.who := 'everyone';
    s.allow_text := true; s.allow_photos := true;
    s.allow_voice := true; s.allow_drops := false;
  end if;

  -- global on/off
  if not s.enabled then
    raise exception 'anon_disabled';
  end if;

  -- "who can send" (server-enforced)
  if s.who = 'nobody' then
    raise exception 'anon_who_nobody';
  end if;
  if s.who = 'followers' and (
    new.sender_id is null
    or not exists (
      select 1 from public.follows f
      where f.follower_id = new.sender_id
        and f.following_id = new.recipient_id
        and f.status = 'accepted'
    )
  ) then
    raise exception 'anon_who_followers';
  end if;
  if s.who = 'link' and new.sender_id is not null and not exists (
    select 1 from public.follows f
    where f.follower_id = new.sender_id
      and f.following_id = new.recipient_id
      and f.status = 'accepted'
  ) then
    raise exception 'anon_who_link';
  end if;

  -- content-type controls
  if new.media_url is not null and not s.allow_photos then
    raise exception 'anon_no_photos';
  end if;
  if new.voice_url is not null and not s.allow_voice then
    raise exception 'anon_no_voice';
  end if;
  if new.message_type = 'drop' and not s.allow_drops then
    raise exception 'anon_no_drops';
  end if;

  -- blocks (only applies to identified senders)
  if new.sender_id is not null and exists (
    select 1 from public.anonymous_blocks b
    where b.recipient_id = new.recipient_id and b.sender_id = new.sender_id
  ) then
    raise exception 'anon_blocked';
  end if;

  -- anti-spam: sender flooding (30 msgs / hour per sender)
  if new.sender_id is not null and (
    select count(*) from public.anonymous_messages m
    where m.sender_id = new.sender_id
      and m.created_at > now() - interval '1 hour'
  ) >= 30 then
    raise exception 'anon_rate_sender';
  end if;

  -- anti-spam: recipient flooding (20 msgs / hour per recipient)
  if (
    select count(*) from public.anonymous_messages m
    where m.recipient_id = new.recipient_id
      and m.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'anon_rate_recipient';
  end if;

  return new;
end $$;

drop trigger if exists trg_anon_guard on public.anonymous_messages;
create trigger trg_anon_guard
  before insert on public.anonymous_messages
  for each row execute function public.anon_guard();

-- ------------------------------------------------------------
-- 7) SEND + BLOCK RPCs — sender identity resolved SERVER-SIDE only
--    (clients can never choose or read sender_id)
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
  -- anonymous (no session) OR identified — resolved here, never by the client
  if auth.uid() is not null then
    v_sender := auth.uid();
  end if;

  insert into public.anonymous_messages
    (recipient_id, sender_id, content, media_url, voice_url, message_type, expires_at)
  values
    (p_recipient, v_sender, p_content, p_media, p_voice, p_type,
     case when p_expires is not null then now() + p_expires else null end)
  returning id into v_id;

  return v_id;
end $$;

grant execute on function public.send_anonymous_message(uuid, text, text, text, text, interval)
  to anon, authenticated;

-- Block the sender of a specific message (recipient-facing; resolves internally)
create or replace function public.anon_block_message(p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_sender uuid;
begin
  select sender_id into v_sender
    from public.anonymous_messages
    where id = p_message_id and recipient_id = auth.uid();

  if v_sender is null then
    -- anonymous sender: nothing per-sender to block; delete the message instead
    delete from public.anonymous_messages where id = p_message_id and recipient_id = auth.uid();
    return;
  end if;

  insert into public.anonymous_blocks (recipient_id, sender_id)
  values (auth.uid(), v_sender)
  on conflict (recipient_id, sender_id) do nothing;
end $$;

grant execute on function public.anon_block_message(uuid) to authenticated;

-- Report a message (recipient-facing; resolves reporter server-side)
create or replace function public.anon_report_message(p_message_id uuid, p_reason text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.anonymous_reports (message_id, reporter_id, reason, note)
  select id, auth.uid(), p_reason, p_note
    from public.anonymous_messages
    where id = p_message_id and recipient_id = auth.uid();
end $$;

grant execute on function public.anon_report_message(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 8) INDEXES for the shared-chat query patterns
-- ------------------------------------------------------------
create index if not exists posts_expires_idx on public.posts (expires_at);
