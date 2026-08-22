-- ============================================================
-- Gen Z — Feed 2.0 schema (RUN THIS after schema.sql + drops.sql)
-- Adds: carousel/text posts, audio field, view counters,
-- saved posts, and drop reactions.
-- ============================================================

-- posts: media becomes optional (text posts), add carousel/audio
alter table public.posts alter column media_url drop not null;
alter table public.posts alter column media_type drop not null;
alter table public.posts add column if not exists content text;
alter table public.posts add column if not exists media_items jsonb;
alter table public.posts add column if not exists audio text;
alter table public.posts add column if not exists views_count integer not null default 0;

-- saved posts (bookmarks)
create table if not exists public.saved_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- drop reactions (emoji reactions, one per user per post)
create table if not exists public.post_reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- RLS
alter table public.saved_posts enable row level security;
alter table public.post_reactions enable row level security;

drop policy if exists "saved_select" on public.saved_posts;
create policy "saved_select" on public.saved_posts for select using (auth.uid() = user_id);
drop policy if exists "saved_insert" on public.saved_posts;
create policy "saved_insert" on public.saved_posts for insert with check (auth.uid() = user_id);
drop policy if exists "saved_delete" on public.saved_posts;
create policy "saved_delete" on public.saved_posts for delete using (auth.uid() = user_id);

drop policy if exists "reactions_select" on public.post_reactions;
create policy "reactions_select" on public.post_reactions for select using (true);
drop policy if exists "reactions_insert" on public.post_reactions;
create policy "reactions_insert" on public.post_reactions for insert with check (auth.uid() = user_id);
drop policy if exists "reactions_delete" on public.post_reactions;
create policy "reactions_delete" on public.post_reactions for delete using (auth.uid() = user_id);

-- view counter (bumped by the app's post_views inserts)
create or replace function public.bump_views()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.posts set views_count = views_count + 1 where id = new.post_id;
  return new;
end;
$$;
drop trigger if exists post_views_bump on public.post_views;
create trigger post_views_bump
  after insert on public.post_views
  for each row execute function public.bump_views();

-- sanity: select id, content is not null as is_text, views_count from public.posts limit 5;
