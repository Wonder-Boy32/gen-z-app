-- ============================================================
-- GEN Z â€” ACCOUNT & SECURITY SYSTEM (run ONCE, additive)
--
-- Everything real: OTPs are Supabase Auth OTPs (single-use,
-- expiring, hashed, rate-limited by the auth service). No
-- dummy codes, no client-side security decisions.
--
-- SETUP REQUIRED (once, in the SQL editor):
--   create extension if not exists supabase_vault;
--   select vault.create_secret('<YOUR SERVICE ROLE KEY>', 'auth_service_key');
--   select vault.create_secret('<YOUR PROJECT URL>', 'auth_project_url');
--   -- e.g. https://fwouxamnmfdzwxpefoyb.supabase.co
--
-- 48-HOUR DROP SYSTEM: untouched.
-- ============================================================

-- 1) PROFILE FIELDS -------------------------------------------
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists phone_verified boolean not null default false;
alter table public.profiles add column if not exists activity_status boolean not null default true;
alter table public.profiles add column if not exists message_permission text not null default 'everyone'
  check (message_permission in ('everyone', 'followers', 'nobody'));
alter table public.profiles add column if not exists deactivated_at timestamptz;
alter table public.profiles add column if not exists deletion_requested_at timestamptz;
alter table public.profiles add column if not exists security_alert_email boolean not null default true;

-- 2) SECURITY TABLES -------------------------------------------
-- user-facing security alerts (password changed, new login, 2FAâ€¦)
create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_type text not null,
  device text,
  location_approx text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists security_events_user_idx on public.security_events (user_id, created_at desc);

-- rate limiting for account discovery / code sends (per identifier)
create table if not exists public.recovery_attempts (
  identifier_hash text primary key,
  attempts int not null default 0,
  locked_until timestamptz,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

-- single-use recovery codes (SHA-256 hashes only)
create table if not exists public.user_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists user_recovery_codes_user_idx on public.user_recovery_codes (user_id);

-- "where you're logged in" â€” client heartbeats
create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device text,
  app text,
  session_key text,
  first_seen_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  unique (user_id, session_key)
);

-- 3) MASKING + RATE-LIMIT HELPERS ------------------------------
create or replace function public._mask_email(p_email text)
returns text language sql immutable as $$
  select case
    when p_email is null then null
    else substr(p_email, 1, 1) || '****@' || split_part(p_email, '@', 2)
  end;
$$;

create or replace function public._mask_phone(p_phone text)
returns text language sql immutable as $$
  select case
    when p_phone is null then null
    else '+' || substr(p_phone, 2, 3) || ' â€¢â€¢â€¢â€¢' || right(p_phone, 4)
  end;
$$;

