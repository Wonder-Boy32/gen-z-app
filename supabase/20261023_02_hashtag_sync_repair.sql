-- ============================================================
-- GEN Z — 20261023_02 — HASHTAG SYNC: CORRECT A COUNT ON EDIT
--
-- THE BUG
--
-- sync_hashtags() (hashtags_locations_v2.sql L56-82) rebuilds
-- post_hashtags for the edited post, then recomputes counts with:
--
--     where h.tag in (select tag from public.post_hashtags
--                     where post_id = new.id)
--
-- That list is the NEW tags only. The row has just been deleted and
-- re-inserted, so the OLD tags are already gone from it. A tag that
-- was removed by the edit is therefore never recomputed and keeps
-- the count it had before — permanently inflated, because the DELETE
-- trigger only fires for rows that are actually deleted.
--
-- Reproduced by the audit's test case "editing a caption to remove a
-- hashtag": post says "#lagos #party", edit to "#lagos", and #party
-- keeps counting a post that no longer mentions it.
--
-- THE FIX
--
-- Recompute the union of old and new tags. Everything else about the
-- published behaviour is preserved deliberately:
--   * live-count definition (expires_at > now() and removed_at is null)
--   * auto-creation of a tag row on first use
--   * the DELETE trigger from v2 stays exactly as it is
--   * no tag row is deleted here — a zero count is filtered out of
--     hashtag_suggest() by its join to posts, so removing rows would
--     only churn the table
--
-- RELATED FINDINGS, DELIBERATELY NOT CHANGED
--
--   * hashtags_locations_v2.sql is applied on production. Verified:
--     hashtag_suggest() and _tag_live_count() both return 200 from
--     the REST API. So the "was the fix applied" question is answered
--     for v2 — but hashtags_where_fix.sql documents a pg-safeupdate
--     failure whose premise does not match discover.sql, which always
--     had a WHERE clause. That file is stale documentation; this
--     migration supersedes both.
--   * The hashtag tables are still SELECT-only for clients, with no
--     INSERT/UPDATE/DELETE policy, so a client cannot move a global
--     counter directly. That part was already correct.
--
-- Idempotent. Additive. No data deleted.
-- ============================================================


-- ------------------------------------------------------------
-- 1) The count definition, restated so this file does not depend on
--    the order in which migrations happen to have been run.
--    Identical body to hashtags_locations_v2.sql L36-49.
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
-- 2) The repaired trigger function.
-- ------------------------------------------------------------
create or replace function public.sync_hashtags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new  text[] := '{}';
  v_old  text[] := '{}';
  v_all  text[] := '{}';
  t      text;
begin
  -- tags the post carries NOW
  select coalesce(array_agg(distinct lower(m[1])), '{}')
    into v_new
  from regexp_matches(
         coalesce(new.caption, '') || ' ' || coalesce(new.content, ''),
         '#([a-zA-Z0-9_]+)', 'g'
       ) m;

  -- tags it carried BEFORE this write (UPDATE only; on INSERT old is null)
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(distinct lower(m[1])), '{}')
      into v_old
    from regexp_matches(
           coalesce(old.caption, '') || ' ' || coalesce(old.content, ''),
           '#([a-zA-Z0-9_]+)', 'g'
         ) m;
  end if;

  -- association rows for this post are rebuilt from the new caption
  delete from public.post_hashtags where post_id = new.id;

  foreach t in array v_new loop
    insert into public.post_hashtags (post_id, tag) values (new.id, t)
    on conflict do nothing;

    insert into public.hashtags (tag, count) values (t, 0)
    on conflict (tag) do nothing;
  end loop;

  -- THE FIX: recompute over the UNION. A removed tag is in v_old but
  -- not v_new, and it is exactly the one that used to be skipped.
  select coalesce(array_agg(distinct x), '{}')
    into v_all
  from unnest(v_new || v_old) x;

  foreach t in array v_all loop
    update public.hashtags h
       set count = public._tag_live_count(h.tag),
           updated_at = now()
     where h.tag = t;
  end loop;

  return new;
end $$;


-- ------------------------------------------------------------
-- 3) Re-install both triggers so the state does not depend on which
--    of discover.sql / hashtags_where_fix.sql / v2 ran last.
--    The DELETE trigger body is unchanged from v2 (L94-117).
-- ------------------------------------------------------------
drop trigger if exists posts_sync_hashtags on public.posts;
create trigger posts_sync_hashtags
  after insert or update on public.posts
  for each row execute function public.sync_hashtags();

create or replace function public.sync_hashtags_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
-- 4) Repair the drift the bug already caused.
--    Upsert, not update — a tag with no row yet must still appear.
-- ------------------------------------------------------------
insert into public.hashtags (tag, count, updated_at)
select ph.tag, public._tag_live_count(ph.tag), now()
from (select distinct tag from public.post_hashtags) ph
on conflict (tag) do update
  set count = excluded.count,
      updated_at = now();


-- ------------------------------------------------------------
-- 5) VERIFICATION
--    `drift` must be 0. Any row is a counter that disagrees with
--    what a live query says right now.
-- ------------------------------------------------------------
select 'drift' as check_name,
       count(*) as n
from public.hashtags h
where h.count <> public._tag_live_count(h.tag);

select 'triggers' as check_name,
       count(*) as n
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'posts'
  and t.tgname in ('posts_sync_hashtags', 'posts_sync_hashtags_delete');


-- ============================================================
-- ACCEPTANCE TESTS — run these manually on a scratch post, not
-- against production content. Each block is self-cleaning.
--
--   -- 1. create, three tags
--   insert into posts (user_id, content) values (<uid>, '#one #two #three');
--   -- expect hashtags.count for each = 1
--
--   -- 2. edit to drop one
--   update posts set content = '#one #two' where id = <pid>;
--   -- expect #three = 0        <- this returned 1 before the fix
--
--   -- 3. change capitalisation
--   update posts set content = '#ONE #two' where id = <pid>;
--   -- expect #one still 1, no separate #ONE row
--
--   -- 4. delete
--   delete from posts where id = <pid>;
--   -- expect #one and #two = 0
--
--   -- 5. concurrent same tag: two sessions inserting #lagos
--   -- expect count 2, not 1 or 3. Both triggers take the same row
--   -- lock on hashtags(tag), so the second waits and recomputes.
-- ============================================================
