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
