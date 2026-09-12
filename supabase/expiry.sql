-- ============================================================
-- Gen Z — 48h auto-expiry engine (v2)
-- Runs every 5 minutes, expires + deletes posts AND their
-- Storage media. See expiry_v2.sql for the full system:
--   - DB-level 48h enforcement (posts_enforce_48h trigger)
--   - genz_purge_expired() — media deleted first (Storage API,
--     service role from vault), post row second; failures queued
--     to media_cleanup_queue and retried on the next run
--   - genz_find_orphan_media(true) — dry-run orphan scan
--   - genz_cleanup_orphan_media(n) — guarded orphan cleanup
-- ============================================================

create extension if not exists pg_cron;

-- Every 5 minutes: purge expired posts + their media.
-- cron.schedule by name is an upsert, so re-running this file
-- safely re-points the job at the new function.
select cron.schedule(
  'genz-purge-expired-posts',
  '*/5 * * * *',
  $$ select public.genz_purge_expired(); $$
);

-- Sanity check: how many expired posts are pending purge
-- select count(*) from public.posts where expires_at <= now();
