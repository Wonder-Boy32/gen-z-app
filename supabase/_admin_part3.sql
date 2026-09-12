
-- ============================================================
-- PART 3 — PULSE / ANALYTICS / REGIONS / DISCOVERY / ADMINS /
--           ENFORCEMENT / FINAL SECURITY
-- ============================================================

-- ------------------------------------------------------------
-- 15) 48H PULSE — monitors the temporary-content ecosystem.
--     READ-ONLY: nothing here touches expires_at.
-- ------------------------------------------------------------
create or replace function public.admin_pulse()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('pulse.view');
  select jsonb_build_object(
    'active_drops', (select count(*) from public.posts where expires_at > now() and removed_at is null),
    'rising_drops', (select count(*) from public.posts
        where created_at > now() - interval '24 hours' and expires_at > now() and removed_at is null
          and (likes_count + comments_count) > 0),
    'new_drops', (select count(*) from public.posts where created_at::date = current_date and removed_at is null),
    'expiring_6h', (select count(*) from public.posts where expires_at between now() and now() + interval '6 hours' and removed_at is null),
    'expiring_1h', (select count(*) from public.posts where expires_at between now() and now() + interval '1 hour' and removed_at is null),
    'expired_today', (select count(*) from public.posts where expires_at::date = current_date and expires_at <= now()),
    'total_views', (select count(*) from public.post_views),
    'total_interactions', (select count(*) from public.likes) + (select count(*) from public.comments)
      + (select count(*) from public.reposts) + (select count(*) from public.saved_posts),
    'top_rising', coalesce((select jsonb_agg(t) from (
      select po.id, pr.username as creator, po.caption, po.likes_count, po.comments_count,
             (select count(*) from public.post_views pv where pv.post_id = po.id) as views
      from public.posts po join public.profiles pr on pr.id = po.user_id
      where po.expires_at > now() and po.removed_at is null
      order by (po.likes_count + po.comments_count) desc limit 10) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_pulse() from public, anon;
grant execute on function public.admin_pulse() to authenticated;

-- ------------------------------------------------------------
-- 16) OVERVIEW — headline numbers (all real backend counts)
-- ------------------------------------------------------------
create or replace function public.admin_stats_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('dashboard.view');
  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles),
    'active_users', (select count(*) from public.profiles where last_seen_at > now() - interval '24 hours'),
    'active_drops', (select count(*) from public.posts where expires_at > now() and removed_at is null),
    'drops_today', (select count(*) from public.posts where created_at::date = current_date),
    'expiring_soon', (select count(*) from public.posts where expires_at between now() and now() + interval '6 hours' and removed_at is null),
    'messages_today', (select count(*) from public.messages where created_at::date = current_date),
    'anon_today', (select count(*) from public.anonymous_messages where created_at::date = current_date),
    'pending_reports',
      (select count(*) from public.reports where status = 'open')
      + (select count(*) from public.anonymous_reports where status = 'open')
      + (select count(*) from public.chat_reports where status = 'open')
  ) into v;
  return v;
end $$;

revoke all on function public.admin_stats_overview() from public, anon;
grant execute on function public.admin_stats_overview() to authenticated;

