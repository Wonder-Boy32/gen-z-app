-- ============================================================
-- Gen Z — Discover (RUN THIS after schema.sql)
-- Hashtag extraction: any #tag in a caption/content is
-- auto-indexed; trending tags are ranked by usage count.
-- ============================================================

create table if not exists public.hashtags (
  tag text primary key,
  count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.post_hashtags (
  post_id uuid not null references public.posts(id) on delete cascade,
  tag text not null,
  primary key (post_id, tag)
);

alter table public.hashtags enable row level security;
alter table public.post_hashtags enable row level security;

drop policy if exists "hashtags_select" on public.hashtags;
create policy "hashtags_select" on public.hashtags for select using (true);
drop policy if exists "post_hashtags_select" on public.post_hashtags;
create policy "post_hashtags_select" on public.post_hashtags for select using (true);

-- auto-extract #tags from caption/content
create or replace function public.sync_hashtags()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  delete from public.post_hashtags where post_id = new.id;
  for t in
    select lower(m[1])
    from regexp_matches(
      coalesce(new.caption, '') || ' ' || coalesce(new.content, ''),
      '#([a-zA-Z0-9_]+)', 'g'
    ) m
  loop
    insert into public.post_hashtags (post_id, tag) values (new.id, t) on conflict do nothing;
  end loop;
  update public.hashtags h
    set count = (select count(*) from public.post_hashtags ph where ph.tag = h.tag),
        updated_at = now()
    where h.tag in (select tag from public.post_hashtags where post_id = coalesce(new.id, old.id));
  return new;
end;
$$;

drop trigger if exists posts_sync_hashtags on public.posts;
create trigger posts_sync_hashtags
  after insert or update on public.posts
  for each row execute function public.sync_hashtags();

-- backfill existing posts
insert into public.post_hashtags (post_id, tag)
select p.id, lower(m[1])
from public.posts p,
     lateral regexp_matches(coalesce(p.caption, '') || ' ' || coalesce(p.content, ''), '#([a-zA-Z0-9_]+)', 'g') m
on conflict do nothing;

insert into public.hashtags (tag, count)
select ph.tag, count(*) from public.post_hashtags ph group by ph.tag
on conflict (tag) do update set count = excluded.count;

-- sanity: select tag, count from public.hashtags order by count desc limit 10;
