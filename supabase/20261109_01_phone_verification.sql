-- ============================================================
-- GEN Z — phone verification becomes a server fact
--
-- Hand-run from the SQL editor, like every other file in this folder.
--
-- ------------------------------------------------------------
-- THE HOLE THIS CLOSES
-- ------------------------------------------------------------
-- profiles.phone_verified was left out of profiles_guard_protected()
-- deliberately, because the app sets it after an in-app OTP:
--
--     supabase.from('profiles')
--       .update({ phone: phone.trim(), phone_verified: true })
--
-- The database had no way to tell whether an OTP had actually happened.
-- It just accepted the write. Proven on a fresh account with no OTP --
-- one PATCH, no SMS:
--
--     before: [{"phone":null,"phone_verified":false}]
--     PATCH status: 200 rows: 1
--     after : [{"phone":"+2348000000000","phone_verified":true}]
--
-- Today the blast radius is small: recover_send_code() resolves the
-- account by username or email (account_security.sql:209-218), never by
-- phone number, so a self-asserted phone only sends codes to yourself.
-- But phone_verified gates whether "recover by phone" is offered at all
-- (account_security.sql:236-240), and it is shown to the user as a trust
-- badge. A client-writable trust column is a hole waiting for its first
-- consumer -- a second factor, an SMS security alert, a support queue.
-- Ship the lock before the feature that needs it.
--
-- ------------------------------------------------------------
-- THE FIX: STOP ASKING THE CLIENT
-- ------------------------------------------------------------
-- Supabase Auth already knows the truth. verifyOtp() writes the number to
-- auth.users.phone and stamps auth.users.phone_confirmed_at. So
-- phone_verified should never be self-reported: it is derived from that
-- timestamp by a SECURITY DEFINER function the client can call but cannot
-- forge.
--
--   1. phone + phone_verified join the protected column list, so
--      `authenticated`/`anon` writes to them are silently reverted.
--   2. link_verified_phone() copies auth.users.phone -> profiles.phone and
--      phone_verified -> true, but only when phone_confirmed_at is set.
--      Running as the owner, it is unaffected by the guard in (1).
--   3. The app calls that RPC instead of .update().
--
-- Safe to re-run: create or replace throughout, drop trigger if exists.
-- ============================================================


-- ------------------------------------------------------------
-- 1) PROTECT THE TWO COLUMNS
-- ------------------------------------------------------------
create or replace function public.profiles_guard_protected()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.id                    := old.id;
    new.created_at            := old.created_at;
    new.verified              := old.verified;
    new.lifetime_likes        := old.lifetime_likes;
    new.total_likes_received  := old.total_likes_received;
    new.account_status        := old.account_status;
    new.deactivated_at        := old.deactivated_at;
    new.deletion_requested_at := old.deletion_requested_at;
    new.invite_code           := old.invite_code;
    new.invited_by            := old.invited_by;
    -- added here: a verified phone is a claim about the real world, and the
    -- client is not a witness to it
    new.phone                 := old.phone;
    new.phone_verified        := old.phone_verified;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_protected on public.profiles;
create trigger profiles_guard_protected
  before update on public.profiles
  for each row execute function public.profiles_guard_protected();


-- The update guard above does not cover INSERT. Profile rows are only ever
-- created by handle_new_user(), a SECURITY DEFINER trigger, so a direct client
-- insert collides on the primary key -- but "cannot happen" and "is refused"
-- are different claims, and the second one is free. This only clamps the
-- verification flag; every other column keeps its own default.
create or replace function public.profiles_guard_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.phone_verified := false;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_insert on public.profiles;
create trigger profiles_guard_insert
  before insert on public.profiles
  for each row execute function public.profiles_guard_insert();


