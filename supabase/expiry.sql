-- ============================================================
-- Gen Z — 48h auto-expiry engine
-- Runs every 5 minutes, deletes expired posts.
-- Cascade deletes clean up likes, comments, and views for free
-- (all reference posts ON DELETE CASCADE).
-- ============================================================

-- pg_cron must be enabled in your Supabase project:
-- Dashboard -> Database -> Extensions -> enable "pg_cron" (schema: cron)

create extension if not exists pg_cron;

-- Delete every expired story (runs every 5 minutes)
select cron.schedule(
  'genz-purge-expired-posts',
  '*/5 * * * *',
  $$
  delete from public.posts
  where expires_at <= now();
  $$
);

-- Sanity check: how many expired posts get purged per run
-- select count(*) from public.posts where expires_at <= now();

-- NOTE: video/image files in the 'media' storage bucket are NOT
-- removed by this job (Supabase storage has no cascades).
-- v1: acceptable — files are small and orphaned rows are invisible.
-- v2: add a Storage cleanup Edge Function triggered on post delete.