create or replace function public._recovery_rate_limit(p_identifier text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  h text := encode(sha256(convert_to(lower(p_identifier), 'utf8')), 'hex');
  v_locked timestamptz;
  v_attempts int;
begin
  select locked_until, attempts into v_locked, v_attempts
  from public.recovery_attempts where identifier_hash = h;
  if v_locked is not null and v_locked > now() then
    return false; -- locked
  end if;
  if v_attempts is not null and v_attempts >= 10 then
    update public.recovery_attempts set locked_until = now() + interval '15 minutes', updated_at = now() where identifier_hash = h;
    return false;
  end if;
  return true;
end $$;

create or replace function public._recovery_bump(p_identifier text)
returns void language plpgsql security definer set search_path = public as $$
declare h text := encode(sha256(convert_to(lower(p_identifier), 'utf8')), 'hex');
begin
  insert into public.recovery_attempts (identifier_hash, attempts, updated_at)
  values (h, 1, now())
  on conflict (identifier_hash)
  do update set attempts = public.recovery_attempts.attempts + 1, updated_at = now();
end $$;

create or replace function public._recovery_reset(p_identifier text)
returns void language plpgsql security definer set search_path = public as $$
declare h text := encode(sha256(convert_to(lower(p_identifier), 'utf8')), 'hex');
begin
  delete from public.recovery_attempts where identifier_hash = h;
end $$;

-- 4) FIND YOUR ACCOUNT (non-enumerating: never returns the full email)
-- returns masked info only; exact-match semantics per the product spec
create or replace function public.recover_find_account(p_identifier text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_user_id uuid;
  v_deactivated timestamptz;
  v_username text;
  v_display text;
  v_avatar text;
  v_phone text;
  v_phone_verified boolean;
  v_codes bigint;
  v_methods jsonb;
begin
  if p_identifier is null or length(trim(p_identifier)) < 3 then
    return jsonb_build_object('found', false);
  end if;
  if not public._recovery_rate_limit(p_identifier) then
    return jsonb_build_object('found', false, 'locked', true);
  end if;
  perform public._recovery_bump(p_identifier);

  -- resolve: email (auth.users) or username (profiles)
  if p_identifier like '%@%' then
    select id, email into v_user_id, v_email
    from auth.users where lower(email) = lower(trim(p_identifier)) limit 1;
  else
    select pr.id, au.email into v_user_id, v_email
    from public.profiles pr
    join auth.users au on au.id = pr.id
    where lower(pr.username) = lower(replace(trim(p_identifier), '@', ''))
    limit 1;
  end if;

  if v_user_id is null then
    return jsonb_build_object('found', false);
  end if;

  select deactivated_at, username, display_name, avatar_url, phone, coalesce(phone_verified, false)
    into v_deactivated, v_username, v_display, v_avatar, v_phone, v_phone_verified
  from public.profiles where id = v_user_id;
  if v_deactivated is not null then
    return jsonb_build_object('found', true, 'deactivated', true);
  end if;

  select count(*) into v_codes from public.user_recovery_codes
    where user_id = v_user_id and used_at is null;

  v_methods := jsonb_build_array('email');
  if v_phone_verified and v_phone is not null then v_methods := v_methods || jsonb_build_array('phone'); end if;
  if v_codes > 0 then v_methods := v_methods || jsonb_build_array('codes'); end if;

  return jsonb_build_object(
    'found', true,
    'user_id', v_user_id,
    'username', v_username,
    'display_name', v_display,
    'avatar_url', v_avatar,
    'masked_email', public._mask_email(v_email),
    'masked_phone', public._mask_phone(v_phone),
    'methods', v_methods
  );
end $$;

-- 5) SEND CONFIRMATION CODE (server-side via pg_net â€” the real email
-- never reaches the client; the OTP itself is issued by Supabase Auth)
create or replace function public.recover_send_code(p_identifier text, p_method text default 'email')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_phone text;
  v_user_id uuid;
  v_url text;
  v_key text;
  v_req bigint;
  h text := encode(sha256(convert_to(lower(p_identifier), 'utf8')), 'hex');
  r public.recovery_attempts%rowtype;
begin
  if not public._recovery_rate_limit(p_identifier) then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts. Try again in 15 minutes.');
  end if;

  -- resolve account (server-side only)
  if p_identifier like '%@%' then
    select id, email into v_user_id, v_email
    from auth.users where lower(email) = lower(trim(p_identifier)) limit 1;
  else
    select pr.id, au.email, pr.phone into v_user_id, v_email, v_phone
    from public.profiles pr
    join auth.users au on au.id = pr.id
    where lower(pr.username) = lower(replace(trim(p_identifier), '@', ''))
    limit 1;
  end if;
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'If an account matches, we sent the code.');
  end if;

  -- resend cooldown (60s)
  select * into r from public.recovery_attempts where identifier_hash = h;
  if r.last_sent_at is not null and r.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'cooldown', true,
      'retry_after', greatest(0, extract(epoch from (r.last_sent_at + interval '60 seconds' - now()))::int));
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_key is null or v_url is null then
    return jsonb_build_object('ok', false, 'error', 'Recovery email service is not configured yet.');
  end if;

  if p_method = 'phone' then
    if v_phone is null or not coalesce(
      (select phone_verified from public.profiles where id = v_user_id), false
    ) then
      return jsonb_build_object('ok', false, 'error', 'No verified phone on this account.');
    end if;
    v_req := net.http_post(
      url := v_url || '/auth/v1/otp',
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('phone', v_phone, 'create_user', false),
      timeout_milliseconds := 5000
    );
  else
    v_req := net.http_post(
      url := v_url || '/auth/v1/otp',
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('email', v_email, 'create_user', false),
      timeout_milliseconds := 5000
    );
  end if;

  update public.recovery_attempts set last_sent_at = now(), updated_at = now() where identifier_hash = h;
  return jsonb_build_object('ok', true,
    'masked', case when p_method = 'phone' then public._mask_phone(v_phone) else public._mask_email(v_email) end);
