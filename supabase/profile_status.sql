-- ============================================================
-- Temporary mood / status
--
-- Depends on: schema.sql (profiles), expiry_v2.sql (the purge-cron pattern).
-- Hand-run like the other files in this folder; there is no migration runner.
--
-- WHY A SEPARATE TABLE rather than a column on profiles:
--   profiles has an owner-update policy (auth.uid() = id), so a new column there
--   would be writable by any client for its own row. That is fine for a mood, but
--   keeping it separate means the mood can never be confused with the two existing
--   and unrelated concepts:
--     profiles.activity_status  -> online presence (is the user here)
--     profiles.account_status   -> moderation state (active/restricted/suspended/banned)
--   A mood is neither. Do not merge them.
-- ============================================================

create table if not exists public.profile_status (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  emoji text not null,
  label text not null,
  created_at timestamptz not null default now(),
  -- defaults to 24h; the client may choose a shorter window but not a longer one
  expires_at timestamptz not null default (now() + interval '24 hours'),

  constraint profile_status_emoji_len check (char_length(emoji) between 1 and 8),
  constraint profile_status_label_len check (char_length(btrim(label)) between 1 and 40),
  -- The window is enforced HERE, not in the app: a crafted client that posts an
  -- expires_at directly still cannot park a status for months. 48h keeps a mood
  -- consistent with the app's existing 48h content DNA.
  constraint profile_status_window check (
    expires_at > created_at
    and expires_at <= created_at + interval '48 hours'
  )
);

create index if not exists profile_status_expires_idx on public.profile_status (expires_at);


-- ------------------------------------------------------------
-- STAMP — created_at is server-controlled and expires_at is clamped.
-- The window above is measured from created_at, so if a client could choose
-- created_at it could post a FUTURE value and park a mood indefinitely while
-- still satisfying the check. The trigger overwrites both rather than trusting
-- either, which makes the constraint a backstop instead of the only defence.
-- ------------------------------------------------------------
create or replace function public.profile_status_stamp()
returns trigger language plpgsql as $$
begin
  new.created_at := now();
  -- clamp into (now, now + 48h]. Absent, already-past, or over-long all become 24h.
  if new.expires_at is null
     or new.expires_at > new.created_at + interval '48 hours'
     or new.expires_at <= new.created_at then
    new.expires_at := new.created_at + interval '24 hours';
  end if;
  return new;
end $$;

drop trigger if exists profile_status_stamp_trg on public.profile_status;
create trigger profile_status_stamp_trg
before insert or update on public.profile_status
for each row execute function public.profile_status_stamp();


alter table public.profile_status enable row level security;

-- A mood is meant to be seen, so any signed-in user may read it (same exposure as
-- the profile itself). Writing is strictly owner-only, and because every write
-- policy compares against auth.uid(), a client with no session matches nothing.
drop policy if exists "profile_status_select" on public.profile_status;
create policy "profile_status_select" on public.profile_status
for select using (true);

drop policy if exists "profile_status_insert" on public.profile_status;
create policy "profile_status_insert" on public.profile_status
for insert with check (auth.uid() = user_id);

drop policy if exists "profile_status_update" on public.profile_status;
create policy "profile_status_update" on public.profile_status
for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "profile_status_delete" on public.profile_status;
create policy "profile_status_delete" on public.profile_status
for delete using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- LIVE VIEW — the only thing the app should ever read.
-- Expiry is filtered in SQL, so an expired mood cannot render even in the window
-- before the purge removes the row. Reading this instead of the table means no
-- screen has to remember to check expires_at.
-- ------------------------------------------------------------
create or replace view public.profile_status_live as
  select user_id, emoji, label, created_at, expires_at
  from public.profile_status
  where expires_at > now();

grant select on public.profile_status_live to authenticated;


-- ------------------------------------------------------------
-- CLEAR — "remove my mood" without deleting the row client-side.
-- Not strictly required (the delete policy already allows it) but it keeps the
-- client free of table names and gives one obvious call site.
-- ------------------------------------------------------------
create or replace function public.clear_my_status()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'sign in required');
  end if;
  delete from public.profile_status where user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.clear_my_status() to authenticated;


-- ------------------------------------------------------------
-- PURGE — expired rows are already invisible thanks to the view, so this is
-- housekeeping rather than correctness. Follows the same pattern as
-- genz_purge_expired() in expiry_v2.sql.
-- ------------------------------------------------------------
create or replace function public.purge_expired_status()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_removed integer;
begin
  delete from public.profile_status where expires_at <= now();
  get diagnostics v_removed = row_count;
  return v_removed;
end $$;

revoke all on function public.purge_expired_status() from public, anon, authenticated;


-- ------------------------------------------------------------
-- SCHEDULE the purge, mirroring how expiry_v2.sql schedules its own cleanup.
-- Safe to re-run: the job is unscheduled first.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('purge-expired-status')
      where exists (select 1 from cron.job where jobname = 'purge-expired-status');
    perform cron.schedule('purge-expired-status', '*/15 * * * *', 'select public.purge_expired_status()');
  end if;
end $$;


-- ============================================================
-- VERIFY — run these after applying.
-- ============================================================
-- 1) Table + policies exist (expect 4 policies):
--    select policyname, cmd from pg_policies where tablename = 'profile_status' order by cmd;
--
-- 2) The window guard actually bites. This SHOULD FAIL with a check violation:
--    set local role authenticated;
--    insert into public.profile_status (user_id, emoji, label, expires_at)
--    values (auth.uid(), '🔥', 'too long', now() + interval '30 days');
--
-- 3) Expiry hides rows (expect the second count to be lower once something expires):
--    select count(*) from public.profile_status;
--    select count(*) from public.profile_status_live;
--
-- 4) Purge works:
--    select public.purge_expired_status();
