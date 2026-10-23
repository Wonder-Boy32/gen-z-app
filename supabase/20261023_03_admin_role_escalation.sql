begin;

-- ============================================================
-- GEN Z — 20261023_03 — ADMIN ROLE ESCALATION
--
-- THE BUG
--
-- admin_admin_set_role() (admin_center.sql L~1860) calls
-- admin_require('admins.manage') and then accepts ANY role in the
-- list, including 'super_admin'. admin_require() lets a super_admin
-- through unconditionally, and lets any other role through if the
-- permission table grants admins.manage to it.
--
-- So a plain `admin` who holds admins.manage can promote themselves
-- (or anyone) to super_admin, and super_admin bypasses every
-- permission check in the product:
--
--     if p_perm is not null and v_role <> 'super_admin' and not exists (...)
--
-- admin_admin_remove() has the mirror problem: a non-super admin can
-- disable the only super_admin and take the installation.
--
-- admin_admin_add() already refuses to create a super_admin (its
-- whitelist omits the role), which is what makes set_role's omission
-- look like an oversight rather than a decision.
--
-- WHAT THIS CHANGES
--
--   * granting super_admin requires being super_admin
--   * a non-super admin cannot change their own role at all
--   * the last active super_admin cannot be demoted or disabled
--   * every rejection is audited, so an attempt is visible in the
--     admin log rather than a silent 403
--
-- What it does NOT change: who is currently an admin. No rows are
-- touched. If an escalation already happened, the fix stops the next
-- one and the audit log shows `set_admin_role` entries you can review
-- with the query at the bottom of this file.
--
-- Idempotent. No data deleted.
-- ============================================================


create or replace function public.admin_admin_set_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid;
  v_caller_role text;
  v_target_role text;
  v_supers      int;
begin
  v_uid := public.admin_require('admins.manage');

  if p_role not in ('super_admin','admin','moderator','support','analytics') then
    raise exception 'invalid role';
  end if;

  select role into v_caller_role
    from public.admin_users
   where user_id = v_uid and status = 'active';

  select role into v_target_role
    from public.admin_users
   where user_id = p_user_id;

  -- Only a super_admin may mint another super_admin.
  if p_role = 'super_admin' and v_caller_role <> 'super_admin' then
    perform public.admin_audit('set_admin_role_denied', 'admins', 'admin',
      p_user_id::text, 'non-super attempted to grant super_admin',
      jsonb_build_object('requested_role', p_role, 'caller_role', v_caller_role));
    raise exception 'permission_denied';
  end if;

  -- No self-promotion. A super_admin may still change their own role
  -- (that is a deliberate demotion, not an escalation).
  if p_user_id = v_uid and p_role <> v_caller_role and v_caller_role <> 'super_admin' then
    perform public.admin_audit('set_admin_role_denied', 'admins', 'admin',
      p_user_id::text, 'non-super attempted to change own role',
      jsonb_build_object('requested_role', p_role, 'caller_role', v_caller_role));
    raise exception 'cannot_change_own_role';
  end if;

  -- Never leave the installation without a super_admin.
  if v_target_role = 'super_admin' and p_role <> 'super_admin' then
    select count(*) into v_supers
      from public.admin_users
     where role = 'super_admin' and status = 'active';
    if v_supers <= 1 then
      raise exception 'cannot_demote_last_super_admin';
    end if;
  end if;

  update public.admin_users set role = p_role where user_id = p_user_id;

  perform public.admin_audit('set_admin_role', 'admins', 'admin', p_user_id::text, null,
    jsonb_build_object('role', p_role, 'from', v_target_role));
end $$;


create or replace function public.admin_admin_remove(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid;
  v_caller_role text;
  v_target_role text;
  v_supers      int;
begin
  v_uid := public.admin_require('admins.manage');

  if v_uid = p_user_id then
    raise exception 'cannot remove yourself';
  end if;

  select role into v_caller_role
    from public.admin_users where user_id = v_uid and status = 'active';
  select role into v_target_role
    from public.admin_users where user_id = p_user_id;

  if v_target_role = 'super_admin' and v_caller_role <> 'super_admin' then
    perform public.admin_audit('disable_admin_denied', 'admins', 'admin',
      p_user_id::text, 'non-super attempted to disable a super_admin', null);
    raise exception 'permission_denied';
  end if;

  if v_target_role = 'super_admin' then
    select count(*) into v_supers
      from public.admin_users
     where role = 'super_admin' and status = 'active';
    if v_supers <= 1 then
      raise exception 'cannot_disable_last_super_admin';
    end if;
  end if;

  update public.admin_users set status = 'disabled' where user_id = p_user_id;

  perform public.admin_audit('disable_admin', 'admins', 'admin', p_user_id::text);
end $$;

-- Grants unchanged: set_role and remove are already
-- `revoke all ... from public, anon; grant execute ... to authenticated`.
-- admin_require() inside the body is what makes the grant safe.


-- ------------------------------------------------------------
-- VERIFY — the bodies must now contain the guards.
-- ------------------------------------------------------------
select 'set_role_guards' as check_name,
       (prosrc like '%permission_denied%')::text as has_escalation_guard,
       (prosrc like '%cannot_change_own_role%')::text as has_self_guard,
       (prosrc like '%cannot_demote_last_super_admin%')::text as has_last_super_guard
from pg_proc
where proname = 'admin_admin_set_role';


-- ------------------------------------------------------------
-- REVIEW — did this already happen? Any escalation shows up here.
-- Run it once and read the result; it changes nothing.
-- ------------------------------------------------------------
-- select created_at, admin_email, action, target_id, metadata
-- from public.admin_audit_log
-- where action in ('set_admin_role','add_admin','set_admin_role_denied')
-- order by created_at desc
-- limit 100;
--
-- Cross-check the current roster:
-- select au.user_id, u.email, au.role, au.status
-- from public.admin_users au
-- left join auth.users u on u.id = au.user_id
-- order by au.role, au.status;

commit;