-- ------------------------------------------------------------
-- 17) ANALYTICS — time-series (real activity from real tables)
-- ------------------------------------------------------------
create or replace function public.admin_analytics_series(p_days int default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('analytics.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    with days as (
      select generate_series(current_date - (p_days - 1), current_date, interval '1 day')::date as d
    )
    select d.d as day,
      (select count(*) from public.profiles pr where pr.created_at::date = d.d) as new_users,
      (select count(*) from public.posts po where po.created_at::date = d.d) as drops_created,
      (select count(*) from public.posts po where po.expires_at::date = d.d and po.expires_at <= now() + interval '1 day') as drops_expired,
      (select count(*) from public.post_views pv where pv.viewed_at::date = d.d) as views,
      (select count(*) from public.likes l where l.created_at::date = d.d) as likes,
      (select count(*) from public.comments c where c.created_at::date = d.d) as comments,
      (select count(*) from public.reposts rp where rp.created_at::date = d.d) as reposts,
      (select count(*) from public.saved_posts sp where sp.created_at::date = d.d) as saves,
      (select count(*) from public.follows f where f.created_at::date = d.d) as follows,
      (select count(*) from public.messages m where m.created_at::date = d.d) as messages,
      (select count(*) from public.anonymous_messages am where am.created_at::date = d.d) as anon_messages,
      (select count(*) from public.reports r where r.created_at::date = d.d) as reports,
      -- DAU: distinct users touching ANY activity surface that day
      (select count(distinct u) from (
        select user_id as u from public.posts where created_at::date = d.d
        union select user_id from public.likes where created_at::date = d.d
        union select user_id from public.comments where created_at::date = d.d
        union select user_id from public.post_views where viewed_at::date = d.d
        union select user_id from public.messages where created_at::date = d.d
        union select sender_id from public.anonymous_messages where created_at::date = d.d
        union select user_id from public.follows where created_at::date = d.d
      ) act) as dau
    from days d order by d.d
  ) t;
  return jsonb_build_object('series', v_rows);
end $$;

revoke all on function public.admin_analytics_series(int) from public, anon;
grant execute on function public.admin_analytics_series(int) to authenticated;

