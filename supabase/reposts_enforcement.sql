-- ============================================================
-- Gen Z — Repost enforcement
--
-- Requires, in this order: schema.sql (blocks), profile3.sql (reposts table),
-- drop_creator.sql (posts.allow_reposts), admin_center.sql (posts.removed_at).
-- Hand-run like the other files in this folder; there is no migration runner.
--
-- WHY THIS EXISTS — the original reposts policies in profile3.sql had three gaps:
--
--   1. reposts_insert checked ONLY `auth.uid() = user_id`. So the creator's
--      `allow_reposts` toggle was purely decorative: it was enforced in the app
--      UI (FeedPost.tsx) to hide a button, and any direct API call could ignore it.
--      Same for blocks and for reposting an already-expired drop.
--
--   2. Nothing stopped you from reposting your OWN drop, which then showed up in
--      your reposts tab alongside your own posts.
--
--   3. reposts_select was `using (true)` — world-readable. Anyone holding the anon
--      key could enumerate who reposted what and when, including rows pointing at
--      posts that a private account's own policy would otherwise hide. The post
--      content stayed protected; the relationship metadata did not.
--
-- VERIFIED SAFE BEFORE TIGHTENING SELECT: the app reads this table only with
-- .eq('user_id', <me>) — FeedScreen.tsx (feed icon state) and ProfileScreen.tsx
-- (your own reposts tab). Public profiles never read it at all; PublicProfileScreen
-- shows no reposts tab. The admin analytics in admin_center.sql / _admin_part3.sql
-- run inside SECURITY DEFINER functions, which bypass RLS, so those counters are
-- unaffected by this change.
--
-- No data migration is needed: nothing in the app ever selected another user's rows.
-- ============================================================


-- ------------------------------------------------------------
-- 1) INSERT — a repost is only allowed when the creator permits it,
--    the drop is still live, there is no block either way, and it is
--    not your own drop.
--
--    Note: a repost of an expired/removed drop was always meaningless, because
--    the nested `post:posts!reposts_post_id_fkey` join returns null under the
--    posts RLS policy and the tile renders nothing. This refuses to store the
--    dead row in the first place.
-- ------------------------------------------------------------
drop policy if exists "reposts_insert" on public.reposts;

create policy "reposts_insert" on public.reposts
for insert with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.posts p
    where p.id = post_id
      -- the creator's toggle is now binding, not decorative
      and p.allow_reposts
      -- belt-and-braces: the live posts policy already implies both of these
      and p.expires_at > now()
      and p.removed_at is null
      -- you cannot repost your own drop
      and p.user_id <> auth.uid()
      -- blocked in either direction
      and not exists (
        select 1
        from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
      )
  )
);


-- ------------------------------------------------------------
-- 2) SELECT — only the reposter reads their own repost rows.
--    Both existing readers already filter to user_id = me, so the app
--    behaves identically; this just stops the table being world-readable.
-- ------------------------------------------------------------
drop policy if exists "reposts_select" on public.reposts;

create policy "reposts_select" on public.reposts
for select using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 3) DELETE — unchanged behaviour, restated so this file is self-contained
--    and re-running it cannot leave a missing policy behind.
-- ------------------------------------------------------------
drop policy if exists "reposts_delete" on public.reposts;

create policy "reposts_delete" on public.reposts
for delete using (auth.uid() = user_id);


-- ============================================================
-- VERIFY AFTER RUNNING (as an authenticated user):
--
--   -- should now list 3 policies, none of them `true` for SELECT
--   select policyname, cmd, qual, with_check
--   from pg_policies where tablename = 'reposts';
--
--   -- reposting your own drop must fail:
--   insert into public.reposts (user_id, post_id)
--   values (auth.uid(), (select id from public.posts where user_id = auth.uid() limit 1));
--   -- expect: new row violates row-level security policy for table "reposts"
-- ============================================================