-- ------------------------------------------------------------
-- 2) MASKING HAS TO SURVIVE BOTH PHONE FORMATS
--
-- The original _mask_phone assumed a leading '+' (substr(p_phone, 2, 3)).
-- Supabase Auth stores the number WITHOUT one, so '2348000000000' masked to
-- '+348 ••••0000' -- a country code that does not exist, shown to the user at
-- the exact moment they are deciding whether to trust a recovery code.
--
-- It also embedded the bullets as literal UTF-8 bytes, which arrived in this
-- database double-encoded. chr(8226) cannot be mangled by a paste.
-- ------------------------------------------------------------
create or replace function public._mask_phone(p_phone text)
returns text language sql immutable as $$
  select case
    when p_phone is null then null
    when length(d) < 7 then p_phone
    else '+' || left(d, 3) || ' ' || repeat(chr(8226), 4) || right(d, 4)
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) s;
$$;


-- ------------------------------------------------------------
-- 3) PROMOTE WHAT AUTH ALREADY VERIFIED
--
-- The only writer of profiles.phone / .phone_verified for end users.
-- Takes no phone argument on purpose: accepting one would let the caller
-- say "link this number" again, and we are specifically not trusting the
-- caller. It reads the phone off the caller's own auth row.
-- ------------------------------------------------------------
create or replace function public.link_verified_phone()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_phone     text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select phone, phone_confirmed_at
    into v_phone, v_confirmed
    from auth.users
   where id = v_uid;

  if v_phone is null or v_confirmed is null then
    -- No OTP has been completed. Nothing is written.
    return jsonb_build_object('ok', false, 'error', 'phone_not_verified');
  end if;

  -- Stored in E.164 with the '+', which is what auth.users drops and what
  -- every surface in the app renders. Normalise on the way in rather than
  -- teaching each reader about the difference.
  v_phone := '+' || regexp_replace(v_phone, '\D', '', 'g');

  update public.profiles
     set phone          = v_phone,
         phone_verified = true
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    -- masked, so the response cannot be used to enumerate numbers
    'phone', public._mask_phone(v_phone)
  );
end $$;

revoke all on function public.link_verified_phone() from public, anon;
grant execute on function public.link_verified_phone() to authenticated;


-- ------------------------------------------------------------
-- 3) VERIFY — fail the apply, not the user
-- ------------------------------------------------------------
do $$
begin
  -- The whole design rests on this column existing. plpgsql bodies are not
  -- name-resolved at CREATE time, so a wrong column would compile and explode
  -- on the first real call instead.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'auth'
       and table_name   = 'users'
       and column_name  = 'phone_confirmed_at'
  ) then
    raise exception 'auth.users.phone_confirmed_at is missing; link_verified_phone() would fail at runtime';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'profiles_guard_protected' and not tgisinternal
  ) then
    raise exception 'profiles_guard_protected is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'profiles_guard_insert' and not tgisinternal
  ) then
    raise exception 'profiles_guard_insert is missing';
  end if;

  if not exists (
    select 1 from pg_proc
     where proname = 'link_verified_phone'
       and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'link_verified_phone() is missing';
  end if;

  -- _mask_phone is a display function, so assert its output rather than trusting
  -- it. Both formats must land on the same string; the old version turned the
  -- plus-less form into a country code that does not exist.
  if public._mask_phone('2348000000000')
     is distinct from public._mask_phone('+2348000000000') then
    raise exception '_mask_phone() disagrees between the two phone formats: % vs %',
      public._mask_phone('2348000000000'), public._mask_phone('+2348000000000');
  end if;

  if public._mask_phone('2348000000000') is distinct from
     '+' || left('2348000000000', 3) || ' ' || repeat(chr(8226), 4) || right('2348000000000', 4) then
    raise exception '_mask_phone() output is not the expected shape: %',
      public._mask_phone('2348000000000');
  end if;
end $$;


-- ------------------------------------------------------------
-- CHECK AFTER RUNNING
--
--   -- as a normal user, this must change nothing (silently reverted):
--   update public.profiles set phone_verified = true where id = auth.uid();
--   select phone, phone_verified from public.profiles where id = auth.uid();
--
--   -- and this must refuse, because no OTP has been completed:
--   select public.link_verified_phone();
--   -- -> {"ok": false, "error": "phone_not_verified"}
-- ------------------------------------------------------------
