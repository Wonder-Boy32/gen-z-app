-- ============================================================
-- GenZ+ — premium entitlement
--
-- Depends on: schema.sql (profiles)
-- Hand-run like the other files in this folder; there is no migration runner.
--
-- ------------------------------------------------------------
-- THE THREE RULES THIS FILE EXISTS TO ENFORCE
-- ------------------------------------------------------------
--   1. Premium is a BACKEND fact, never a frontend flag.
--   2. A user must not be able to grant themselves premium by writing to the
--      database directly. (This is why there is no client write policy.)
--   3. Payment secrets never reach the app bundle.
--
-- HOW THIS FITS THE EXISTING ARCHITECTURE
-- This app already keeps server-side secrets in Supabase Vault and calls
-- external HTTP APIs from SECURITY DEFINER functions via pg_net — see
-- account_security.sql and pg_net_fix.sql, which do exactly that for
-- password-reset email. The payment provider key is expected in Vault and is
-- only ever read *inside* a SECURITY DEFINER function, so it cannot be
-- extracted from the mobile bundle.
--
-- ============================================================
-- SETUP (do this once, from the Supabase SQL editor — never from the app)
-- ============================================================
--   -- 1. store the provider key server-side
--   select vault.create_secret('<YOUR_PROVIDER_SECRET_KEY>', 'genzplus_provider_secret');
--
--   -- 2. choose the provider ('paystack' | 'flutterwave' | anything you wire up)
--   select vault.create_secret('paystack', 'genzplus_provider');
--
-- Until BOTH of those exist, genzplus_initiate() below returns an explicit
-- not_configured error and NOTHING can be charged. That is deliberate: the
-- payment path ships inert rather than pretending to work.
-- ============================================================


-- ------------------------------------------------------------
-- 1) ENTITLEMENT — the single source of truth
-- ------------------------------------------------------------
create table if not exists public.genzplus_members (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  active boolean not null default true,
  plan text not null default 'lifetime',
  amount_kobo bigint not null,                 -- ₦20,000 = 2,000,000 kobo
  currency text not null default 'NGN',
  provider text,                               -- 'paystack' | 'flutterwave' | ...
  provider_reference text,                     -- the provider's transaction ref
  purchased_at timestamptz not null default now(),
  expires_at timestamptz,                      -- null = lifetime
  updated_at timestamptz not null default now()
);

create index if not exists genzplus_members_active_idx
  on public.genzplus_members (active) where active;

-- One provider transaction must never be able to activate two accounts.
create unique index if not exists genzplus_members_ref_uniq
  on public.genzplus_members (provider, provider_reference)
  where provider_reference is not null;

alter table public.genzplus_members enable row level security;

-- Read your OWN entitlement — this is what the app displays to you.
drop policy if exists "genzplus_select_own" on public.genzplus_members;
create policy "genzplus_select_own" on public.genzplus_members
for select using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- NO insert / update / delete policy, on purpose.
--
-- With RLS enabled and no write policy, NO authenticated client can insert or
-- alter an entitlement row. Only the service role and SECURITY DEFINER
-- functions below can. This is the mechanism that makes "just change the
-- frontend state and you're premium" impossible: there is nothing the client
-- can write to.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 2) PUBLIC BADGE DATA
-- Deliberately a VIEW, so the badge can be shown on other people's profiles
-- without exposing what anyone paid, which provider they used, or their
-- transaction reference. Only user_id + dates leave this table.
-- (Postgres evaluates the view as its owner, so it bypasses the base-table RLS
-- above while still exposing only these three non-sensitive columns.)
-- ------------------------------------------------------------
create or replace view public.genzplus_badge as
  select user_id, purchased_at, expires_at
  from public.genzplus_members
  where active
    and (expires_at is null or expires_at > now());

grant select on public.genzplus_badge to anon, authenticated;


