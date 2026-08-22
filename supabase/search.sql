-- ============================================================
-- Gen Z — Search (RUN THIS)
-- Per-user search history + a trending-searches RPC.
-- ============================================================

create table if not exists public.search_history (
  user_id uuid not null references public.profiles(id) on delete cascade,
  query text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, query)
);

alter table public.search_history enable row level security;

drop policy if exists "history_select" on public.search_history;
create policy "history_select" on public.search_history
  for select using (auth.uid() = user_id);
drop policy if exists "history_insert" on public.search_history;
create policy "history_insert" on public.search_history
  for insert with check (auth.uid() = user_id);
drop policy if exists "history_delete" on public.search_history;
create policy "history_delete" on public.search_history
  for delete using (auth.uid() = user_id);

-- trending searches across all users (security definer = reads all rows)
create or replace function public.get_trending_searches(limit_n int)
returns table (query text, searches bigint)
language sql
security definer set search_path = public
as $$
  select query, count(*) as searches
  from public.search_history
  group by query
  order by searches desc, max(created_at) desc
  limit limit_n;
$$;

-- sanity: select * from public.get_trending_searches(5);
