-- ============================================================
-- Gen Z — Drops 2.0 (RUN THIS after drops.sql)
-- Auto-schedules the next Drop every 24h so there's always
-- something coming — users never want to miss the next one.
-- ============================================================

-- Every 15 minutes: if no future drop is scheduled, create one
-- 24h from now with a random prompt.
select cron.schedule('genz-next-drop', '*/15 * * * *', $$
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
  order by random()
  limit 1
  where not exists (
    select 1 from public.drops where status = 'scheduled' and starts_at > now()
  );
$$);
