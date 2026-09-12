-- ============================================================
-- GEN Z - COMMENT DISLIKES (thumbs-down on comments)
-- Optional. The comments sheet renders the thumbs-down button
-- regardless; it only SAVES votes once this table exists.
-- Run this whole file once in the Supabase SQL editor.
-- ============================================================

create table if not exists public.comment_dislikes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);

create index if not exists comment_dislikes_comment_idx
  on public.comment_dislikes (comment_id);

alter table public.comment_dislikes enable row level security;

drop policy if exists "comment_dislikes_select" on public.comment_dislikes;
create policy "comment_dislikes_select" on public.comment_dislikes
  for select using (true);

drop policy if exists "comment_dislikes_insert" on public.comment_dislikes;
create policy "comment_dislikes_insert" on public.comment_dislikes
  for insert with check (auth.uid() = user_id);

drop policy if exists "comment_dislikes_delete" on public.comment_dislikes;
create policy "comment_dislikes_delete" on public.comment_dislikes
  for delete using (auth.uid() = user_id);

-- verify (should return one row)
select column_name, data_type
  from information_schema.columns
 where table_name = 'comment_dislikes'
 order by ordinal_position;
