-- ============================================================
-- GEN Z ADMIN — HOTFIX v2 (run this in the SQL editor)
-- 1) Analytics column fixes (sender_id / follower_id)
-- 2) Retention INTERSECT bigint/uuid fix
-- 3) chat report removal column fix
-- Idempotent — safe to re-run.
-- ============================================================
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
        union select sender_id from public.messages where created_at::date = d.d
        union select sender_id from public.anonymous_messages where created_at::date = d.d
        -- follows has follower_id/following_id, not user_id
        union select follower_id from public.follows where created_at::date = d.d
      ) act) as dau
    from days d order by d.d
  ) t;
  return jsonb_build_object('series', v_rows);
end $$;

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
      union select sender_id from public.messages where created_at > now() - interval '7 days'
      union select sender_id from public.anonymous_messages where created_at > now() - interval '7 days'
    ) act),
    'mau', (select count(distinct u) from (
      select user_id as u from public.posts where created_at > now() - interval '30 days'
      union select user_id from public.likes where created_at > now() - interval '30 days'
      union select user_id from public.comments where created_at > now() - interval '30 days'
      union select user_id from public.post_views where viewed_at > now() - interval '30 days'
      union select sender_id from public.messages where created_at > now() - interval '30 days'
      union select sender_id from public.anonymous_messages where created_at > now() - interval '30 days'
    ) act),
    -- 7-day retention: users created >= 7 days ago who were active in the last 7 days
    'retention_7d', round(100.0 * (
      (select count(*) from (
        select user_id as u from public.posts where created_at > now() - interval '7 days'
        union select user_id from public.likes where created_at > now() - interval '7 days'
        union select user_id from public.comments where created_at > now() - interval '7 days'
        union select user_id from public.post_views where viewed_at > now() - interval '7 days'
        union select sender_id from public.messages where created_at > now() - interval '7 days'
        union select sender_id from public.anonymous_messages where created_at > now() - interval '7 days'
        intersect
        select id from public.profiles where created_at < now() - interval '7 days'
      ) retained)
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

create or replace function public.admin_chat_resolve(
  p_report_id uuid, p_action text, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_reported uuid;
begin
  v_uid := public.admin_require('chat.manage');
  select reported_user_id into v_reported from public.chat_reports where id = p_report_id;

  if p_action = 'dismiss' then
    update public.chat_reports set status = 'dismissed', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action = 'resolve' then
    update public.chat_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action = 'remove_content' then
    update public.messages set content = null, media_url = null
    where id in (select cr.message_id from public.chat_reports cr where cr.id = p_report_id and cr.message_id is not null);
    update public.chat_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action in ('restrict_user','suspend_user','ban_user') and v_reported is not null then
    perform public.admin_user_set_status_internal(
      v_reported,
      case p_action when 'restrict_user' then 'restricted' when 'suspend_user' then 'suspended' else 'banned' end,
      coalesce(p_reason, 'chat moderation')
    );
    update public.chat_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  else
    raise exception 'unsupported action';
  end if;
  perform public.admin_audit('chat_'||p_action, 'chat', 'chat_report', p_report_id::text, p_reason,
    jsonb_build_object('reported_user_id', v_reported));
end $$;