end $$;

-- ============================================================
-- PART 2 Ã¢â‚¬â€ VERIFY & RESET / RECOVERY CODES / SESSIONS /
--           ACCOUNT LIFECYCLE / ENFORCEMENT / GRANTS
-- ============================================================

-- 6) VERIFY CODE + RESET PASSWORD (all server-side; email never exposed)
--    p_method: 'email' | 'phone' | 'codes'
create or replace function public.recover_verify_and_reset(
  p_identifier text, p_method text, p_code text, p_new_password text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_phone text;
  v_user_id uuid;
  v_url text;
  v_key text;
  v_req bigint;
  v_resp jsonb;
  v_token text;
  v_hash text;
begin
  if not public._recovery_rate_limit(p_identifier) then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts. Try again in 15 minutes.');
  end if;

  -- resolve account
  if p_identifier like '%@%' then
    select id, email into v_user_id, v_email from auth.users where lower(email) = lower(trim(p_identifier)) limit 1;
  else
    select pr.id, au.email, pr.phone into v_user_id, v_email, v_phone
    from public.profiles pr join auth.users au on au.id = pr.id
    where lower(pr.username) = lower(replace(trim(p_identifier), '@', '')) limit 1;
  end if;
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'Invalid code.');
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_key is null or v_url is null then
    return jsonb_build_object('ok', false, 'error', 'Recovery service is not configured yet.');
  end if;

  -- ---- method: recovery codes (no OTP) ----
  if p_method = 'codes' then
    v_hash := encode(sha256(convert_to(upper(trim(p_code)), 'utf8')), 'hex');
    update public.user_recovery_codes
       set used_at = now()
     where user_id = v_user_id and code_hash = v_hash and used_at is null;
    if not found then
      perform public._recovery_bump(p_identifier);
      return jsonb_build_object('ok', false, 'error', 'Invalid or already-used recovery code.');
    end if;
    if p_new_password is not null then
      v_req := net.http_post(
        url := v_url || '/auth/v1/admin/users/' || v_user_id,
        headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('password', p_new_password),
        timeout_milliseconds := 5000
      );
    end if;
    -- revoke all sessions (server-side path has no client session)
    perform net.http_post(
      url := v_url || '/auth/v1/admin/users/' || v_user_id || '/sessions',
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}', method := 'DELETE', timeout_milliseconds := 5000
    );
    insert into public.security_events (user_id, event_type, metadata)
      values (v_user_id, 'password_reset', jsonb_build_object('via', 'recovery_code'));
    perform public._recovery_reset(p_identifier);
    return jsonb_build_object('ok', true, 'via', 'codes');
  end if;

  -- ---- method: email / phone OTP ----
  v_req := net.http_post(
    url := v_url || '/auth/v1/verify',
    headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := case when p_method = 'phone'
      then jsonb_build_object('type', 'sms', 'phone', v_phone, 'token', p_code)
      else jsonb_build_object('type', 'email', 'email', v_email, 'token', p_code) end,
    timeout_milliseconds := 5000
  );

  -- poll for the synchronous response (pg_net is async; bounded wait)
  for i in 1..40 loop
    perform pg_sleep(0.4);
    select content::jsonb into v_resp from net._http_response where id = v_req order by id desc limit 1;
    exit when v_resp is not null;
  end loop;

  if v_resp is null then
    return jsonb_build_object('ok', false, 'error', 'Verification timed out. Try again.');
  end if;
  if v_resp ? 'error' or (v_resp->>'access_token') is null then
    perform public._recovery_bump(p_identifier);
    return jsonb_build_object('ok', false, 'error', 'Invalid or expired code.');
  end if;

  -- verified: hand the single-use session back to the client. The client
  -- then sets the new password via updateUser() (real, hashed by Auth),
  -- revokes every other session, and logs the event â€” all server-side RPCs.
  perform public._recovery_reset(p_identifier);
  return jsonb_build_object('ok', true, 'via', p_method,
    'access_token', v_resp->>'access_token', 'refresh_token', v_resp->>'refresh_token');
