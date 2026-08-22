-- ============================================================
-- Gen Z — Profile 2.0 (RUN THIS)
-- Adds display name + bio. (Achievements are computed in the
-- app from existing data — no new tables needed.)
-- ============================================================

alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists bio text;

-- sanity: select id, username, display_name, bio from public.profiles limit 5;
