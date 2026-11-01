-- ============================================================
-- GEN Z — columns that arrived late but are not optional
--
-- WHY THIS FILE EXISTS
--   admin_center.sql (line 134) adds posts.removed_at and posts.removed_by as
--   part of the moderation module. But they are not moderation features:
--
--     seven_day_expiry.sql   reads removed_at when it rewrites expiry
--     reposts_enforcement.sql reads removed_at to skip hidden posts
--     account_security.sql   reads removed_at in its audit queries
--
--   So three core files depended on the admin module having been pasted
--   first. On a fresh install that ordering is invisible — you only find out
--   when seven_day_expiry.sql dies on `column "removed_at" does not exist`,
--   which is exactly what the replay harness reported.
--
--   Declaring them here, once, before any feature file, removes the artificial
--   dependency. `if not exists` makes every statement a no-op on a database
--   that already has them, so running this against production changes nothing.
--
-- Replayed by: npm run verify:fresh
-- ============================================================

alter table public.posts add column if not exists removed_at timestamptz;
alter table public.posts add column if not exists removed_by uuid;
