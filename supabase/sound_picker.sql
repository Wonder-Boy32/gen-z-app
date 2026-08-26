-- ============================================================
-- GEN Z — REAL MUSIC SOUND PICKER
-- Adds song metadata + trim window to posts.
-- Run this whole file once in the Supabase SQL editor.
-- ============================================================

alter table public.posts add column if not exists sound_artist text;
alter table public.posts add column if not exists sound_url text;
alter table public.posts add column if not exists sound_start double precision not null default 0;
alter table public.posts add column if not exists sound_end double precision;
