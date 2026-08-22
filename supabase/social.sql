-- ============================================================
-- Gen Z — Social graph (RUN THIS)
-- Private accounts (follow requests) + privacy-aware feed RLS.
-- ============================================================

alter table public.profiles add column if not exists is_private boolean not null default false;
alter table public.follows add column if not exists status text not null default 'accepted'
  check (status in ('pending', 'accepted'));

-- Privacy-aware feed: everyone sees public accounts' active posts;
-- private accounts are only visible to themselves + accepted followers.
drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts
  for select using (
    expires_at > now()
    and (
      user_id = auth.uid()
      or not exists (
        select 1 from public.profiles pr
        where pr.id = posts.user_id and pr.is_private
      )
      or exists (
        select 1 from public.follows f
        where f.following_id = posts.user_id
          and f.follower_id = auth.uid()
          and f.status = 'accepted'
      )
    )
  );

-- sanity: select id, username, is_private from public.profiles limit 5;
