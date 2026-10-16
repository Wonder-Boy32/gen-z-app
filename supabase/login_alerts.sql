-- ============================================================
-- GEN Z -- NEW SIGN-IN ALERTS (device name + location)
-- Run this whole file once in the Supabase SQL editor.
--
-- WHAT THIS ADDS
--   When an account signs in from a device (or a place) it has not been seen
--   from before, every OTHER device that is signed in is alerted immediately:
--
--     New sign-in
--     Infinix HOT 30 . Lagos, Nigeria . 102.89.44.7
--
--   The row also lands in the Activity list on every device, so the alert is
--   visible in-app as well as in the phone's notification bar.
--
-- WHY THE SERVER DECIDES, NOT THE APP
--   The device name, city and country travel up from the client, but the IP
--   address does NOT. It is read from the request headers on the server
--   (request.headers -> x-forwarded-for), the same way admin_center.sql records
--   admin logins. A modified client can lie about its city; it cannot lie about
--   the IP its request arrived from, so the alert always shows one value the
--   client cannot forge.
--
-- WHERE LOCATION COMES FROM
--   IP geolocation (city-level), resolved on the device against a public
--   no-key endpoint and sent up with the sign-in. There is no GPS call and no
--   location permission anywhere in this feature, so nothing here ever prompts
--   the user. City-level is the same accuracy the "new sign-in" emails people
--   already know from Google and Meta use, and it is the right granularity for
--   answering "was this me?".
-- ============================================================

-- ------------------------------------------------------------
-- 1) user_sessions gains the device + location detail
-- ------------------------------------------------------------
alter table public.user_sessions
  add column if not exists platform     text,
  add column if not exists app_version  text,
  add column if not exists ip           text,
  add column if not exists city         text,
  add column if not exists region       text,
  add column if not exists country      text,
  add column if not exists country_code text,
  add column if not exists isp          text,
  add column if not exists location_at  timestamptz;

create index if not exists user_sessions_device_idx on public.user_sessions (user_id, device);

-- This table was created without row level security, which was survivable while
-- it held nothing but a device label. It now holds an IP address and a
-- location, so it must not be reachable directly from a client at all. Every
-- read and every write already goes through a SECURITY DEFINER function below,
-- and those run as the table owner (which is not subject to its own RLS), so
-- enabling this changes no app behaviour -- it only closes direct access.
alter table public.user_sessions enable row level security;
revoke all on public.user_sessions from anon, authenticated;

-- ------------------------------------------------------------
-- 2) notifications can carry a login alert
-- ------------------------------------------------------------
-- The type check predates this feature. Drop it by DISCOVERY rather than by a
-- guessed name, then re-add it widened: additive only, so every existing type
-- keeps working and nothing already stored is invalidated.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.notifications'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%type%'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;

-- NOTE: the previous constraint omitted comment_like / anon_message / call /
-- upload, so those inserts could already have been rejected. The list below is
-- the full set of types the app actually writes.
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'follow', 'like', 'comment', 'reply', 'reaction', 'repost',
    'comment_like', 'anon_message', 'call', 'upload', 'new_login'
  ));

-- Structured detail for alerts that have no actor to describe: for a sign-in
-- the "who" is the account owner, so the useful facts are what and where.
alter table public.notifications add column if not exists meta jsonb;

create index if not exists notifications_user_type_idx
  on public.notifications (user_id, type, created_at desc);

-- ------------------------------------------------------------
-- 3) push delivery that can skip the device that just signed in
-- ------------------------------------------------------------
-- The existing send_push_to_user() fans out to every enabled token. That is
-- exactly wrong here: the phone that just signed in must not be told that
-- "another device" signed in. Same batched request, one token excluded.
create or replace function public.send_push_to_user_except(
  p_user_id uuid,
  p_message jsonb,
  p_exclude_token text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_messages jsonb;
begin
  select jsonb_agg(p_message || jsonb_build_object('to', t.token))
    into v_messages
    from public.push_tokens t
   where t.user_id = p_user_id
     and t.enabled
     and (p_exclude_token is null or t.token <> p_exclude_token);

  if v_messages is null or jsonb_array_length(v_messages) = 0 then
    return;
  end if;

  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json'),
    body := v_messages,
    timeout_milliseconds := 5000
  );