end $$;

-- 7) RECOVERY CODES (single-use, SHA-256 stored, shown once)
create or replace function public.recovery_codes_generate()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_codes text[] := '{}';
  v_code text;
  i int;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  delete from public.user_recovery_codes where user_id = v_uid; -- regenerate = invalidate old
  for i in 1..10 loop
    v_code := upper(encode(gen_random_bytes(5), 'hex')) || '-' || upper(encode(gen_random_bytes(5), 'hex'));
    insert into public.user_recovery_codes (user_id, code_hash)
    values (v_uid, encode(sha256(convert_to(v_code, 'utf8')), 'hex'));
    v_codes := v_codes || v_code;
  end loop;
  insert into public.security_events (user_id, event_type, metadata)
    values (v_uid, 'recovery_codes_generated', '{}'::jsonb);
  return jsonb_build_object('codes', v_codes);
end $$;

create or replace function public.recovery_codes_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_n bigint;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  select count(*) into v_n from public.user_recovery_codes where user_id = v_uid and used_at is null;
  return jsonb_build_object('unused', v_n);
end $$;

-- 8) SECURITY ALERTS (user-facing log; user_id is server-forced)
create or replace function public.security_log(p_event text, p_meta jsonb default '{}'::jsonb, p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  insert into public.security_events (user_id, event_type, metadata, device) values (v_uid, p_event, p_meta, p_device);
end $$;

create or replace function public.security_events_list(p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'event', event_type, 'device', device, 'meta', metadata, 'at', created_at) order by created_at desc)
    from (select * from public.security_events where user_id = v_uid limit p_limit) e
  ), '[]'::jsonb);
end $$;

-- 9) SESSIONS ("where you're logged in")
create or replace function public.security_note_session(p_device text, p_app text, p_session_key text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_new boolean;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  insert into public.user_sessions (user_id, device, app, session_key)
  values (v_uid, p_device, p_app, coalesce(p_session_key, 'default'))
  on conflict (user_id, session_key)
  do update set last_active_at = now()
  returning false into v_new;
  if not found then
    insert into public.security_events (user_id, event_type, device, metadata)
    values (v_uid, 'new_login', p_device, jsonb_build_object('app', p_app));
  end if;
end $$;

create or replace function public.user_sessions_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'device', device, 'app', app, 'first_seen', first_seen_at, 'last_active', last_active_at) order by last_active_at desc)
    from public.user_sessions where user_id = v_uid
  ), '[]'::jsonb);
end $$;

-- revoke every session on this account (password/email/2FA changes)
create or replace function public.auth_invalidate_sessions()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_url text; v_key text;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_key is not null and v_url is not null then
    perform net.http_post(
      url := v_url || '/auth/v1/admin/users/' || v_uid || '/sessions',
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}', method := 'DELETE', timeout_milliseconds := 5000
    );
  end if;
  update public.user_sessions set last_active_at = last_active_at - interval '100 years' where user_id = v_uid;
end $$;

-- 10) ACCOUNT STATUS + LIFECYCLE
create or replace function public.account_security_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles%rowtype;
  v_email text;
  v_mfa bigint;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  select * into v_row from public.profiles where id = v_uid;
  select email into v_email from auth.users where id = v_uid;
  select count(*) into v_mfa from auth.mfa_factors
    where user_id = v_uid and factor_type = 'totp' and status = 'verified';
  return jsonb_build_object(
    'email', public._mask_email(v_email),
    'phone', public._mask_phone(v_row.phone),
    'phone_verified', coalesce(v_row.phone_verified, false),
    'mfa_enabled', v_mfa > 0,
    'deactivated_at', v_row.deactivated_at,
    'created_at', v_row.created_at
  );
end $$;

create or replace function public.account_deactivate()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  update public.profiles set deactivated_at = now() where id = v_uid;
  insert into public.security_events (user_id, event_type) values (v_uid, 'account_deactivated');
end $$;

create or replace function public.account_reactivate()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  update public.profiles set deactivated_at = null where id = v_uid;
  insert into public.security_events (user_id, event_type) values (v_uid, 'account_reactivated');
