-- ============================================================
-- GEN Z — a Drop lives for 7 DAYS, not 48 hours.
--
-- RUN IN THE SUPABASE SQL EDITOR (project: GenZ, main/PRODUCTION).
-- Idempotent — safe to re-run. Going back to 48h is this same script with a
-- different interval.
--
-- WHY
--
-- 48 hours is a retention mechanic, and a retention mechanic needs something to
-- retain. With a low volume of posts it does not create urgency, it creates
-- emptiness on a schedule: the feed you open is emptier than the one you left.
-- Seven days until there is enough content for 48 hours to mean something again.
--
-- WHAT ACTUALLY CONTROLS THE TIMER
--
-- NOT the column default. `public.enforce_48h_expiry()` is a BEFORE INSERT OR
-- UPDATE trigger on posts that OVERWRITES expires_at with created_at + 48h
-- (expiry_v2.sql L28). Whatever the default says, that function wins. Both are
-- changed below so they agree — changing only the default would look correct and
-- do nothing.
--
-- THE TRAP, AND WHY SECTION 3 IS NOT OPTIONAL
--
-- `posts_lock_timestamps` (drop_creator.sql L47) is a BEFORE UPDATE trigger that
-- RAISES if expires_at changes. Postgres fires BEFORE triggers in alphabetical
-- order, so posts_enforce_48h runs BEFORE posts_lock_timestamps. The moment the
-- function starts producing +7 days, every UPDATE of a PRE-EXISTING post
-- computes a new expires_at, trips the lock, and fails — likes, comments,
-- moderation restore, everything.
--
-- So the rows already on disk have to be moved onto the new rule in the same
-- pass. That backfill is a correctness requirement, not tidiness.
-- ============================================================


-- ------------------------------------------------------------
-- 1. THE FUNCTION — the real control.
--
--    The NAME is kept deliberately, even though it now says 48h. Renaming it
--    means dropping the function the trigger points at and re-pointing the
--    trigger, and if that script failed halfway the posts table would be left
--    with a trigger referencing a function that no longer exists — i.e. every
--    INSERT would fail. A stale name costs a reader five seconds; that failure
--    mode costs the app. The comment inside carries the correction.
-- ------------------------------------------------------------
create or replace function public.enforce_48h_expiry()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); -- client-provided created_at is ignored
  end if;
  -- HISTORICAL NAME, current rule: a Drop lives 7 days. Was '48 hours'.
  new.expires_at := new.created_at + interval '7 days';
  return new;
end $$;

revoke all on function public.enforce_48h_expiry() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 2. THE COLUMN DEFAULT — belt and braces.
--
--    The trigger overrides this on every write, so this changes nothing today.
--    It matters if the trigger is ever dropped or bypassed: with the default left
--    at 48h, a post inserted without the trigger would silently get the old rule.
-- ------------------------------------------------------------
alter table public.posts
  alter column expires_at set default (now() + interval '7 days');


-- ------------------------------------------------------------
-- 3. EXISTING ROWS — required, see THE TRAP above.
--
--    The lock trigger has to be off for exactly one statement, because its whole
--    job is to block this change. It is switched back on immediately, and the
--    final SELECT below proves it.
--
--    The WHERE clause is required: this database runs pg-safeupdate, which
--    rejects any UPDATE without one (error 21000).
-- ------------------------------------------------------------
alter table public.posts disable trigger posts_lock_timestamps;

update public.posts
  set expires_at = created_at + interval '7 days'
  where expires_at is distinct from created_at + interval '7 days';

alter table public.posts enable trigger posts_lock_timestamps;


-- ------------------------------------------------------------
-- 4. PROOF. All four rows must read as shown, or stop and tell me.
--    · rule_now             : '7 days'   <- if this says WRONG, stop
--    · lock_trigger_enabled : 'true'     <- if this says false, stop
--    · rows_still_on_48h    : 0          <- if this is not 0, stop
--    · live_posts           : however many are live
-- ------------------------------------------------------------
--    Reads the live function body out of pg_proc rather than trusting that the
--    create-or-replace above did what it says.
select 'rule_now' as check, (
  select case
    when prosrc like '%7 days%' then '7 days'
    else 'WRONG — still not 7 days, stop here'
  end
  from pg_proc where proname = 'enforce_48h_expiry'
) as value
union all select 'lock_trigger_enabled', (
  -- tgenabled is 'O' when enabled, 'D' when disabled. If section 3 aborted
  -- between its two statements this is where it shows up, and the lock would be
  -- OFF on production until it is put back.
  select case when t.tgenabled = 'O' then 'true' else 'false — RE-ENABLE IT' end
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relname = 'posts' and t.tgname = 'posts_lock_timestamps'
  limit 1
)
union all select 'rows_still_on_48h', (
  select count(*)::text from public.posts
  where expires_at is distinct from created_at + interval '7 days'
)
union all select 'live_posts', (
  select count(*)::text from public.posts where expires_at > now() and removed_at is null
);
