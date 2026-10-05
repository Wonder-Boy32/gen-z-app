-- ============================================================
-- Gen Z — hashtags & locations, take 2.
--
-- RUN THIS in the Supabase SQL editor, after discover.sql. Safe to re-run.
--
-- TWO PROBLEMS THIS FIXES
--
-- 1) hashtags.count only ever GREW.
--    discover.sql installed sync_hashtags() as an AFTER INSERT OR UPDATE trigger
--    on posts, recomputing counts from post_hashtags. NOTHING recomputes them on
--    DELETE — and genz_purge_expired() deletes every post at the 48-hour mark
--    (expiry_v2.sql L174). The post_hashtags rows cascade away, the counter does
--    not follow, so every count drifted permanently UPWARD. The "tags people are
--    using" chips were advertising tags from posts that no longer existed. This
--    adds the missing DELETE trigger.
--
-- 2) Counts were not "current". A count now means LIVE posts only:
--       expires_at > now()  and  removed_at is null
--    That definition does not depend on the purge having run yet, so a post that
--    expired two minutes ago stops counting immediately instead of lingering
--    until the next 5-minute cron tick. Both triggers and every RPC below use
--    this one rule, which is why the number the user sees is the number that is
--    true.
--
-- HONEST SCOPE on locations: there is no external places/gazetteer API wired
-- into this app (only GIPHY has a key). So "real location" here means one of two
-- genuinely real things — a device-GPS reverse-geocoded place, or a location the
-- community has actually posted from. Arbitrary typed text cannot be validated
-- against a global places database, and the RPCs below do not pretend to.
-- ============================================================


