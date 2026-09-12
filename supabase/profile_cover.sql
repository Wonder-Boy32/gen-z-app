-- ============================================================
-- GEN Z — PROFILE COVER PHOTO (run ONCE, additive + idempotent)
-- Users can set their own profile cover (Edit profile → Change
-- cover photo). Falls back to the automatic post cover when unset.
-- ============================================================

alter table public.profiles add column if not exists cover_url text;

-- keep it readable by anyone who can read profiles (existing policies apply)
