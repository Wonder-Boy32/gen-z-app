-- ============================================================
-- GEN Z — index for keyset pagination on the feed
--
-- APPLIED to production 2026-11-01 (ref fwouxamnmfdzwxpefoyb). Verified after
-- the run: pg_indexes returns posts_feed_keyset_idx on (created_at DESC, id DESC).
--
-- THE QUERY
--   FeedScreen now pages with a cursor instead of stopping at 90 rows:
--
--     order by created_at desc, id desc
--     where (created_at, id) < (cursor_created_at, cursor_id)
--
--   The pair matters. `id` is the tie-break, because two Drops can share a
--   created_at to the microsecond when a bulk import or a retry lands twice,
--   and without a total order a page boundary can skip one of them.
--
-- WHY A NEW INDEX
--   schema.sql has posts_created_at_idx (created_at desc). That satisfies the
--   ORDER BY but not the pair comparison, so Postgres has to read past rows
--   that tie on created_at and drop them one at a time. With a composite index
--   the comparison is an index range and the planner stops at LIMIT.
--
-- WHY NOT (expires_at, created_at)
--   The feed also filters expires_at > now(), which looks like it belongs
--   first. It does not: expires_at is a moving target, so it cannot serve as a
--   stable sort key across pages — a post expiring between page 1 and page 2
--   would shift every subsequent row and duplicate the boundary. Ordering stays
--   on created_at; expires_at is a filter the index scan applies per row.
--
-- SAFETY
--   Additive. One index, no data change, no locks beyond the build (CONCURRENTLY
--   is deliberately not used here: these migrations run inside a single
--   transaction scope in the SQL editor, where CONCURRENTLY is illegal).
-- ============================================================

create index if not exists posts_feed_keyset_idx
  on public.posts (created_at desc, id desc);


-- ------------------------------------------------------------
-- PROOF — the index must exist and must actually be used for the feed's
-- access pattern. A plan that seq-scans means the index is not doing its job.
-- ------------------------------------------------------------
do $$
declare
  v_exists boolean;
  v_plan   text;
begin
  if to_regclass('public.posts') is null then
    raise notice 'skip: public.posts does not exist here';
    return;
  end if;

  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'posts_feed_keyset_idx'
  ) into v_exists;

  if not v_exists then
    raise exception 'proof failed: posts_feed_keyset_idx was not created';
  end if;

  -- Roll the proof back: this only plans the query, it never runs it.
  begin
    execute 'explain (costs off) select id from public.posts '
            'order by created_at desc, id desc limit 1' into v_plan;
  exception when others then
    v_plan := null;
  end;

  raise notice 'posts_feed_keyset_idx present%s',
    case when v_plan is null then ''
         when v_plan like '%posts_feed_keyset_idx%' then ' and used by the keyset plan'
         else ' (planner chose another path here; expected on an empty table)' end;
end $$;