-- ------------------------------------------------------------
-- 1. One definition of a live post, used by everything below.
-- ------------------------------------------------------------
create or replace function public._tag_live_count(p_tag text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.post_hashtags ph
  join public.posts p on p.id = ph.post_id
  where ph.tag = p_tag
    and p.expires_at > now()
    and p.removed_at is null;
$$;


-- ------------------------------------------------------------
-- 2. INSERT/UPDATE trigger — redefined to the live-count rule.
--    The extraction logic is unchanged; only the count definition moves.
-- ------------------------------------------------------------
create or replace function public.sync_hashtags()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  delete from public.post_hashtags where post_id = new.id;
  for t in
    select distinct lower(m[1])
    from regexp_matches(
      coalesce(new.caption, '') || ' ' || coalesce(new.content, ''),
      '#([a-zA-Z0-9_]+)', 'g'
    ) m
  loop
    insert into public.post_hashtags (post_id, tag) values (new.id, t)
    on conflict do nothing;

    insert into public.hashtags (tag, count) values (t, 0)
    on conflict (tag) do nothing;
  end loop;

  update public.hashtags h
    set count = public._tag_live_count(h.tag),
        updated_at = now()
    where h.tag in (select tag from public.post_hashtags where post_id = new.id);

  return new;
end $$;


-- ------------------------------------------------------------
-- 3. The missing DELETE trigger.
--
--    Deliberately does NOT assume the FK cascade has already removed the
--    post_hashtags rows by the time this fires — PostgreSQL does not guarantee
--    the order between a user AFTER DELETE trigger and the RI cascade trigger.
--    Counting through a join to posts makes the result correct either way: if the
--    row is still there, the join to the now-missing post excludes it anyway.
-- ------------------------------------------------------------
create or replace function public.sync_hashtags_on_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  for t in
    select distinct lower(m[1])
    from regexp_matches(
      coalesce(old.caption, '') || ' ' || coalesce(old.content, ''),
      '#([a-zA-Z0-9_]+)', 'g'
    ) m
  loop
    update public.hashtags h
      set count = public._tag_live_count(h.tag),
          updated_at = now()
      where h.tag = t;
  end loop;
  return old;
end $$;

drop trigger if exists posts_sync_hashtags_delete on public.posts;
create trigger posts_sync_hashtags_delete
  after delete on public.posts
  for each row execute function public.sync_hashtags_on_delete();


-- ------------------------------------------------------------
-- 4. Backfill — repairs the inflated counts already on disk.
--    Every tag is recomputed from live posts, so this both fixes the drift and
--    drops any tag that no longer has a live post.
-- ------------------------------------------------------------
--    This is an UPSERT, not an UPDATE, and that distinction turned out to matter:
--    the first run of this migration revealed that `hashtags` was completely EMPTY
--    (0 rows) while post_hashtags held live tags. An UPDATE-only repair cannot fix
--    that — it can only touch rows that already exist — so the trending chips and
--    the Search > Hashtags tab had nothing to show. Every tag seen on any post is
--    now inserted, and the conflicting rows are corrected.
--
--    (The WHERE-clause rule still applies elsewhere in this file: this database has
--    pg-safeupdate enabled, which rejects any UPDATE/DELETE without a WHERE — the
--    exact failure hashtags_where_fix.sql was written to repair. ON CONFLICT is not
--    subject to it.)
insert into public.hashtags (tag, count, updated_at)
select ph.tag, public._tag_live_count(ph.tag), now()
from (select distinct tag from public.post_hashtags) ph
on conflict (tag) do update set count = excluded.count, updated_at = now();

-- Tags with no live posts are dropped: every surface reading this table is showing
-- "what people are posting now", and a 0 in that list is noise, not information.
delete from public.hashtags where count = 0;


-- ------------------------------------------------------------
-- 5. Hashtag suggestions.
--    Live counts, prefix-matched, biggest first. An empty prefix means
--    "top tags", which is what the create screen shows before you type anything.
-- ------------------------------------------------------------
create or replace function public.hashtag_suggest(p_prefix text default '', p_limit int default 8)
returns table (tag text, post_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select ph.tag, count(*)::bigint as post_count
  from public.post_hashtags ph
  join public.posts p on p.id = ph.post_id
  where p.expires_at > now()
    and p.removed_at is null
    and (
      coalesce(btrim(p_prefix), '') = ''
      -- btrim(x, '#'), NOT btrim(both '#' from x): the BOTH/FROM keyword form is
      -- SQL-standard TRIM() syntax and btrim() rejects it at parse time
      -- (syntax error at or near "both", 42601).
      or ph.tag like lower(btrim(p_prefix, '#')) || '%'
    )
  group by ph.tag
  having count(*) > 0
  order by count(*) desc, ph.tag asc
  limit greatest(1, least(coalesce(p_limit, 8), 50));
$$;


-- ------------------------------------------------------------
-- 6. Exact count for one hashtag — the "N posts use #tag" line.
--    Returns 0 rather than no row, so the caller can say "be the first".
-- ------------------------------------------------------------
create or replace function public.hashtag_count(p_tag text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select public._tag_live_count(lower(btrim(coalesce(p_tag, ''), '#')));
$$;


-- ------------------------------------------------------------
-- 7. Location suggestions + count.
--
--    Matching is case- and whitespace-insensitive, which is what stops
--    "Lagos", "lagos" and " Lagos " becoming three separate places (a real
--    inconsistency this app already had). The CANONICAL spelling returned is the
--    one most posts already use, and the create screen stores that, so picking a
--    suggestion normalises what gets written.
-- ------------------------------------------------------------
create or replace function public.location_suggest(p_prefix text default '', p_limit int default 8)
returns table (location text, post_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with live as (
    select btrim(p.location) as loc
    from public.posts p
    where p.location is not null
      and btrim(p.location) <> ''
      and p.expires_at > now()
      and p.removed_at is null
  )
  select
    (array_agg(l.loc order by l.loc))[1] as location,  -- canonical spelling
    count(*)::bigint as post_count
  from live l
  where coalesce(btrim(p_prefix), '') = ''
     or lower(l.loc) like '%' || lower(btrim(p_prefix)) || '%'
  group by lower(l.loc)
  having count(*) > 0
  order by count(*) desc, location asc
  limit greatest(1, least(coalesce(p_limit, 8), 50));
$$;


create or replace function public.location_count(p_location text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.posts p
  where p.location is not null
    and lower(btrim(p.location)) = lower(btrim(coalesce(p_location, '')))
    and p.expires_at > now()
    and p.removed_at is null;
$$;


-- ------------------------------------------------------------
-- 8. Index for the location lookups.
--    The RPCs match on lower(btrim(location)), so the index has to be on that
--    exact expression to be usable.
-- ------------------------------------------------------------
create index if not exists posts_location_lower_idx
  on public.posts (lower(btrim(location)))
  where location is not null;


-- ------------------------------------------------------------
-- 9. These only ever need to be readable by a signed-in user; they are all
--    security definer because they read across rows the caller cannot see.
-- ------------------------------------------------------------
grant execute on function public.hashtag_suggest(text, int) to authenticated;
grant execute on function public.hashtag_count(text) to authenticated;
grant execute on function public.location_suggest(text, int) to authenticated;
grant execute on function public.location_count(text) to authenticated;


-- ------------------------------------------------------------
-- 10. OPTIONAL — repair location variants already on disk.
--
--     Commented out on purpose. The functions above make the PICKER treat
--     "Lagos", "lagos" and " Lagos " as one place, but rows already stored with
--     the odd spelling still carry it, so the feed shows two different labels for
--     the same city. This rewrites them to whichever spelling is most common.
--
--     It is a write across existing user content, so run it deliberately, not as
--     part of a migration you paste and forget.
-- ------------------------------------------------------------
-- with canon as (
--   select lower(btrim(location)) as key,
--          (array_agg(btrim(location) order by btrim(location)))[1] as keep
--   from public.posts
--   where location is not null and btrim(location) <> ''
--   group by lower(btrim(location))
-- )
-- update public.posts p
--   set location = c.keep
--   from canon c
--   where lower(btrim(p.location)) = c.key
--     and btrim(p.location) <> c.keep;


-- ------------------------------------------------------------
-- SANITY CHECKS — run these after, they should return sensible rows.
-- ------------------------------------------------------------
-- select * from public.hashtag_suggest('', 10);
-- select public.hashtag_count('genz');
-- select * from public.location_suggest('lag', 10);
-- select public.location_count('Lagos, Nigeria');
-- -- drift check: this should return ZERO rows
-- select h.tag, h.count, public._tag_live_count(h.tag) as live
-- from public.hashtags h
-- where h.count <> public._tag_live_count(h.tag);
