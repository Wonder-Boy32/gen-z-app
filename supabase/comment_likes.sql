-- ============================================================
-- GEN Z — COMMENT LIKES + COMMENT-LIKE NOTIFICATIONS
-- Run this whole file once in the Supabase SQL editor.
-- ============================================================

-- 1) comment likes (one like per user per comment)
create table if not exists public.comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);

create index if not exists comment_likes_comment_idx
  on public.comment_likes (comment_id);

alter table public.comment_likes enable row level security;

drop policy if exists "comment_likes_select" on public.comment_likes;
create policy "comment_likes_select" on public.comment_likes
  for select using (true);

drop policy if exists "comment_likes_insert" on public.comment_likes;
create policy "comment_likes_insert" on public.comment_likes
  for insert with check (auth.uid() = user_id);

drop policy if exists "comment_likes_delete" on public.comment_likes;
create policy "comment_likes_delete" on public.comment_likes
  for delete using (auth.uid() = user_id);

-- 2) extend the notifications type list with 'comment_like'
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('follow', 'like', 'comment', 'reply', 'reaction', 'repost', 'comment_like'));