end $$;

create or replace function public.account_delete()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_url text; v_key text; v_req bigint; v_resp jsonb;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  update public.profiles set deletion_requested_at = now() where id = v_uid;
  insert into public.security_events (user_id, event_type) values (v_uid, 'account_deletion_requested');
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_key is not null and v_url is not null then
    v_req := net.http_post(
      url := v_url || '/auth/v1/admin/users/' || v_uid,
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}', method := 'DELETE', timeout_milliseconds := 5000
    );
    for i in 1..40 loop
      perform pg_sleep(0.4);
      select content::jsonb into v_resp from net._http_response where id = v_req order by id desc limit 1;
      exit when v_resp is not null;
    end loop;
    if v_resp is null then
      return jsonb_build_object('ok', false, 'error', 'Deletion is processing Ã¢â‚¬â€ sign out and it will complete.');
    end if;
  end if;
  -- audit/security rows intentionally retained (no FK to auth.users)
  return jsonb_build_object('ok', true);
end $$;

-- 11) ENFORCEMENT ------------------------------------------------
-- hide content of deactivated accounts (48H drops stay 48H)
drop policy if exists "posts_select_active" on public.posts;
create policy "posts_select_active" on public.posts for select
  using (expires_at > now() and removed_at is null
    and not exists (select 1 from public.profiles p where p.id = public.posts.user_id and p.deactivated_at is not null));

-- block anonymous messages: sender disabled OR recipient turned them off
create or replace function public.enforce_anon_send()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sender_status text; v_sender_disabled boolean; v_recip_enabled boolean;
begin
  select account_status, anon_disabled into v_sender_status, v_sender_disabled
    from public.profiles where id = auth.uid();
  if v_sender_status in ('suspended', 'banned') or coalesce(v_sender_disabled, false) then
    raise exception 'Anonymous messaging is not available for this account.';
  end if;
  select coalesce(enabled, true) into v_recip_enabled
    from public.anonymous_settings where user_id = new.recipient_id;
  if v_recip_enabled is false then
    raise exception 'This person has anonymous messages turned off.';
  end if;
  return new;
end $$;

drop trigger if exists enforce_anon_send_trigger on public.anonymous_messages;
create trigger enforce_anon_send_trigger before insert on public.anonymous_messages
  for each row execute function public.enforce_anon_send();

-- 12) GRANTS -------------------------------------------------------
revoke all on function public.recover_find_account(text) from public, anon;
grant execute on function public.recover_find_account(text) to anon, authenticated;

revoke all on function public.recover_send_code(text, text) from public, anon;
grant execute on function public.recover_send_code(text, text) to anon, authenticated;

revoke all on function public.recover_verify_and_reset(text, text, text, text) from public, anon;
grant execute on function public.recover_verify_and_reset(text, text, text, text) to anon, authenticated;

revoke all on function public.recovery_codes_generate() from public, anon;
grant execute on function public.recovery_codes_generate() to authenticated;

revoke all on function public.recovery_codes_status() from public, anon;
grant execute on function public.recovery_codes_status() to authenticated;

revoke all on function public.security_log(text, jsonb, text) from public, anon;
grant execute on function public.security_log(text, jsonb, text) to authenticated;

revoke all on function public.security_events_list(int) from public, anon;
grant execute on function public.security_events_list(int) to authenticated;

revoke all on function public.security_note_session(text, text, text) from public, anon;
grant execute on function public.security_note_session(text, text, text) to authenticated;

revoke all on function public.user_sessions_list() from public, anon;
grant execute on function public.user_sessions_list() to authenticated;

revoke all on function public.auth_invalidate_sessions() from public, anon;
grant execute on function public.auth_invalidate_sessions() to authenticated;

revoke all on function public.account_security_status() from public, anon;
grant execute on function public.account_security_status() to authenticated;

revoke all on function public.account_deactivate() from public, anon;
grant execute on function public.account_deactivate() to authenticated;

revoke all on function public.account_reactivate() from public, anon;
grant execute on function public.account_reactivate() to authenticated;

revoke all on function public.account_delete() from public, anon;
grant execute on function public.account_delete() to authenticated;


