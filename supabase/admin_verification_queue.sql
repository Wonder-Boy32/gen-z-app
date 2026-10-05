-- ============================================================
-- GEN Z — VERIFICATION REVIEW QUEUE (the admin half)
-- Run ONCE, AFTER admin_center.sql and verification_requests.sql.
-- Additive + idempotent: safe to re-run.
--
-- ------------------------------------------------------------
-- WHY THIS FILE EXISTS
-- ------------------------------------------------------------
-- verification_requests.sql states, in its own words:
--
--   "Review is admin-only and runs through admin_center.sql, which is
--    SECURITY DEFINER and bypasses RLS."
--
-- That function was never written. An audit of every admin_* function in this
-- folder found 46 of them and NOT ONE touched public.verification_requests.
-- The consequences were structural, not cosmetic:
--
--   · verification_requests has select-own + insert-own policies and
--     deliberately NO update policy, so an application is readable only by its
--     own applicant. No admin could list the queue.
--   · The only verification lever that existed was admin_user_set_verified —
--     a bare flag toggle. An admin had to already know that a request existed,
--     and for whom, to act on it. The console's own Users screen exposes that
--     toggle, so the trap was easy to fall into and invisible once it happened.
--
-- So applicants could apply, and their applications went nowhere. This file is
-- the missing review path, modelled on genzplus_review_payment so the admin app
-- has one consistent review shape.
--
-- ------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------
-- It does not connect verification to GenZ+ in any way. verification_requests.sql
-- is explicit that GenZ+ (bought) and verification (earned, human-decided) must
-- stay unrelated — no trigger, no shared column, no shared function. Nothing here
-- reads genzplus_members, and approving a payment cannot produce a badge.
-- ============================================================


-- ------------------------------------------------------------
-- 1) THE QUEUE — newest first, filterable by status
-- ------------------------------------------------------------
create or replace function public.admin_verification_list(
  p_status text default 'pending',
  p_limit int default 100,
  p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb;
begin
  -- Same permission as admin_user_set_verified, deliberately. The admin who
  -- could already flip the badge by hand is exactly the admin who should be
  -- able to review the queue that justifies doing so, and reusing the existing
  -- permission means no role loses access to a capability it already had.
  perform public.admin_require('users.manage');

  -- `p_status is null` means "every status" — a reviewer needs to be able to
  -- look back at what they decided, not only at what is outstanding.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select vr.id, vr.user_id, vr.display_name, vr.reason, vr.links, vr.status,
           vr.review_note, vr.reviewed_at, vr.created_at,
           pr.username, pr.avatar_url, pr.verified
      from public.verification_requests vr
      left join public.profiles pr on pr.id = vr.user_id
     where (p_status is null or vr.status = p_status)
     order by vr.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 200))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return jsonb_build_object('requests', v_rows);
end $$;

revoke all on function public.admin_verification_list(text, int, int) from public, anon;
grant execute on function public.admin_verification_list(text, int, int) to authenticated;


-- ------------------------------------------------------------
-- 2) RESOLVE — approve or reject, and audit it
-- ------------------------------------------------------------
create or replace function public.admin_verification_resolve(
  p_request uuid,
  p_approve boolean,
  p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid;
  v_row public.verification_requests;
begin
  -- Reuse the existing role gate rather than inventing a second one, and report
  -- refusals inline the way genzplus_review_payment does — the console surfaces
  -- `error` to the admin instead of pretending a success that did not happen.
  begin
    v_admin := public.admin_require('users.manage');
  exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
  end;

  select * into v_row from public.verification_requests where id = p_request;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'application not found');
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already reviewed', 'status', v_row.status);
  end if;

  -- A rejection is shown to the applicant verbatim as `review_note`
  -- (src/services/verification.ts reads it), so an empty one leaves them with
  -- nothing to act on. Require a real sentence rather than allowing a bare
  -- "no" the applicant cannot learn from.
  if not p_approve and length(btrim(coalesce(p_note, ''))) < 5 then
    return jsonb_build_object('ok', false, 'error', 'a rejection needs a short reason');
  end if;

  update public.verification_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         review_note = p_note,
         reviewed_by = v_admin,
         reviewed_at = now()
   where id = p_request;

  -- Granting the badge is part of approving, in one transaction, so the queue
  -- row and profiles.verified can never disagree about the outcome. Note the
  -- reverse is NOT done: rejecting does not clear an existing badge, because a
  -- later application does not revoke an earlier earned one.
  if p_approve then
    update public.profiles set verified = true where id = v_row.user_id;
  end if;

  -- A trust decision about a person belongs in the audit log.
  perform public.admin_audit(
    case when p_approve then 'verification_approve' else 'verification_reject' end,
    'users', 'verification_request', p_request::text, p_note,
    jsonb_build_object('user_id', v_row.user_id, 'approved', p_approve)
  );

  return jsonb_build_object('ok', true, 'approved', p_approve);
end $$;

revoke all on function public.admin_verification_resolve(uuid, boolean, text) from public, anon;
grant execute on function public.admin_verification_resolve(uuid, boolean, text) to authenticated;


-- ============================================================
-- VERIFY AFTER RUNNING
--
--   -- both exist:
--   select proname from pg_proc
--   where proname in ('admin_verification_list','admin_verification_resolve');
--
--   -- a NON-admin calling either must be refused, not silently allowed:
--   select public.admin_verification_list();
--
--   -- the queue should now show what applicants submitted:
--   select public.admin_verification_list('pending');
--
--   -- and the invariant that matters: an applicant still cannot approve
--   -- themselves (no update policy exists, so this must raise):
--   update public.verification_requests set status = 'approved'
--   where user_id = auth.uid();
-- ============================================================
