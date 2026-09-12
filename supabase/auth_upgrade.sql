-- ============================================================
-- GEN Z — AUTH UPGRADE: profile columns for the Facebook-style
-- signup flow (run ONCE, additive + idempotent)
-- dob: date of birth (validated 13+ in the app)
-- gender: 'Female' | 'Male' | custom text
-- ============================================================

alter table public.profiles add column if not exists dob date;
alter table public.profiles add column if not exists gender text;
   