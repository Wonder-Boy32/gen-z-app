-- ============================================================
-- GenZ+ — OPay manual transfer + 2-month plan
--
-- Requires (run in this order): schema.sql, profile3.sql, admin_center.sql,
-- genzplus.sql. Hand-run like the other files; there is no migration runner.
--
-- ------------------------------------------------------------
-- WHY THIS IS A MANUAL-TRANSFER FLOW, NOT AN API INTEGRATION
-- ------------------------------------------------------------
-- OPay DOES publish a merchant API (Cashier / Payments / Refunds — see
-- doc.opaycheckout.com), but it is only available to REGISTERED MERCHANTS with
-- onboarding credentials. A plain OPay account number cannot be queried by a
-- third party to confirm that money arrived, so there is no honest way to
-- activate premium automatically from it.
--
-- Therefore the flow is deliberately:
--
--   user sees the OPay account  ->  transfers ₦20,000  ->  submits their
--   transfer reference  ->  an ADMIN confirms it  ->  GenZ+ activates
--
-- This still satisfies every security requirement in the spec, and in fact
-- makes two of them stronger than an API would:
--   * premium still cannot be obtained by changing frontend state (there is
--     still no client write path to the entitlement table);
--   * activation is still server-side and human-verified.
-- The only trade-off is that activation is immediate-on-confirmation rather
-- than immediate-on-transfer: someone has to confirm it.
--
-- UPGRADE PATH for automatic activation, when you want it:
--   a) onboard as an OPay merchant and implement their Cashier API, or
--   b) use Paystack/Flutterwave, which accept OPay as a payment method AND
--      issue per-customer virtual accounts that auto-confirm via webhook.
-- genzplus_initiate() in genzplus.sql is left in place, inert, as the seam for
-- whichever of those you choose. It is unused by the app while this file's flow
-- is in effect.
-- ============================================================


-- ------------------------------------------------------------
-- 1) PAYMENT INSTRUCTIONS — stored server-side, not hardcoded in the app
--    so the account can change without shipping a new build.
-- ------------------------------------------------------------
create table if not exists public.payment_config (
  id boolean primary key default true check (id),   -- single-row table
  provider text not null default 'opay',
  account_name text,                                 -- NULLABLE on purpose
  account_number text not null,
  amount_kobo bigint not null default 2000000,       -- ₦20,000
  period_months int not null default 2,
  instructions text,
  updated_at timestamptz not null default now()
);

alter table public.payment_config enable row level security;

-- Everyone signed in may read the instructions — they have to, in order to pay.
drop policy if exists "payment_config_read" on public.payment_config;
create policy "payment_config_read" on public.payment_config
for select to authenticated using (true);

-- No write policy: only the service role can change payment details.

-- IMPORTANT: account_name is intentionally left NULL because it was not supplied.
--    Set it before launch — users verify the name before transferring:
--      update public.payment_config set account_name = '<ACCOUNT NAME>',
--        updated_at = now() where id;
insert into public.payment_config
  (id, provider, account_name, account_number, amount_kobo, period_months, instructions)
values
  (true, 'opay', null, '8026469828', 2000000, 2,
   'Open your OPay app or bank app, transfer the exact amount to the account below, then submit the transfer reference here. GenZ+ activates once we confirm the payment.')
on conflict (id) do update
  set account_number = excluded.account_number,
      amount_kobo    = excluded.amount_kobo,
      period_months  = excluded.period_months,
      instructions   = excluded.instructions,
      updated_at     = now();


-- ------------------------------------------------------------
-- 2) SUBMISSIONS — the payer claims a transfer; an admin verifies it
-- ------------------------------------------------------------
create table if not exists public.genzplus_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  reference text not null,                 -- transfer ref / session ID the payer supplies
  amount_kobo bigint not null,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One open claim per user.
create unique index if not exists genzplus_payments_one_pending
  on public.genzplus_payments (user_id) where status = 'pending';

