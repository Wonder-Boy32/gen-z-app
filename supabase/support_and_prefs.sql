-- ============================================================
-- GEN Z - SUPPORT REPORTS + REAL NOTIFICATION PREFERENCES
-- Run this whole file once in the Supabase SQL editor.
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1) SUPPORT REPORTS
-- Backs the in-app "Report a problem" form. The same report is
-- also emailed, this table is the in-app record of it.
-- ------------------------------------------------------------
create table if not exists public.support_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  category text not null default 'other',
  message text not null,
  contact_email text,
  username text,
  device text,
  app_version text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create index if not exists support_reports_created_idx
  on public.support_reports (created_at desc);

alter table public.support_reports enable row level security;

drop policy if exists "support_reports_insert" on public.support_reports;
create policy "support_reports_insert" on public.support_reports
  for insert with check (auth.uid() = user_id);

drop policy if exists "support_reports_select" on public.support_reports;
create policy "support_reports_select" on public.support_reports
  for select using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 2) NOTIFICATION PREFERENCES, ENFORCED
-- notify.ts writes notifications client-side, and RLS stops a
-- client from reading someone else's settings - so the check has
-- to happen in the database. This BEFORE INSERT trigger drops a
-- notification when the recipient has switched that kind off.
-- No settings row yet = everything allowed (matches the app
-- defaults of "all on").
-- ------------------------------------------------------------
create or replace function public.enforce_notification_prefs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prefs public.settings%rowtype;
  allowed boolean := true;
begin
  select * into prefs from public.settings where user_id = new.user_id;
  if not found then
    return new;
  end if;

  if new.type = 'follow' then
    allowed := prefs.notif_followers;
  elsif new.type in ('like', 'reaction', 'repost') then
    allowed := prefs.notif_likes;
  elsif new.type in ('comment', 'reply', 'comment_like') then
    allowed := prefs.notif_comments;
  elsif new.type in ('anon_message', 'call') then
    allowed := prefs.notif_messages;
  else
    allowed := true;
  end if;

  if allowed then
    return new;
  end if;

  -- switched off: silently drop it
  return null;
end;
$$;

drop trigger if exists notifications_prefs_guard on public.notifications;
create trigger notifications_prefs_guard
  before insert on public.notifications
  for each row execute function public.enforce_notification_prefs();

-- ------------------------------------------------------------
-- 3) VERIFY (should return two rows)
-- ------------------------------------------------------------
select table_name, column_name, data_type
  from information_schema.columns
 where table_name = 'support_reports'
   and column_name in ('category', 'message', 'contact_email')
 order by column_name;