end $$;

revoke all on function public.send_push_to_user_except(uuid, jsonb, text) from public;

-- ------------------------------------------------------------
-- 4) the sign-in report
-- ------------------------------------------------------------
-- Called once per genuine sign-in (never on app start, resume or token
-- refresh). It records the session, decides whether this is a device or a place
-- the account has not been seen from before, and alerts the other devices if
-- there are any.
--
-- "Another device" is decided by session_key, which the app stores per install:
-- signing back in on the same phone is not a new device, a second phone always
-- is. Novelty is judged BEFORE this session is written, otherwise every
-- sign-in would look like a device the account already knows.
create or replace function public.register_signin(
  p_session_key   text,
  p_device        text,
  p_platform      text default null,
  p_app_version   text default null,
  p_city          text default null,
  p_region        text default null,
  p_country       text default null,
  p_country_code  text default null,
  p_isp           text default null,
  p_current_token text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_key text := coalesce(nullif(trim(coalesce(p_session_key, '')), ''), 'default');
  v_ip text;
  v_new_device boolean := false;
  v_new_place boolean := false;
  v_other_devices int := 0;
  v_other_tokens int := 0;
  v_place text;
  v_alerted boolean := false;
begin
  if v_uid is null then raise exception 'unauthorized'; end if;

  -- The one value the client cannot fake. x-forwarded-for is a comma-separated
  -- chain (client, then any proxies); the first entry is the origin. Wrapped
  -- because a direct connection may carry no header at all, and a missing
  -- setting must not abort the sign-in.
  begin
    v_ip := nullif(current_setting('request.headers', true), '')::jsonb->>'x-forwarded-for';
  exception when others then
    v_ip := null;
  end;
  v_ip := nullif(trim(split_part(coalesce(v_ip, ''), ',', 1)), '');

  -- Only sessions seen recently count. A phone that last signed in two months
  -- ago is not "still logged in somewhere", and letting it count would both
  -- produce alerts nobody needs and keep a stale row suppressing a real one.
  -- auth_invalidate_sessions() pushes last_active_at 100 years into the past,
  -- so revoked sessions drop out here for free.
  select not exists (
    select 1 from public.user_sessions
     where user_id = v_uid and session_key = v_key
       and last_active_at > now() - interval '60 days'
  ) into v_new_device;

  -- Only meaningful when we actually know where this sign-in is from; a failed
  -- lookup must not read as "new place" and cry wolf on every sign-in.
  if p_city is not null or p_country is not null then
    select not exists (
      select 1 from public.user_sessions
       where user_id = v_uid
         and session_key <> v_key
         and last_active_at > now() - interval '60 days'
         and city is not null
         and lower(city) = lower(coalesce(p_city, ''))
         and coalesce(country_code, '') = coalesce(p_country_code, '')
    ) into v_new_place;
  end if;

  select count(*) into v_other_devices
    from public.user_sessions
   where user_id = v_uid and session_key <> v_key
     and last_active_at > now() - interval '60 days';

  select count(*) into v_other_tokens
    from public.push_tokens
   where user_id = v_uid
     and enabled
     and (p_current_token is null or token <> p_current_token);

  insert into public.user_sessions
    (user_id, device, app, app_version, session_key, platform, ip,
     city, region, country, country_code, isp, location_at)
  values
    (v_uid, p_device, 'Gen Z', p_app_version, v_key, p_platform, v_ip,
     p_city, p_region, p_country, p_country_code, p_isp,
     case when p_city is not null or p_country is not null then now() else null end)
  on conflict (user_id, session_key) do update
     set device         = coalesce(excluded.device, public.user_sessions.device),
         app_version    = coalesce(excluded.app_version, public.user_sessions.app_version),
         platform       = coalesce(excluded.platform, public.user_sessions.platform),
         ip             = coalesce(excluded.ip, public.user_sessions.ip),
         city           = coalesce(excluded.city, public.user_sessions.city),
         region         = coalesce(excluded.region, public.user_sessions.region),
         country        = coalesce(excluded.country, public.user_sessions.country),
         country_code   = coalesce(excluded.country_code, public.user_sessions.country_code),
         isp            = coalesce(excluded.isp, public.user_sessions.isp),
         location_at    = coalesce(excluded.location_at, public.user_sessions.location_at),
         last_active_at = now();

  v_place := nullif(concat_ws(', ',
               nullif(trim(coalesce(p_city, '')), ''),
               nullif(trim(coalesce(p_country, '')), '')), '');

  -- Only alert when someone else can actually be told. A first-ever sign-in has
  -- no other device, and telling the phone you just picked up that "someone
  -- signed in on another device" would be nonsense.
  if (v_new_device or v_new_place) and v_other_devices > 0 then

    insert into public.notifications (user_id, actor_id, type, meta)
    values (v_uid, v_uid, 'new_login',
            jsonb_build_object(
              'device',       p_device,
              'platform',     p_platform,
              'ip',           v_ip,
              'city',         p_city,
              'region',       p_region,
              'country',      p_country,
              'country_code', p_country_code,
              'isp',          p_isp,
              'new_device',   v_new_device,
              'new_location', v_new_place,
              'at',           now()
            ));

    -- The row above is deliberately self-addressed. The generic notifications
    -- trigger skips it (it never pushes a user about their own action), so this
    -- is the only push sent for this event, and only to the other devices.
    if v_other_tokens > 0 then
      perform public.send_push_to_user_except(
        v_uid,
        jsonb_build_object(
          'title',     'New sign-in',
          'body',      concat_ws(' . ',
                         nullif(trim(coalesce(p_device, '')), ''),
                         v_place,
                         v_ip),
          'sound',     'default',
          'channelId', 'default',
          'priority',  'high',
          'data',      jsonb_build_object('type', 'new_login', 'link', 'genz://activity')
        ),
        p_current_token
      );
    end if;

    -- Audit trail for the Security alerts screen. NOTE: this is the code path
    -- the original security_note_session() intended but never reached -- its
    -- "if not found" test can never be true after a RETURNING clause, so
    -- 'new_login' events have never actually been recorded until now.
    insert into public.security_events (user_id, event_type, device, metadata)
    values (v_uid, 'new_login', p_device,
            jsonb_build_object(
              'ip',           v_ip,
              'city',         p_city,
              'country',      p_country,
              'new_device',   v_new_device,
              'new_location', v_new_place
            ));

    v_alerted := true;
  end if;

  return jsonb_build_object(
    'ok',            true,
    'new_device',    v_new_device,
    'new_location',  v_new_place,
    'alerted',       v_alerted,
    'other_devices', v_other_devices,
    'ip',            v_ip,
    'device',        p_device
  );
end $$;

revoke all on function public.register_signin(text, text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.register_signin(text, text, text, text, text, text, text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 5) "Where you're logged in" now reports the location too
-- ------------------------------------------------------------
create or replace function public.user_sessions_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',            id,
             'device',        device,
             'app',           app,
             'platform',      platform,
             'ip',            ip,
             'city',          city,
             'region',        region,
             'country',       country,
             'country_code',  country_code,
             'isp',           isp,
             'location_at',   location_at,
             'first_seen',    first_seen_at,
             'last_active',   last_active_at
           ) order by last_active_at desc)
    from public.user_sessions where user_id = v_uid
  ), '[]'::jsonb);
end $$;

-- create or replace keeps the existing grants, but state them so this file is
-- also correct if it is ever run on a fresh database.
grant execute on function public.user_sessions_list() to authenticated;
grant execute on function public.security_note_session(text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 6) verify
-- ------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_name = 'user_sessions'
 order by ordinal_position;

select pg_get_constraintdef(oid) as notifications_type_check
  from pg_constraint
 where conrelid = 'public.notifications'::regclass
   and contype = 'c';
