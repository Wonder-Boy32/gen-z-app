-- ============================================================
-- GEN Z — Sound favourites
-- ============================================================
-- Additive. Idempotent. Safe to re-run.
--
-- WHY THIS TABLE STORES COPIES OF name/artist/artwork/url
-- The sounds come from Apple's public chart feed, an external service that can
-- rate-limit, change shape, or be briefly unreachable. If a favourite stored
-- only the track id, the Favourites tab would render blank rows whenever that
-- call failed. So display fields are denormalised at favourite time: each row
-- is self-sufficient and renders even with no network.
--
-- `sound_id` is TEXT, not uuid: it holds an Apple track id (a numeric string)
-- or a preset name namespaced as 'preset:<name>'.
-- ============================================================

create table if not exists public.sound_favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  sound_id text not null,
  name text not null,
  artist text,
  artwork text,
  url text,
  created_at timestamptz not null default now(),
  primary key (user_id, sound_id)
);

create index if not exists sound_favorites_user_idx
  on public.sound_favorites (user_id, created_at desc);

alter table public.sound_favorites enable row level security;

-- A user can only ever see and change their own favourites.
drop policy if exists "sound_favorites_select" on public.sound_favorites;
create policy "sound_favorites_select" on public.sound_favorites
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "sound_favorites_insert" on public.sound_favorites;
create policy "sound_favorites_insert" on public.sound_favorites
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "sound_favorites_delete" on public.sound_favorites;
create policy "sound_favorites_delete" on public.sound_favorites
  for delete to authenticated
  using (user_id = auth.uid());

-- No UPDATE policy on purpose: a favourite is a row you add or remove, never
-- edit. Withholding UPDATE means a bug in the client cannot rewrite someone's
-- saved sound metadata.

-- ------------------------------------------------------------
-- Verification — expect table_present=1, policy_count=3
-- ------------------------------------------------------------
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'sound_favorites') as table_present,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename = 'sound_favorites') as policy_count;
