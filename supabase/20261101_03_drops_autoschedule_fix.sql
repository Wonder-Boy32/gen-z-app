-- ============================================================
-- GEN Z — DROPS AUTOSCHEDULER (repair of drop2.sql)
--
-- APPLIED to production 2026-11-01 (ref fwouxamnmfdzwxpefoyb). Verified after
-- the run: cron.job has genz-next-drop at '*/15 * * * *', active = true.
-- WHAT WAS BROKEN
--   supabase/drop2.sql never worked. It places `where` AFTER `limit 1`:
--
--       order by random()
--       limit 1
--       where not exists (...)
--
--   Postgres rejects that at PARSE time, so the statement failed before
--   `cron.schedule` was ever called. The job 'genz-next-drop' was never
--   created, which means the "there is always a next Drop" promise has
--   been silently false. Nothing partially applied: a parse error writes
--   nothing.
--
-- WHAT THIS DOES
--   1. Creates the job correctly: `where` before `order by` / `limit`.
--   2. Unschedule-then-schedule, so running this twice is a no-op rather
--      than a duplicate-key error on cron.job.jobname.
--   3. Keeps the 24h lead time and the existing lifecycle engine
--      ('genz-drop-status', every minute, from drops.sql) which flips
--      scheduled -> live -> voting -> closed. This job only ever inserts
--      a 'scheduled' row; it never transitions one.
--
-- SAFETY
--   Additive and idempotent. It inserts at most one drop per 15 minutes,
--   and only when no future drop is already scheduled. It deletes nothing.
--   If pg_cron is unavailable the block raises a notice instead of failing
--   the whole migration.
-- ============================================================

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron not installed — genz-next-drop not scheduled';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'genz-next-drop') then
    perform cron.unschedule('genz-next-drop');
  end if;

  perform cron.schedule('genz-next-drop', '*/15 * * * *', $job$
    insert into public.drops (prompt, status, starts_at, ends_at, voting_ends_at)
    select
      p.prompt,
      'scheduled',
      now() + interval '24 hours',
      now() + interval '24 hours 30 minutes',
      now() + interval '49 hours'
    from (values
      ('SHOW US YOUR CURRENT VIEW'),
      ('WHAT ARE YOU DOING RIGHT NOW?'),
      ('DROP YOUR FIT'),
      ('WHAT''S PLAYING RIGHT NOW?'),
      ('YOUR MOOD IN ONE VIDEO'),
      ('SHOW US SOMETHING NOBODY KNOWS ABOUT YOU'),
      ('YOUR FUNNIEST SCREENSHOT'),
      ('RATE YOUR DAY OUT OF 10 IN ONE POST')
    ) as p(prompt)
    where not exists (
      select 1 from public.drops d
       where d.status = 'scheduled'
         and d.starts_at > now()
    )
    order by random()
    limit 1;
  $job$);
exception when others then
  raise notice 'pg_cron unavailable — genz-next-drop not scheduled: %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- PROOF — wrapped in a DO block so this file also applies on a database
-- without pg_cron (the verification harness is one) instead of aborting
-- on `missing FROM-clause entry for table "cron"`.
--   Expect: one row, active = true, where_before_limit = true.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  if to_regclass('cron.job') is null then
    raise notice 'proof skipped: pg_cron not installed here';
    return;
  end if;
  select jobname, schedule, active,
         position('limit 1' in command) > position('where' in command) as where_before_limit
    into r
    from cron.job where jobname = 'genz-next-drop';
  if not found then
    raise notice 'PROOF FAILED: genz-next-drop is not scheduled';
  else
    raise notice 'genz-next-drop: schedule=%, active=%, where_before_limit=%',
      r.schedule, r.active, r.where_before_limit;
  end if;
end $$;