-- ------------------------------------------------------------
-- 3) IS THIS USER PREMIUM RIGHT NOW?
-- Single source of truth, so future features gate on ONE definition instead of
-- re-implementing the expiry rule in each place (and drifting).
-- ------------------------------------------------------------
create or replace function public.genzplus_is_active(p_user uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.genzplus_members m
    where m.user_id = coalesce(p_user, auth.uid())
      and m.active
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

grant execute on function public.genzplus_is_active(uuid) to anon, authenticated;


-- ------------------------------------------------------------
-- 4) ACTIVATION — the ONLY writer of the entitlement table
-- SECURITY DEFINER and revoked from clients, so it can only be reached from the
-- server-side verification path (service role, or another SECURITY DEFINER
-- function that has itself verified a payment with the provider).
-- ------------------------------------------------------------
create or replace function public.genzplus_activate(
  p_user uuid,
  p_reference text,
  p_provider text,
  p_amount_kobo bigint,
  p_plan text default 'lifetime'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expires timestamptz;
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

  v_expires := case
    when p_plan = 'yearly'  then now() + interval '1 year'
    when p_plan = 'monthly' then now() + interval '1 month'
    else null                                            -- lifetime
  end;

  insert into public.genzplus_members
    (user_id, active, plan, amount_kobo, provider, provider_reference, expires_at, updated_at)
  values
    (p_user, true, coalesce(p_plan, 'lifetime'), p_amount_kobo,
     p_provider, p_reference, v_expires, now())
  on conflict (user_id) do update
    set active             = true,
        plan               = excluded.plan,
        amount_kobo        = excluded.amount_kobo,
        provider           = excluded.provider,
        provider_reference = excluded.provider_reference,
        expires_at         = excluded.expires_at,
        updated_at         = now();

  return jsonb_build_object('ok', true, 'user_id', p_user, 'expires_at', v_expires);
end $$;

revoke all on function public.genzplus_activate(uuid, text, text, bigint, text)
  from public, anon, authenticated;


-- ------------------------------------------------------------
-- 5) INITIATE A PURCHASE (the payment seam)
--
-- Reads the provider key from Vault server-side and hands back a checkout URL.
-- Returns an explicit error — never a fake success — until both the Vault
-- secrets exist AND a provider call is implemented.
--
-- ⚠️ THE ONLY PROVIDER-SPECIFIC CODE IN THIS FILE IS THE SEAM MARKED BELOW.
--    Add the provider's "initialize transaction" call there using
--    net.http_post, following the pattern in pg_net_fix.sql:
--      v_req := net.http_post(
--        url     := 'https://api.paystack.co/transaction/initialize',
--        headers := jsonb_build_object(
--                     'Authorization', 'Bearer ' || v_secret,
--                     'Content-Type',  'application/json'),
--        body    := jsonb_build_object(
--                     'email',  v_email,
--                     'amount', 2000000,
--                     'metadata', jsonb_build_object('user_id', v_user,
--                                                    'purpose', 'genzplus')));
--    then read the authorization_url back out of net._http_response.
--
--    Verification MUST be server-side too (a webhook, or a
--    /transaction/verify call) before genzplus_activate() is invoked — the
--    client must never be trusted to report that it paid.
-- ------------------------------------------------------------
create or replace function public.genzplus_initiate()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_provider text;
  v_secret   text;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  -- Already premium? Don't sell it twice.
  if public.genzplus_is_active(v_user) then
    return jsonb_build_object('ok', false, 'error', 'already_active');
  end if;

  select decrypted_secret into v_provider
    from vault.decrypted_secrets where name = 'genzplus_provider';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'genzplus_provider_secret';

  if v_provider is null or v_secret is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_configured',
      'detail', 'GenZ+ payments are not live yet. Add genzplus_provider and '
                'genzplus_provider_secret to Supabase Vault to enable them.'
    );
  end if;

  -- ==== PROVIDER SEAM — implement the initialize call here ================
  -- Until this is implemented we refuse explicitly rather than charging anyone
  -- or returning a checkout URL that would not work.
  return jsonb_build_object(
    'ok', false,
    'error', 'provider_not_implemented',
    'detail', format('Provider %L is configured but no server-side initialize '
                     'call is implemented yet.', v_provider)
  );
  -- ========================================================================
end $$;

grant execute on function public.genzplus_initiate() to authenticated;


-- ============================================================
-- VERIFY AFTER RUNNING
--
--   -- RLS on, and exactly ONE policy (read-own). No write policy should exist.
--   select policyname, cmd from pg_policies where tablename = 'genzplus_members';
--
--   -- must return false for a normal user, and the client cannot change that
--   select public.genzplus_is_active();
--
--   -- as an authenticated user, this MUST fail with an RLS violation:
--   insert into public.genzplus_members (user_id, amount_kobo)
--   values (auth.uid(), 2000000);
-- ============================================================