-- A reference can be claimed only once, so nobody can submit someone else's
-- reference (or the same transfer twice). Rejected claims release their
-- reference, so an honest user can resubmit it after a mistake.
create unique index if not exists genzplus_payments_ref_uniq
  on public.genzplus_payments (lower(btrim(reference)))
  where status <> 'rejected';

create index if not exists genzplus_payments_queue_idx
  on public.genzplus_payments (status, created_at desc);

alter table public.genzplus_payments enable row level security;

-- See your own claims.
drop policy if exists "genzplus_payments_select_own" on public.genzplus_payments;
create policy "genzplus_payments_select_own" on public.genzplus_payments
for select using (auth.uid() = user_id);

-- Claim a transfer as yourself. Status and review fields are forced, the
-- reference must be substantive, and the amount cannot be less than the price.
drop policy if exists "genzplus_payments_insert_own" on public.genzplus_payments;
create policy "genzplus_payments_insert_own" on public.genzplus_payments
for insert with check (
  auth.uid() = user_id
  and status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
  and length(btrim(reference)) >= 6
  and amount_kobo >= 2000000
);

-- NO update and NO delete policy, on purpose: a user can claim a transfer but
-- can never approve their own claim. Approval is admin-only, below.


-- ------------------------------------------------------------
-- 3) genzplus_activate — REPLACED to understand the 2-month plan
--    (same signature as genzplus.sql, so this supersedes it)
--
--    Two real bugs are fixed here versus the earlier version:
--      * an unknown plan used to fall through to `else null`, i.e. it silently
--        granted LIFETIME access. A typo would have given premium away forever.
--        Unknown plans are now refused outright.
--      * renewing early restarted the clock from today, costing the user
--        whatever time they had left. Renewal now extends from the existing
--        expiry when that is still in the future.
-- ------------------------------------------------------------
create or replace function public.genzplus_activate(
  p_user uuid,
  p_reference text,
  p_provider text,
  p_amount_kobo bigint,
  p_plan text default '2months'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
  v_base timestamptz;
begin
  if p_user is null then
    return jsonb_build_object('ok', false, 'error', 'user required');
  end if;

  -- Never activate on an underpayment. ₦20,000 floor, in kobo.
  if p_amount_kobo is null or p_amount_kobo < 2000000 then
    return jsonb_build_object(
      'ok', false,
      'error', 'amount below GenZ+ price',
      'expected_kobo', 2000000,
      'received_kobo', p_amount_kobo
    );
  end if;

  -- An unrecognised plan must never quietly mean "forever".
  if p_plan not in ('2months', 'monthly', 'yearly', 'lifetime') then
    return jsonb_build_object('ok', false, 'error', 'unknown plan', 'plan', p_plan);
  end if;

  if p_plan = 'lifetime' then
    v_expires := null;
  elsif exists (
    -- a lifetime member must not be downgraded to a dated plan by renewing
    select 1 from public.genzplus_members m
    where m.user_id = p_user and m.active and m.expires_at is null
  ) then
    v_expires := null;
  else
    v_base := greatest(
      now(),
      coalesce(
        (select m.expires_at from public.genzplus_members m where m.user_id = p_user),
        now()
      )
    );
    v_expires := case
      when p_plan = '2months' then v_base + interval '2 months'
      when p_plan = 'monthly' then v_base + interval '1 month'
      when p_plan = 'yearly'  then v_base + interval '1 year'
    end;
  end if;

  insert into public.genzplus_members
    (user_id, active, plan, amount_kobo, provider, provider_reference, expires_at, updated_at)
  values
    (p_user, true, p_plan, p_amount_kobo, p_provider, p_reference, v_expires, now())
  on conflict (user_id) do update
    set active             = true,
        plan               = excluded.plan,
        amount_kobo        = excluded.amount_kobo,
        provider           = excluded.provider,
        provider_reference = excluded.provider_reference,
        expires_at         = excluded.expires_at,
        updated_at         = now();

  return jsonb_build_object('ok', true, 'user_id', p_user, 'plan', p_plan, 'expires_at', v_expires);
end $$;

revoke all on function public.genzplus_activate(uuid, text, text, bigint, text)
  from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4) ADMIN REVIEW — the only way a claim turns into premium
