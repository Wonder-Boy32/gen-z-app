-- ============================================================
-- GEN Z  -  PROFILE VIEWS  ("who viewed my profile")
-- Powers the eye icon at the top of your own profile page.
-- Run this whole file once in the Supabase SQL editor.
-- Idempotent - safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) one row per (profile, viewer); repeat visits bump the counter
-- ------------------------------------------------------------
create table if not exists public.profile_views (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  view_count integer not null default 1,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  constraint profile_views_pkey primary key (profile_id, viewer_id),
  constraint profile_views_no_self check (profile_id <> viewer_id)
);

create index if not exists profile_views_recent_idx
  on public.profile_views (profile_id, last_viewed_at desc);

alter table public.profile_views enable row level security;

-- only the owner of the profile can read their own viewers.
-- NOTE: there is deliberately NO insert/update policy - the only
-- way a row is written is through record_profile_view() below,
-- so a client cannot forge or fake a view.
drop policy if exists "profile_views_select_own" on public.profile_views;
create policy "profile_views_select_own" on public.profile_views
  for select using (auth.uid() = profile_id);

-- lets you clear your own history
drop policy if exists "profile_views_delete_own" on public.profile_views;
create policy "profile_views_delete_own" on public.profile_views
  for delete using (auth.uid() = profile_id);

-- ------------------------------------------------------------
-- 2) write path - called by the app when someone opens a profile
-- ------------------------------------------------------------
create or replace function public.record_profile_view(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_viewer uuid := auth.uid();
begin
  -- anonymous, self-views and unknown profiles are all ignored
  if v_viewer is null or p_profile is null or v_viewer = p_profile then
    return;
  end if;

  if not exists (select 1 from public.profiles where id = p_profile) then
    return;
  end if;

  insert into public.profile_views (profile_id, viewer_id, view_count, first_viewed_at, last_viewed_at)
  values (p_profile, v_viewer, 1, now(), now())
  on conflict (profile_id, viewer_id) do update
     set view_count      = public.profile_views.view_count + 1,
         last_viewed_at  = now();
end;
$$;

revoke all on function public.record_profile_view(uuid) from public;
grant execute on function public.record_profile_view(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3) read path - the viewer list
--    Joins profiles INSIDE sql on purpose: profile_views has two
--    FKs to profiles (profile_id + viewer_id), so a PostgREST
--    embed like profiles(...) is ambiguous and returns zero rows.
-- ------------------------------------------------------------
create or replace function public.my_profile_viewers(p_limit integer default 100)
returns table (
  viewer_id uuid,
  username text,
  display_name text,
  avatar_url text,
  verified boolean,
  view_count integer,
  last_viewed_at timestamptz,
  first_viewed_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select pv.viewer_id,
         p.username,
         p.display_name,
         p.avatar_url,
         coalesce(p.verified, false),
         pv.view_count,
         pv.last_viewed_at,
         pv.first_viewed_at
    from public.profile_views pv
    join public.profiles p on p.id = pv.viewer_id
   where pv.profile_id = auth.uid()
   order by pv.last_viewed_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.my_profile_viewers(integer) from public;
grant execute on function public.my_profile_viewers(integer) to authenticated;

-- ------------------------------------------------------------
-- 4) read path - headline numbers + the unseen badge count.
--    Pass the timestamp you last opened the viewers screen;
--    'unseen' counts everyone newer than that (pass null to
--    count everyone).
-- ------------------------------------------------------------
create or replace function public.my_profile_view_stats(p_since timestamptz default null)
returns table (
  total_viewers integer,
  total_views integer,
  viewers_7d integer,
  unseen integer
)
language sql
security definer
set search_path = public
stable
as $$
  select (count(*))::int,
         (coalesce(sum(pv.view_count), 0))::int,
         (count(*) filter (where pv.last_viewed_at > now() - interval '7 days'))::int,
         (count(*) filter (where p_since is null or pv.last_viewed_at > p_since))::int
    from public.profile_views pv
   where pv.profile_id = auth.uid();
$$;

revoke all on function public.my_profile_view_stats(timestamptz) from public;
grant execute on function public.my_profile_view_stats(timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 5) verify (should return the columns above)
-- ------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_name = 'profile_views'
 order by ordinal_position;
