-- ============================================================
-- Get Verified — application queue
--
-- Depends on: schema.sql (profiles), profile3.sql (profiles.verified)
-- Hand-run like the other files in this folder; there is no migration runner.
--
-- ------------------------------------------------------------
-- WHY THIS IS A SEPARATE FILE FROM genzplus.sql
-- ------------------------------------------------------------
-- GenZ+ and verification are DIFFERENT THINGS and must stay that way:
--
--   GenZ+        = premium features, bought.
--   Verification = authenticity/trust, earned, and decided by a human.
--
-- Nothing in this file reads or writes genzplus_members, and nothing in
-- genzplus.sql touches verification. There is no trigger, no shared column and
-- no shared function between them. Buying GenZ+ therefore cannot produce a
-- verification badge — the only thing that sets profiles.verified is the admin
-- path in admin_center.sql, after a human reviews an application from here.
--
-- This file only collects APPLICATIONS. It grants nothing.
-- ============================================================


-- ------------------------------------------------------------
-- 1) THE APPLICATION
-- ------------------------------------------------------------
create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_name text,
  reason text not null,
  links text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One OPEN application per user. A rejected or approved one does not block a
-- future application, so a rejected user can apply again.
create unique index if not exists verification_requests_one_pending
  on public.verification_requests (user_id)
  where status = 'pending';

create index if not exists verification_requests_queue_idx
  on public.verification_requests (status, created_at desc);

alter table public.verification_requests enable row level security;


-- ------------------------------------------------------------
-- 2) RLS — you can apply and you can watch your own application. That is all.
-- ------------------------------------------------------------

-- See your own application (and its review outcome).
drop policy if exists "verification_select_own" on public.verification_requests;
create policy "verification_select_own" on public.verification_requests
for select using (auth.uid() = user_id);

-- Apply as yourself only. Status is forced to 'pending' by the policy so a
-- client cannot submit itself as 'approved'; the reason must be substantive;
-- and an already-verified account cannot apply again.
drop policy if exists "verification_insert_own" on public.verification_requests;
create policy "verification_insert_own" on public.verification_requests
for insert with check (
  auth.uid() = user_id
  and status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
  and length(btrim(reason)) >= 20
  and not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.verified
  )
);

-- ------------------------------------------------------------
-- NO update and NO delete policy, on purpose.
--
-- A user therefore cannot approve their own application, cannot move it to
-- 'approved', and cannot edit a rejected one into a passing state. Review is
-- admin-only and runs through admin_center.sql, which is SECURITY DEFINER and
-- bypasses RLS — so the admin console is unaffected by the rules above.
-- ------------------------------------------------------------


-- ============================================================
-- VERIFY AFTER RUNNING
--
--   -- expect exactly two policies: select-own + insert-own. Nothing for UPDATE.
--   select policyname, cmd from pg_policies
--   where tablename = 'verification_requests';
--
--   -- as an authenticated user, approving yourself MUST fail with an RLS violation:
--   update public.verification_requests set status = 'approved'
--   where user_id = auth.uid();
--
--   -- a one-character reason must be rejected by the WITH CHECK:
--   insert into public.verification_requests (user_id, reason)
--   values (auth.uid(), 'x');
-- ============================================================