--    Gated on the existing admin system (admin_center.sql), which raises
--    unauthorized / not_an_admin / permission_denied.
-- ------------------------------------------------------------
create or replace function public.genzplus_review_payment(
  p_payment uuid,
  p_approve boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
  v_row public.genzplus_payments;
  v_res jsonb;
begin
  -- Reuse the existing role gate rather than inventing a second one.
  -- A null permission means any active admin may review; pass a permission
  -- string instead once you want to restrict this to specific roles.
  begin
    v_admin := public.admin_require(null);
  exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
  end;

  select * into v_row from public.genzplus_payments where id = p_payment;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'payment not found');
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already reviewed', 'status', v_row.status);
  end if;

  if p_approve then
    select public.genzplus_activate(
             v_row.user_id,
             v_row.reference,
             'opay',
             v_row.amount_kobo,
             '2months'
           ) into v_res;

    -- `coalesce(..., false)`: a missing 'ok' key must count as FAILURE. Written
    -- as `if not (v_res->>'ok')::boolean` this would evaluate to NULL when the
    -- key were absent, `if NULL` is false, and the claim would be marked approved
    -- even though no entitlement was written.
    if coalesce((v_res ->> 'ok')::boolean, false) is not true then
      return v_res;                       -- activation refused; claim stays pending
    end if;

    update public.genzplus_payments
      set status = 'approved', review_note = p_note,
          reviewed_by = v_admin, reviewed_at = now()
      where id = p_payment;

    return jsonb_build_object('ok', true, 'approved', true, 'activation', v_res);
  end if;

  update public.genzplus_payments
    set status = 'rejected', review_note = p_note,
        reviewed_by = v_admin, reviewed_at = now()
    where id = p_payment;

  return jsonb_build_object('ok', true, 'approved', false);
end $$;

revoke all on function public.genzplus_review_payment(uuid, boolean, text)
  from public, anon;
grant execute on function public.genzplus_review_payment(uuid, boolean, text)
  to authenticated;


-- ------------------------------------------------------------
-- 5) Admin queue — read pending claims without exposing them to users
-- ------------------------------------------------------------
create or replace function public.genzplus_pending_payments(p_limit int default 100)
returns table (
  id uuid, user_id uuid, username text, reference text,
  amount_kobo bigint, note text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_admin uuid;
begin
  begin
    v_admin := public.admin_require(null);
  exception when others then
    raise exception '%', sqlerrm;
  end;

  return query
    select p.id, p.user_id, pr.username, p.reference,
           p.amount_kobo, p.note, p.created_at
    from public.genzplus_payments p
    left join public.profiles pr on pr.id = p.user_id
    where p.status = 'pending'
    order by p.created_at
    limit greatest(1, least(p_limit, 500));
end $$;

revoke all on function public.genzplus_pending_payments(int) from public, anon;
grant execute on function public.genzplus_pending_payments(int) to authenticated;


-- ============================================================
-- VERIFY AFTER RUNNING
--
--   -- instructions are visible to signed-in users:
--   select provider, account_name, account_number, amount_kobo, period_months
--   from public.payment_config;
--
--   -- the account name is STILL NULL until you set it
--
--   -- queue anything awaiting review
--   select * from public.genzplus_pending_payments();
--
--   -- approve one (as an admin):
--   select public.genzplus_review_payment('<payment-uuid>', true, 'confirmed on OPay');
--
--   -- a normal user must NOT be able to approve their own claim:
--   update public.genzplus_payments set status = 'approved' where user_id = auth.uid();
--   -- expect: RLS violation
-- ============================================================
