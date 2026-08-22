-- ============================================================
-- Gen Z — Drops engine (RUN THIS after schema.sql)
-- Lifecycle: scheduled -> live (30 min posting) -> voting (likes)
--            -> closed. Status flips handled by pg_cron (1 min).
-- Seeds one LIVE drop right now so you can test immediately,
-- and one scheduled drop for tomorrow.
-- ============================================================

create table if not exists public.drops (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Gen Z Drop',
  prompt text not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'live', 'voting', 'closed')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  voting_ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (voting_ends_at > ends_at)
);

-- link posts to a drop (a post can also be a plain feed post)
alter table public.posts add column if not exists drop_id uuid references public.drops(id) on delete set null;

create index if not exists posts_drop_id_idx on public.posts (drop_id);
create index if not exists drops_status_idx on public.drops (status);
create index if not exists posts_expires_idx on public.posts (expires_at);

alter table public.drops enable row level security;

drop policy if exists "drops_select" on public.drops;
create policy "drops_select" on public.drops
  for select using (true);

-- status engine: every minute, flip drops through their lifecycle
select cron.schedule('genz-drop-status', '* * * * *', $$
  update public.drops set status = 'live' where status = 'scheduled' and starts_at <= now();
  update public.drops set status = 'voting' where status = 'live' and ends_at <= now();
  update public.drops set status = 'closed' where status = 'voting' and voting_ends_at <= now();
$$);

-- SEED 1: a live drop, open for the next 30 minutes (voting for 24h after)
insert into public.drops (prompt, status, starts_at, ends_at, voting_ends_at)
select
  'Show us your current view',
  'live',
  now() - interval '1 minute',
  now() + interval '30 minutes',
  now() + interval '25 hours'
where not exists (select 1 from public.drops where status in ('live', 'voting'));

-- SEED 2: scheduled for tomorrow 8pm local (19:00 UTC)
insert into public.drops (prompt, status, starts_at, ends_at, voting_ends_at)
select
  'Something you would never tell your parents',
  'scheduled',
  date_trunc('day', now()) + interval '1 day 19 hours',
  date_trunc('day', now()) + interval '1 day 19 hours 30 minutes',
  date_trunc('day', now()) + interval '2 days 19 hours'
where not exists (
  select 1 from public.drops
  where status = 'scheduled' and starts_at > now()
);

-- sanity check: select id, prompt, status from public.drops;
