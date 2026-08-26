-- ============================================================
-- GEN Z — ADVANCED GENERAL FEED (run AFTER drop_creator.sql)
-- Drop chains, personalization, watch signals.
-- THE 48-HOUR SYSTEM IS UNTOUCHED: one posts row per Drop,
-- expires_at = created_at + 48h, immutable, RLS-gated.
-- ============================================================

-- ---- 1) Drop chains: a response Drop references its parent ----
alter table public.posts add column if not exists parent_drop_id uuid
  references public.posts (id) on delete cascade;
create index if not exists posts_parent_idx on public.posts (parent_drop_id)
  where parent_drop_id is not null;

-- ---- 2) Hidden drops (Not interested / Hide this Drop) ----
create table if not exists public.hidden_posts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.hidden_posts enable row level security;
drop policy if exists hidden_posts_owner on public.hidden_posts;
create policy hidden_posts_owner on public.hidden_posts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- 3) Muted creators ----
create table if not exists public.muted_users (
  user_id uuid not null references public.profiles (id) on delete cascade,
  muted_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id)
);
alter table public.muted_users enable row level security;
drop policy if exists muted_users_owner on public.muted_users;
create policy muted_users_owner on public.muted_users
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- 4) Real watch signals (reported by the feed player) ----
alter table public.post_views add column if not exists watch_ms integer not null default 0;
alter table public.post_views add column if not exists completed boolean not null default false;
alter table public.post_views add column if not exists rewatched boolean not null default false;

-- ---- 5) Not-interested tags (feeds the ranking dampener) ----
create table if not exists public.not_interested_tags (
  user_id uuid not null references public.profiles (id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, tag)
);
alter table public.not_interested_tags enable row level security;
drop policy if exists not_interested_owner on public.not_interested_tags;
create policy not_interested_owner on public.not_interested_tags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- 6) Privacy-safe velocity counters ----
-- The app needs GLOBAL counts (views/likes/comments in a time window) for
-- Drop Pulse + Rising + ranking, but viewer/engager identities must stay
-- private. These views expose ONLY post_id + timestamp (no identity) and
-- run as the view owner (security_definer) so RLS doesn't zero them.
create or replace view public.post_view_counts as
  select post_id, viewed_at from public.post_views;
create or replace view public.like_counts as
  select post_id, created_at from public.likes;
create or replace view public.comment_counts as
  select post_id, created_at from public.comments;

-- allow the feed player to report watch time on the row it inserted
drop policy if exists post_views_owner_update on public.post_views;
create policy post_views_owner_update on public.post_views
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- 7) Region pulse (privacy-safe): broad user-set region only, no
-- coordinates, never auto-located. Optional field set in Edit Profile.
alter table public.profiles add column if not exists region text;

-- ---- 8) Video drop cover image (user-picked or auto-extracted frame)
alter table public.posts add column if not exists cover_url text;

-- ---- 9) Text drop design (creator-chosen background + readable text color)
alter table public.posts add column if not exists text_bg text;
alter table public.posts add column if not exists text_color text;
