-- ============================================================
-- Gen Z — Supabase schema (v1)
-- Run this in the Supabase SQL editor (or `supabase db push`).
-- Idempotent: safe to run more than once.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- PROFILES — one row per auth user, auto-created on signup
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique not null,
  display_name text,
  avatar_url text,
  streak_count integer not null default 0,
  last_streak_date date,
  created_at timestamptz not null default now()
);

-- Auto-create a profile when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(coalesce(split_part(new.email, '@', 1), 'user')) || '-' || substr(gen_random_uuid()::text, 1, 6),
    coalesce(split_part(new.email, '@', 1), 'user')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- POSTS — every story. expires_at = created_at + 48h
-- ------------------------------------------------------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('video', 'image')),
  caption text,
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  expires_at timestamptz not null default (now() + interval '48 hours'),
  created_at timestamptz not null default now()
);

create index if not exists posts_expires_at_idx on public.posts (expires_at);
create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists posts_user_id_idx on public.posts (user_id);

-- ------------------------------------------------------------
-- LIKES
-- ------------------------------------------------------------
create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create index if not exists likes_post_id_idx on public.likes (post_id);

-- keep posts.likes_count in sync
create or replace function public.bump_post_likes()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set likes_count = likes_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists likes_bump on public.likes;
create trigger likes_bump
  after insert or delete on public.likes
  for each row execute function public.bump_post_likes();

-- ------------------------------------------------------------
-- COMMENTS (with replies via parent_id)
-- ------------------------------------------------------------
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  parent_id uuid references public.comments (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_post_id_idx on public.comments (post_id);

create or replace function public.bump_post_comments()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comments_count = comments_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set comments_count = greatest(comments_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists comments_bump on public.comments;
create trigger comments_bump
  after insert or delete on public.comments
  for each row execute function public.bump_post_comments();

-- ------------------------------------------------------------
-- FOLLOWS
-- ------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

-- ------------------------------------------------------------
-- CHAT — conversations, participants, messages
-- ------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  content text,
  media_url text,
  reaction text,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

-- ------------------------------------------------------------
-- POST VIEWS — "who watched my story"
-- ------------------------------------------------------------
create table if not exists public.post_views (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  unique (post_id, user_id)
);

-- ------------------------------------------------------------
-- MODERATION — reports + blocks
-- ------------------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now()
);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.follows enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.post_views enable row level security;
alter table public.reports enable row level security;
alter table public.blocks enable row level security;

-- profiles: everyone can read; only owner edits
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select using (true);
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);
drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);

-- posts: only ACTIVE (unexpired) posts are visible; owner writes/deletes
drop policy if exists "posts_select_active" on public.posts;
create policy "posts_select_active" on public.posts for select using (expires_at > now());
drop policy if exists "posts_insert" on public.posts;
create policy "posts_insert" on public.posts for insert with check (auth.uid() = user_id);
drop policy if exists "posts_update" on public.posts;
create policy "posts_update" on public.posts for update using (auth.uid() = user_id);
drop policy if exists "posts_delete" on public.posts;
create policy "posts_delete" on public.posts for delete using (auth.uid() = user_id);

-- likes
drop policy if exists "likes_select" on public.likes;
create policy "likes_select" on public.likes for select using (true);
drop policy if exists "likes_insert" on public.likes;
create policy "likes_insert" on public.likes for insert with check (auth.uid() = user_id);
drop policy if exists "likes_delete" on public.likes;
create policy "likes_delete" on public.likes for delete using (auth.uid() = user_id);

-- comments
drop policy if exists "comments_select" on public.comments;
create policy "comments_select" on public.comments for select using (true);
drop policy if exists "comments_insert" on public.comments;
create policy "comments_insert" on public.comments for insert with check (auth.uid() = user_id);
drop policy if exists "comments_delete" on public.comments;
create policy "comments_delete" on public.comments for delete using (auth.uid() = user_id);

-- follows
drop policy if exists "follows_select" on public.follows;
create policy "follows_select" on public.follows for select using (true);
drop policy if exists "follows_insert" on public.follows;
create policy "follows_insert" on public.follows for insert with check (auth.uid() = follower_id);
drop policy if exists "follows_delete" on public.follows;
create policy "follows_delete" on public.follows for delete using (auth.uid() = follower_id);

-- conversations: only participants
drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations for select
  using (exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = id and cp.user_id = auth.uid()
  ));
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations for insert
  with check (exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = id and cp.user_id = auth.uid()
  ));

drop policy if exists "participants_select" on public.conversation_participants;
create policy "participants_select" on public.conversation_participants for select
  using (user_id = auth.uid() or exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_id and cp.user_id = auth.uid()
  ));
drop policy if exists "participants_insert" on public.conversation_participants;
create policy "participants_insert" on public.conversation_participants for insert
  with check (user_id = auth.uid());

-- messages: participants can read; sender writes
drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages for select
  using (exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_id and cp.user_id = auth.uid()
  ));
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert
  with check (sender_id = auth.uid() and exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_id and cp.user_id = auth.uid()
  ));

-- post views: record your own view; view counts are public
drop policy if exists "post_views_select" on public.post_views;
create policy "post_views_select" on public.post_views for select using (true);
drop policy if exists "post_views_insert" on public.post_views;
create policy "post_views_insert" on public.post_views for insert with check (auth.uid() = user_id);

-- reports: anyone can report; only service role (admin) reads/acts
drop policy if exists "reports_insert" on public.reports;
create policy "reports_insert" on public.reports for insert with check (auth.uid() = reporter_id);

-- blocks
drop policy if exists "blocks_select" on public.blocks;
create policy "blocks_select" on public.blocks for select using (true);
drop policy if exists "blocks_insert" on public.blocks;
create policy "blocks_insert" on public.blocks for insert with check (auth.uid() = blocker_id);
drop policy if exists "blocks_delete" on public.blocks;
create policy "blocks_delete" on public.blocks for delete using (auth.uid() = blocker_id);

-- ============================================================
-- STORAGE — public "media" bucket for story videos/images
-- ============================================================
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

drop policy if exists "media_upload" on storage.objects;
create policy "media_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and owner = auth.uid());

drop policy if exists "media_read" on storage.objects;
create policy "media_read" on storage.objects
  for select to public
  using (bucket_id = 'media');

drop policy if exists "media_delete" on storage.objects;
create policy "media_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and owner = auth.uid());

-- ============================================================
-- REALTIME — live feed + chat updates
-- ============================================================
alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.likes;
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.messages;
