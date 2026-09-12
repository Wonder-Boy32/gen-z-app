
-- ============================================================
-- PART 2 — VERIFY & RESET / RECOVERY CODES / SESSIONS /
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

  select decrypted_secret into v_url from supabase_vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from supabase_vault.decrypted_secrets where name = 'auth_service_key' limit 1;
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
  for i in 1..15 loop
    perform pg_sleep(0.4);
    select body::jsonb into v_resp from net._http_response where id = v_req order by id desc limit 1;
    exit when v_resp is not null;
  end loop;

  if v_resp is null then
    return jsonb_build_object('ok', false, 'error', 'Verification timed out. Try again.');
  end if;
  if v_resp ? 'error' or (v_resp->>'access_token') is null then
    perform public._recovery_bump(p_identifier);
    return jsonb_build_object('ok', false, 'error', 'Invalid or expired code.');
  end if;

  v_token := v_resp->>'access_token';

  if p_new_password is not null then
    v_req := net.http_post(
      url := v_url || '/auth/v1/user',
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
      body := jsonb_build_object('password', p_new_password),
      timeout_milliseconds := 5000
    );
  end if;

  -- revoke ALL sessions (stolen sessions must not survive a reset)
  perform net.http_post(
    url := v_url || '/auth/v1/admin/users/' || v_user_id || '/sessions',
    headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}',
    method := 'DELETE',
    timeout_milliseconds := 5000
  );

  insert into public.security_events (user_id, event_type, metadata)
    values (v_user_id, 'password_reset', jsonb_build_object('via', p_method));
  perform public._recovery_reset(p_identifier);
  return jsonb_build_object('ok', true, 'via', p_method);
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
  select decrypted_secret into v_url from supabase_vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from supabase_vault.decrypted_secrets where name = 'auth_service_key' limit 1;
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
  select decrypted_secret into v_url from supabase_vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from supabase_vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_key is not null and v_url is not null then
    v_req := net.http_post(
      url := v_url || '/auth/v1/admin/users/' || v_uid,
      headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}', method := 'DELETE', timeout_milliseconds := 5000
    );
    for i in 1..15 loop
      perform pg_sleep(0.4);
      select body::jsonb into v_resp from net._http_response where id = v_req order by id desc limit 1;
      exit when v_resp is not null;
    end loop;
    if v_resp is null then
      return jsonb_build_object('ok', false, 'error', 'Deletion is processing — sign out and it will complete.');
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
