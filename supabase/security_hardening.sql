-- ============================================================
-- GEN Z  --  SECURITY HARDENING
--
-- Fixes found by the pre-launch RLS/IDOR audit (2026-09-12).
-- Run this whole file once in the Supabase SQL editor.
-- Idempotent - safe to re-run.
--
-- Everything here is ADDITIVE and deny-only: it can remove access that
-- should never have existed, but it does not grant anything new and it
-- does not change any feature behaviour. Your SECURITY DEFINER RPCs keep
-- working, because a definer function runs as its owner and is not
-- subject to RLS or to these revokes.
-- ============================================================


-- ------------------------------------------------------------
-- 1) CRITICAL - four tables were created with NO row level security
--    and NO revoke, while living in the public schema that PostgREST
--    exposes. Every access path in the code goes through SECURITY
--    DEFINER functions, so enabling RLS with no policies changes
--    nothing for the app and closes the direct door.
--
--    Worst case impact if these are reachable with the public anon key:
--      user_recovery_codes  read = recovery-code hash leak
--                           write = insert a hash YOU know for someone
--                           else's user_id, then redeem it -> takeover
--      recovery_attempts    delete/flip your own lockout to brute-force
--                           account discovery and code sending
--      security_events      forge or erase the audit trail; read device
--                           and approximate-location history
--      user_sessions        read/spoof "where you're logged in"
-- ------------------------------------------------------------
alter table public.user_recovery_codes enable row level security;
alter table public.user_sessions      enable row level security;
alter table public.security_events    enable row level security;
alter table public.recovery_attempts  enable row level security;

revoke all on public.user_recovery_codes from anon, authenticated, public;
revoke all on public.user_sessions      from anon, authenticated, public;
revoke all on public.security_events    from anon, authenticated, public;
revoke all on public.recovery_attempts  from anon, authenticated, public;

-- media_cleanup_queue already does this the other way round (RLS disabled,
-- privileges revoked). Belt and braces: with no policies, RLS is deny-all,
-- so enable it too. The cleanup job is a definer function and is unaffected.
alter table public.media_cleanup_queue enable row level security;
revoke all on public.media_cleanup_queue from anon, authenticated, public;


-- ------------------------------------------------------------
-- 2) PRIVACY - the block graph was world-readable
--    blocks_select used using(true), so anyone with the anon key
--    (which ships inside the app) could read who blocked whom.
-- ------------------------------------------------------------
drop policy if exists "blocks_select" on public.blocks;
drop policy if exists "blocks_select_own" on public.blocks;
create policy "blocks_select_own" on public.blocks
  for select using (blocker_id = auth.uid());


-- ------------------------------------------------------------
-- 3) PRIVACY - post view records were world-readable
--    post_views_select used using(true): anyone could enumerate
--    exactly who viewed any post, and when. Note this contradicted
--    profile_views, which is owner-only.
--    New rule: you can see your own view row, and a post's owner can
--    see who viewed that post. Nobody else.
-- ------------------------------------------------------------
drop policy if exists "post_views_select" on public.post_views;
drop policy if exists "post_views_select_scoped" on public.post_views;
create policy "post_views_select_scoped" on public.post_views
  for select using (
    user_id = auth.uid()
    or post_id in (select p.id from public.posts p where p.user_id = auth.uid())
  );


-- ------------------------------------------------------------
-- 4) PUSH SPAM - any user could notify any other user, unlimited
--    notifications_insert only checks actor_id = auth.uid(), so the
--    RECIPIENT is unconstrained. Before push this meant in-app noise;
--    now the same row sends a real OS notification to someone's lock
--    screen, so it is an abuse vector.
--
--    This does NOT remove the ability to notify people, which would
--    break likes/comments. It removes the abuse:
--      - one notification per (recipient, actor, type, post, comment)
--        per hour, so a like-storm cannot page someone 500 times
--      - a hard ceiling of 40 pushes from one actor to one recipient
--        per hour
--    Returning NULL from a BEFORE INSERT trigger skips the row, so the
--    push trigger never fires either.
-- ------------------------------------------------------------
create or replace function public.notifications_rate_limit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_dupes integer;
  v_recent integer;
begin
  -- NOTE: deliberately no self-notification guard here. push_notifications.sql
  -- already skips push for self-actions, and filtering the ROW could hide an
  -- in-app confirmation you expect to see.

  select count(*) into v_dupes
    from public.notifications
   where user_id = new.user_id
     and actor_id = new.actor_id
     and type = new.type
     and coalesce(post_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(new.post_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and coalesce(comment_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(new.comment_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and created_at > now() - interval '1 hour';

  if v_dupes > 0 then
    return null;
  end if;

  select count(*) into v_recent
    from public.notifications
   where user_id = new.user_id
     and actor_id = new.actor_id
     and created_at > now() - interval '1 hour';

  if v_recent >= 40 then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists notifications_rate_limit_guard on public.notifications;
create trigger notifications_rate_limit_guard
  before insert on public.notifications
  for each row execute function public.notifications_rate_limit();


-- ------------------------------------------------------------
-- 5) LEFT FOR YOU TO DECIDE - not changed here on purpose
--
--    profiles_select is using(true) and profiles now has a free-text
--    `location` column, so whatever a student types (possibly an exact
--    hall or address) is readable by anyone, including logged-out
--    users. The brief says do not expose precise locations publicly.
--    I did not change this because it alters visible product behaviour
--    and could break the profile UI.
--
--    Pick one when you are ready:
--      a) stop collecting free-text location and store a campus id
--      b) keep the column but hide it once a profile is private, in a
--         definer RPC that returns only campus-level text
--      c) leave as is and accept that location is public
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 6) VERIFY - expect ZERO rows
--    Any table listed here is reachable without RLS.
-- ------------------------------------------------------------
select tablename
  from pg_tables
 where schemaname = 'public'
   and rowsecurity = false;

-- Confirm the four tables are locked and have no policies (0 rows each
-- is correct - no policy plus RLS on means deny-all except definer code).
select tablename, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename in ('user_recovery_codes','user_sessions','security_events','recovery_attempts');

-- Confirm the two privacy policies were replaced.
select tablename, policyname, qual
  from pg_policies
 where schemaname = 'public'
   and tablename in ('blocks','post_views')
 order by tablename;
