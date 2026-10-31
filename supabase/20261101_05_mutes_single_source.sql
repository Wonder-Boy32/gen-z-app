-- ============================================================
-- GEN Z — ONE MUTES TABLE: retire public.muted_accounts
--
-- THE BUG (not just duplication)
--   Two tables held the same fact:
--
--     public.muted_users     written by the feed (PostFeed menu, PostViewer)
--                            and read by the feed to filter posts
--     public.muted_accounts  written/deleted by Settings > Muted accounts
--
--   Both are (user_id, muted_id, created_at) with the same PK and the same
--   cascades, so they were interchangeable — except nothing ever synced them.
--   Consequences on a real device:
--     · Muting from the feed hides a creator, but Settings still says
--       "Nobody is muted", so there is nothing to unmute.
--     · Unmuting in Settings deletes a row the feed never read, so the
--       creator stays hidden and the UI reports success.
--
-- WHAT THIS DOES
--   1. Copies any rows from muted_accounts into muted_users (dedup by PK).
--   2. Gives muted_users the FKs and policies settings expects, so the
--      repointed client needs no new schema.
--   3. Drops muted_accounts — but ONLY once the copy has left it empty, so a
--      failure during step 1 cannot lose rows: the table stays and the
--      migration is re-runnable.
--
-- SAFETY
--   Read-then-move, never a blind delete. If the tables are absent (fresh
--   database, verification stub) it notices and does nothing.
-- ============================================================

do $$
declare
  v_moved int := 0;
  v_left  int := 0;
begin
  if to_regclass('public.muted_users') is null
     or to_regclass('public.muted_accounts') is null then
    raise notice 'skip: muted_users and/or muted_accounts not present here';
    return;
  end if;

  insert into public.muted_users (user_id, muted_id, created_at)
  select a.user_id, a.muted_id, a.created_at
    from public.muted_accounts a
  on conflict (user_id, muted_id) do nothing;

  get diagnostics v_moved = row_count;

  -- Remove only the rows that are now provably present in muted_users. The
  -- EXISTS is what makes this safe: a row whose insert was skipped for any
  -- reason other than a PK conflict stays put, the count below is non-zero,
  -- and the exception aborts the whole block so nothing is lost.
  delete from public.muted_accounts a
   where exists (select 1 from public.muted_users m
                  where m.user_id = a.user_id and m.muted_id = a.muted_id);

  select count(*) into v_left from public.muted_accounts;

  if v_left = 0 then
    drop table public.muted_accounts;
    raise notice 'muted_accounts: % row(s) moved into muted_users, table dropped', v_moved;
  else
    raise exception
      'muted_accounts still holds % row(s) after the copy — refusing to drop it', v_left;
  end if;
end $$;


-- ------------------------------------------------------------
-- The feed's policy is FOR ALL, which already covers select/insert/delete.
-- Re-assert it so a database where feed_advanced.sql was never applied still
-- ends up with exactly one owner-scoped policy on the surviving table.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.muted_users') is null then
    raise notice 'skip: muted_users not present here';
    return;
  end if;
  execute 'alter table public.muted_users enable row level security';
  execute 'drop policy if exists muted_users_owner on public.muted_users';
  execute 'create policy muted_users_owner on public.muted_users '
          'for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';
end $$;