-- WAU / MAU / retention snapshot
create or replace function public.admin_analytics_snapshot()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('analytics.view');
  select jsonb_build_object(
    'wau', (select count(distinct u) from (
      select user_id as u from public.posts where created_at > now() - interval '7 days'
      union select user_id from public.likes where created_at > now() - interval '7 days'
      union select user_id from public.comments where created_at > now() - interval '7 days'
      union select user_id from public.post_views where viewed_at > now() - interval '7 days'
      union select user_id from public.messages where created_at > now() - interval '7 days'
      union select sender_id from public.anonymous_messages where created_at > now() - interval '7 days'
    ) act),
    'mau', (select count(distinct u) from (
      select user_id as u from public.posts where created_at > now() - interval '30 days'
      union select user_id from public.likes where created_at > now() - interval '30 days'
      union select user_id from public.comments where created_at > now() - interval '30 days'
      union select user_id from public.post_views where viewed_at > now() - interval '30 days'
      union select user_id from public.messages where created_at > now() - interval '30 days'
      union select sender_id from public.anonymous_messages where created_at > now() - interval '30 days'
    ) act),
    -- 7-day retention: users created >= 7 days ago who were active in the last 7 days
    'retention_7d', round(100.0 * (
      select count(distinct u) from (
        select user_id as u from public.posts where created_at > now() - interval '7 days'
        union select user_id from public.likes where created_at > now() - interval '7 days'
        union select user_id from public.comments where created_at > now() - interval '7 days'
        union select user_id from public.post_views where viewed_at > now() - interval '7 days'
        union select user_id from public.messages where created_at > now() - interval '7 days'
        union select sender_id from public.anonymous_messages where created_at > now() - interval '7 days'
      ) act
      intersect
      select id from public.profiles where created_at < now() - interval '7 days'
    ) / nullif((select count(*) from public.profiles where created_at < now() - interval '7 days'), 0), 1),
    'total_drops_viewed', (select count(*) from public.post_views),
    'total_likes', (select count(*) from public.likes),
    'total_comments', (select count(*) from public.comments),
    'total_reposts', (select count(*) from public.reposts),
    'total_saves', (select count(*) from public.saved_posts),
    'total_follows', (select count(*) from public.follows),
    'total_conversations', (select count(*) from public.conversations),
    'total_messages', (select count(*) from public.messages),
    'total_anon_messages', (select count(*) from public.anonymous_messages),
    'total_bans', (select count(*) from public.admin_audit_log where action = 'set_user_status' and metadata->>'status' = 'banned'),
    'total_suspensions', (select count(*) from public.admin_audit_log where action = 'set_user_status' and metadata->>'status' = 'suspended'),
    'total_reports', (select count(*) from public.reports) + (select count(*) from public.anonymous_reports) + (select count(*) from public.chat_reports)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_analytics_snapshot() from public, anon;
grant execute on function public.admin_analytics_snapshot() to authenticated;

-- ------------------------------------------------------------
-- 18) AROUND YOU — privacy-preserving REGIONAL aggregates only
-- ------------------------------------------------------------
create or replace function public.admin_regions()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('regions.view');
  select jsonb_build_object(
    'regions', coalesce((select jsonb_agg(t) from (
      select pr.location_region as region,
             count(distinct pr.id) as users,
             count(distinct po.id) filter (where po.expires_at > now()) as active_drops
      from public.profiles pr
      left join public.posts po on po.user_id = pr.id
      where pr.location_region is not null
      group by pr.location_region order by users desc limit 50) t), '[]'::jsonb),
    'drop_locations', coalesce((select jsonb_agg(t) from (
      select location, count(*) as drops, count(distinct user_id) as creators
      from public.posts where location is not null and expires_at > now() and removed_at is null
      group by location order by drops desc limit 50) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_regions() from public, anon;
grant execute on function public.admin_regions() to authenticated;

-- ------------------------------------------------------------
-- 19) DISCOVERY — trending based on REAL activity only
-- ------------------------------------------------------------
create or replace function public.admin_discovery()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('discovery.view');
  select jsonb_build_object(
    'trending_drops', coalesce((select jsonb_agg(t) from (
      select po.id, pr.username as creator, po.caption,
             (select count(*) from public.post_views pv where pv.post_id = po.id) as views,
             po.likes_count, po.comments_count
      from public.posts po join public.profiles pr on pr.id = po.user_id
      where po.expires_at > now() and po.removed_at is null
      order by ((select count(*) from public.post_views pv where pv.post_id = po.id) + po.likes_count * 3 + po.comments_count * 5) desc
      limit 20) t), '[]'::jsonb),
    'trending_sounds', coalesce((select jsonb_agg(t) from (
      select sound, count(*) as drops from public.posts
      where sound is not null and expires_at > now() and removed_at is null
      group by sound order by drops desc limit 20) t), '[]'::jsonb),
    'top_creators', coalesce((select jsonb_agg(t) from (
      select pr.id, pr.username,
             (select count(*) from public.follows f where f.following_id = pr.id) as followers,
             (select count(*) from public.posts po where po.user_id = pr.id and po.expires_at > now()) as active_drops
      from public.profiles pr
      order by followers desc limit 20) t), '[]'::jsonb),
    'category_pulse', coalesce((select jsonb_agg(t) from (
      select visibility as category, count(*) as active from public.posts
      where expires_at > now() and removed_at is null group by visibility) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_discovery() from public, anon;
grant execute on function public.admin_discovery() to authenticated;

-- ------------------------------------------------------------
-- 20) ADMIN ACCOUNT MANAGEMENT (super admin only)
-- ------------------------------------------------------------
create or replace function public.admin_admin_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('admins.manage');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select a.user_id, u.email, a.role, a.status, a.mfa_enabled, a.created_at, a.last_login_at
    from public.admin_users a join auth.users u on u.id = a.user_id
    order by a.created_at
  ) t;
  return jsonb_build_object('admins', v_rows);
end $$;

create or replace function public.admin_admin_add(p_email text, p_role text default 'admin')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_target uuid;
begin
  v_uid := public.admin_require('admins.manage');
  if p_role not in ('admin','moderator','support','analytics') then
    raise exception 'invalid role';
  end if;
  select id into v_target from auth.users where lower(email) = lower(p_email);
  if v_target is null then
    raise exception 'no user with that email';
  end if;
  insert into public.admin_users (user_id, role) values (v_target, p_role)
  on conflict (user_id) do update set role = excluded.role, status = 'active';
  perform public.admin_audit('add_admin', 'admins', 'admin', v_target::text, null,
    jsonb_build_object('email', p_email, 'role', p_role));
end $$;

create or replace function public.admin_admin_remove(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  v_uid := public.admin_require('admins.manage');
  if v_uid = p_user_id then raise exception 'cannot remove yourself'; end if;
  update public.admin_users set status = 'disabled' where user_id = p_user_id;
  perform public.admin_audit('disable_admin', 'admins', 'admin', p_user_id::text);
end $$;

create or replace function public.admin_admin_set_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('admins.manage');
  if p_role not in ('super_admin','admin','moderator','support','analytics') then raise exception 'invalid role'; end if;
  update public.admin_users set role = p_role where user_id = p_user_id;
  perform public.admin_audit('set_admin_role', 'admins', 'admin', p_user_id::text, null, jsonb_build_object('role', p_role));
end $$;

revoke all on function public.admin_admin_list() from public, anon;
grant execute on function public.admin_admin_list() to authenticated;
revoke all on function public.admin_admin_add(text, text) from public, anon;
grant execute on function public.admin_admin_add(text, text) to authenticated;
revoke all on function public.admin_admin_remove(uuid) from public, anon;
grant execute on function public.admin_admin_remove(uuid) to authenticated;
revoke all on function public.admin_admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_admin_set_role(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 21) AUDIT LOG VIEWER
-- ------------------------------------------------------------
create or replace function public.admin_audit_list(
  p_category text default null, p_limit int default 100, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('audit.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select admin_email, action, category, target_type, target_id, reason, metadata, ip, created_at
    from public.admin_audit_log
    where (p_category is null or category = p_category)
    order by created_at desc limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('entries', v_rows);
end $$;

revoke all on function public.admin_audit_list(text, int, int) from public, anon;
grant execute on function public.admin_audit_list(text, int, int) to authenticated;

-- ------------------------------------------------------------
-- 22) ENFORCEMENT — account statuses are enforced server-side.
--     suspended/banned users cannot create content; restricted
--     users lose anonymous messaging.
-- ------------------------------------------------------------
create or replace function public.enforce_content_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  select account_status into v_status from public.profiles where id = auth.uid();
  if v_status in ('suspended','banned') then
    raise exception 'account % cannot create content (status: %)', auth.uid(), v_status;
  end if;
  return new;
end $$;

create or replace function public.enforce_anon_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_anon_disabled boolean;
begin
  select account_status, anon_disabled into v_status, v_anon_disabled from public.profiles where id = auth.uid();
  if v_status in ('suspended','banned') or v_anon_disabled then
    raise exception 'anonymous messaging disabled for this account';
  end if;
  return new;
end $$;

drop trigger if exists posts_status_gate on public.posts;
create trigger posts_status_gate before insert on public.posts
  for each row execute function public.enforce_content_status();
drop trigger if exists comments_status_gate on public.comments;
create trigger comments_status_gate before insert on public.comments
  for each row execute function public.enforce_content_status();
drop trigger if exists messages_status_gate on public.messages;
create trigger messages_status_gate before insert on public.messages
  for each row execute function public.enforce_content_status();
drop trigger if exists likes_status_gate on public.likes;
create trigger likes_status_gate before insert on public.likes
  for each row execute function public.enforce_content_status();
drop trigger if exists anon_status_gate on public.anonymous_messages;
create trigger anon_status_gate before insert on public.anonymous_messages
  for each row execute function public.enforce_anon_status();

-- ------------------------------------------------------------
-- 23) FINAL SECURITY — admin tables are RPC-only. No direct
--     client access via RLS grants.
-- ------------------------------------------------------------
alter table public.admin_users enable row level security;
alter table public.admin_permissions enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.admin_settings enable row level security;
alter table public.feature_flags enable row level security;
alter table public.platform_notifications enable row level security;
alter table public.platform_notification_deliveries enable row level security;

revoke all on table public.admin_users, public.admin_permissions, public.admin_audit_log,
  public.admin_settings, public.feature_flags, public.platform_notifications,
  public.platform_notification_deliveries from anon, authenticated;
