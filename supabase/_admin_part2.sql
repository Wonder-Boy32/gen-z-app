
-- ============================================================
-- PART 2 — MODERATION / ANON / CHAT / SAFETY / NOTIFICATIONS /
--           SETTINGS / FLAGS / ANALYTICS / ADMINS / ENFORCEMENT
-- ============================================================

-- ------------------------------------------------------------
-- 8) MODERATION CENTER (drops / comments / users)
-- ------------------------------------------------------------
create or replace function public.admin_report_list(
  p_severity text default null, p_status text default 'open', p_limit int default 50, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('moderation.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select r.id, r.reason, r.note, r.severity, r.status, r.created_at, r.assigned_to,
           r.resolution, r.resolved_at,
           reporter.username as reporter, reported.username as reported_user,
           r.post_id, r.comment_id, r.reported_user_id,
           po.caption as drop_caption, po.media_type as drop_type, po.removed_at as drop_removed,
           cm.content as comment_content
    from public.reports r
    left join public.profiles reporter on reporter.id = r.reporter_id
    left join public.profiles reported on reported.id = r.reported_user_id
    left join public.posts po on po.id = r.post_id
    left join public.comments cm on cm.id = r.comment_id
    where (p_status is null or r.status = p_status)
      and (p_severity is null or r.severity = p_severity)
    order by case r.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, r.created_at desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('reports', v_rows);
end $$;

create or replace function public.admin_report_resolve(
  p_report_id uuid, p_action text, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_report public.reports%rowtype;
  v_uid uuid;
begin
  v_uid := public.admin_require('moderation.manage');
  select * into v_report from public.reports where id = p_report_id;
  if not found then raise exception 'report not found'; end if;

  if p_action = 'dismiss' then
    update public.reports set status = 'dismissed', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
    perform public.admin_audit('dismiss_report', 'moderation', 'report', p_report_id::text, p_reason);
  elsif p_action = 'resolve' then
    update public.reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
    perform public.admin_audit('resolve_report', 'moderation', 'report', p_report_id::text, p_reason);
  elsif p_action = 'remove_content' and v_report.post_id is not null then
    update public.posts set removed_at = now(), removed_by = v_uid where id = v_report.post_id;
    update public.reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
    perform public.admin_audit('remove_drop_via_report', 'moderation', 'drop', v_report.post_id::text, p_reason);
  elsif p_action in ('restrict_user','suspend_user','ban_user') and v_report.reported_user_id is not null then
    perform public.admin_user_set_status(
      v_report.reported_user_id,
      case p_action when 'restrict_user' then 'restricted' when 'suspend_user' then 'suspended' else 'banned' end,
      coalesce(p_reason, 'moderation action: '||p_action)
    );
    update public.reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
    perform public.admin_audit(p_action, 'moderation', 'report', p_report_id::text, p_reason,
      jsonb_build_object('user_id', v_report.reported_user_id));
  else
    raise exception 'unsupported action';
  end if;
end $$;

create or replace function public.admin_report_assign(p_report_id uuid, p_assignee_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('moderation.manage');
  update public.reports set assigned_to = p_assignee_id where id = p_report_id;
  perform public.admin_audit('assign_report', 'moderation', 'report', p_report_id::text, null,
    jsonb_build_object('assignee', p_assignee_id));
end $$;

revoke all on function public.admin_report_list(text, text, int, int) from public, anon;
grant execute on function public.admin_report_list(text, text, int, int) to authenticated;
revoke all on function public.admin_report_resolve(uuid, text, text) from public, anon;
grant execute on function public.admin_report_resolve(uuid, text, text) to authenticated;
revoke all on function public.admin_report_assign(uuid, uuid) from public, anon;
grant execute on function public.admin_report_assign(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 9) ANONYMOUS MESSAGE MODERATION
--    Internal metadata (sender identity) is server-side only.
--    The recipient-facing view never exposes it; only these
--    authorized functions can read it, and every action is
--    audited.
-- ------------------------------------------------------------
create or replace function public.admin_anon_report_list(
  p_status text default 'open', p_limit int default 50, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('anon.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select ar.id, ar.reason, ar.note, ar.severity, ar.status, ar.created_at, ar.resolution,
           am.content, am.message_type, am.media_url, am.created_at as message_created_at,
           recipient.username as recipient,
           -- INTERNAL: sender identity for abuse prevention only
           sender.username as internal_sender
    from public.anonymous_reports ar
    join public.anonymous_messages am on am.id = ar.message_id
    left join public.profiles recipient on recipient.id = am.recipient_id
    left join public.profiles sender on sender.id = am.sender_id
    where (p_status is null or ar.status = p_status)
    order by ar.created_at desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('reports', v_rows);
end $$;

create or replace function public.admin_anon_resolve(
  p_report_id uuid, p_action text, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_sender uuid;
begin
  v_uid := public.admin_require('anon.manage');
  select am.sender_id into v_sender
  from public.anonymous_reports ar
  join public.anonymous_messages am on am.id = ar.message_id
  where ar.id = p_report_id;

  if p_action = 'dismiss' then
    update public.anonymous_reports set status = 'dismissed', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action = 'resolve' then
    update public.anonymous_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action = 'remove_content' then
    update public.anonymous_messages set content = null, media_url = null, voice_url = null where id = (select message_id from public.anonymous_reports where id = p_report_id);
    update public.anonymous_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action in ('restrict_user','suspend_user','ban_user') and v_sender is not null then
    perform public.admin_user_set_status(
      v_sender,
      case p_action when 'restrict_user' then 'restricted' when 'suspend_user' then 'suspended' else 'banned' end,
      coalesce(p_reason, 'anonymous message moderation')
    );
    update public.anonymous_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action = 'disable_anon' and v_sender is not null then
    perform public.admin_user_set_anon(v_sender, true, coalesce(p_reason, 'anonymous message moderation'));
    update public.anonymous_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  else
    raise exception 'unsupported action';
  end if;
  perform public.admin_audit('anon_'||p_action, 'anon', 'anon_report', p_report_id::text, p_reason,
    jsonb_build_object('sender_id', v_sender));
end $$;

revoke all on function public.admin_anon_report_list(text, int, int) from public, anon;
grant execute on function public.admin_anon_report_list(text, int, int) to authenticated;
revoke all on function public.admin_anon_resolve(uuid, text, text) from public, anon;
grant execute on function public.admin_anon_resolve(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 10) CHAT MODERATION (moderation-level, privacy-first)
-- ------------------------------------------------------------
create or replace function public.admin_chat_report_list(
  p_status text default 'open', p_limit int default 50, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('chat.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select cr.id, cr.severity, cr.status, cr.created_at, cr.resolution,
           reporter.username as reporter, reported.username as reported_user,
           cr.conversation_id,
           msg.content as message_content, msg.msg_type as message_type, msg.created_at as message_created_at,
           (select count(*) from public.conversation_participants cp where cp.conversation_id = cr.conversation_id) as participants
    from public.chat_reports cr
    left join public.profiles reporter on reporter.id = cr.reporter_id
    left join public.profiles reported on reported.id = cr.reported_user_id
    left join public.messages msg on msg.id = cr.message_id
    where (p_status is null or cr.status = p_status)
    order by cr.created_at desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('reports', v_rows);
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
    update public.messages set content = null, media_url = null where id = (select message_id from public.chat_reports where id = p_report_id) and message_id is not null;
    update public.chat_reports set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution = p_reason where id = p_report_id;
  elsif p_action in ('restrict_user','suspend_user','ban_user') and v_reported is not null then
    perform public.admin_user_set_status(
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

revoke all on function public.admin_chat_report_list(text, int, int) from public, anon;
grant execute on function public.admin_chat_report_list(text, int, int) to authenticated;
revoke all on function public.admin_chat_resolve(uuid, text, text) from public, anon;
grant execute on function public.admin_chat_resolve(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 11) SAFETY CENTER (anti-spam / suspicious activity)
-- ------------------------------------------------------------
create or replace function public.admin_safety_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('safety.view');
  select jsonb_build_object(
    'suspicious_accounts', coalesce((select jsonb_agg(t) from (
      select pr.id, pr.username, pr.account_status,
             (select count(*) from public.reports r where r.reported_user_id = pr.id) as reports_against,
             (select count(*) from public.blocks b where b.blocked_id = pr.id) as times_blocked,
             (select count(*) from public.anonymous_messages am where am.sender_id = pr.id) as anon_sent
      from public.profiles pr
      where (select count(*) from public.reports r where r.reported_user_id = pr.id) >= 3
         or (select count(*) from public.blocks b where b.blocked_id = pr.id) >= 5
      order by reports_against desc limit 25) t), '[]'::jsonb),
    'anon_heavy_senders', coalesce((select jsonb_agg(t) from (
      select pr.id, pr.username, count(am.id) as sent
      from public.anonymous_messages am join public.profiles pr on pr.id = am.sender_id
      group by pr.id, pr.username having count(am.id) >= 10 order by sent desc limit 25) t), '[]'::jsonb),
    'spam_like_users', coalesce((select jsonb_agg(t) from (
      select pr.id, pr.username, count(am.id) as msgs
      from public.anonymous_messages am join public.profiles pr on pr.id = am.sender_id
      where am.created_at > now() - interval '24 hours'
      group by pr.id, pr.username having count(am.id) >= 5 order by msgs desc limit 25) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_safety_overview() from public, anon;
grant execute on function public.admin_safety_overview() to authenticated;

-- ------------------------------------------------------------
-- 12) PLATFORM NOTIFICATIONS (official broadcasts only)
-- ------------------------------------------------------------
create or replace function public.admin_notification_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('notifications.manage');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select pn.id, pn.title, pn.message, pn.audience_type, pn.audience_value,
           pn.scheduled_for, pn.status, pn.created_at, pn.sent_at,
           (select count(*) from public.platform_notification_deliveries d where d.notification_id = pn.id) as delivered
    from public.platform_notifications pn order by pn.created_at desc limit 100
  ) t;
  return jsonb_build_object('notifications', v_rows);
end $$;

create or replace function public.admin_notification_create(
  p_title text, p_message text, p_audience_type text default 'all',
  p_audience_value text default null, p_scheduled_for timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_id uuid;
begin
  v_uid := public.admin_require('notifications.manage');
  insert into public.platform_notifications
    (title, message, audience_type, audience_value, scheduled_for, status, created_by)
  values (p_title, p_message, p_audience_type, p_audience_value, p_scheduled_for,
          case when p_scheduled_for is not null then 'scheduled' else 'draft' end, v_uid)
  returning id into v_id;
  perform public.admin_audit('create_notification', 'notifications', 'notification', v_id::text, null,
    jsonb_build_object('audience', p_audience_type, 'audience_value', p_audience_value));
  return v_id;
end $$;

create or replace function public.admin_notification_send(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_n public.platform_notifications%rowtype;
begin
  v_uid := public.admin_require('notifications.manage');
  select * into v_n from public.platform_notifications where id = p_id;
  if not found then raise exception 'notification not found'; end if;
  if v_n.status in ('sent','sending') then raise exception 'already sent'; end if;

  insert into public.platform_notification_deliveries (notification_id, user_id)
  select p_id, pr.id from public.profiles pr
  where
    (v_n.audience_type = 'all')
    or (v_n.audience_type = 'new_users' and pr.created_at > now() - interval '7 days')
    or (v_n.audience_type = 'verified' and pr.verified)
    or (v_n.audience_type = 'creators' and (select count(*) from public.posts po where po.user_id = pr.id) >= 5)
    or (v_n.audience_type in ('country','region') and pr.location_region = v_n.audience_value)
  on conflict (notification_id, user_id) do nothing;

  update public.platform_notifications
  set status = 'sent', sent_at = now()
  where id = p_id;
  perform public.admin_audit('send_notification', 'notifications', 'notification', p_id::text, null,
    jsonb_build_object('audience', v_n.audience_type, 'audience_value', v_n.audience_value));
end $$;

create or replace function public.admin_notification_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('notifications.manage');
  update public.platform_notifications set status = 'cancelled' where id = p_id and status in ('draft','scheduled');
  perform public.admin_audit('cancel_notification', 'notifications', 'notification', p_id::text);
end $$;

revoke all on function public.admin_notification_list() from public, anon;
grant execute on function public.admin_notification_list() to authenticated;
revoke all on function public.admin_notification_create(text, text, text, text, timestamptz) from public, anon;
grant execute on function public.admin_notification_create(text, text, text, text, timestamptz) to authenticated;
revoke all on function public.admin_notification_send(uuid) from public, anon;
grant execute on function public.admin_notification_send(uuid) to authenticated;
revoke all on function public.admin_notification_cancel(uuid) from public, anon;
grant execute on function public.admin_notification_cancel(uuid) to authenticated;

-- ------------------------------------------------------------
-- 13) PLATFORM SETTINGS (only is_safe keys are writable)
-- ------------------------------------------------------------
insert into public.admin_settings (key, value, category, label, description, is_safe) values
  ('platform_name', '"Gen Z"', 'general', 'Platform name', 'Shown across the app', true),
  ('maintenance_mode', 'false', 'general', 'Maintenance mode', 'Blocks new sessions when true', true),
  ('registration_enabled', 'true', 'general', 'Registration', 'Allow new sign-ups', true),
  ('min_age', '13', 'safety', 'Minimum age', 'Minimum age to register', true),
  ('max_video_size_mb', '200', 'content', 'Max video size (MB)', 'Upload limit for video drops', true),
  ('max_video_duration_sec', '60', 'content', 'Max video duration (s)', 'Duration limit for video drops', true),
  ('comments_enabled', 'true', 'content', 'Comments', 'Allow comments on drops', true),
  ('messaging_enabled', 'true', 'chat', 'Direct messaging', 'Allow private messages', true),
  ('anonymous_messages_enabled', 'true', 'anon', 'Anonymous messages', 'Allow anonymous inbox', true),
  ('report_categories', '["harassment","bullying","threats","spam","scams","sexual","hate","other"]', 'moderation', 'Report categories', 'Reasons users can report', true)
on conflict (key) do nothing;

create or replace function public.admin_setting_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('settings.manage');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select key, value, category, label, description, is_safe, updated_at from public.admin_settings order by category, key
  ) t;
  return jsonb_build_object('settings', v_rows);
end $$;

create or replace function public.admin_setting_set(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  v_uid := public.admin_require('settings.manage');
  if not exists (select 1 from public.admin_settings where key = p_key and is_safe) then
    raise exception 'setting not writable';
  end if;
  update public.admin_settings set value = p_value, updated_at = now(), updated_by = v_uid where key = p_key;
  perform public.admin_audit('set_setting', 'settings', 'setting', p_key, null, jsonb_build_object('value', p_value));
end $$;

revoke all on function public.admin_setting_list() from public, anon;
grant execute on function public.admin_setting_list() to authenticated;
revoke all on function public.admin_setting_set(text, jsonb) from public, anon;
grant execute on function public.admin_setting_set(text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 14) FEATURE FLAGS (safe rollout of current + future features)
-- ------------------------------------------------------------
insert into public.feature_flags (key, state) values
  ('for_you','enabled'), ('live','enabled'), ('expiring','enabled'),
  ('around_you','enabled'), ('anonymous_messages','enabled'),
  ('drop_chains','enabled'), ('drop_rooms','disabled'), ('voice_messages','enabled')
on conflict (key) do nothing;

create or replace function public.admin_flag_list()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('flags.manage');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select key, state, rollout_type, rollout_value, updated_at, updated_by from public.feature_flags order by key
  ) t;
  return jsonb_build_object('flags', v_rows);
end $$;

create or replace function public.admin_flag_set(
  p_key text, p_state text, p_rollout_type text default 'all', p_rollout_value text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  v_uid := public.admin_require('flags.manage');
  if p_state not in ('enabled','disabled','beta') then raise exception 'invalid state'; end if;
  insert into public.feature_flags (key, state, rollout_type, rollout_value, updated_by)
  values (p_key, p_state, p_rollout_type, p_rollout_value, v_uid)
  on conflict (key) do update set
    state = excluded.state, rollout_type = excluded.rollout_type,
    rollout_value = excluded.rollout_value, updated_at = now(), updated_by = v_uid;
  perform public.admin_audit('set_flag', 'flags', 'flag', p_key, null,
    jsonb_build_object('state', p_state, 'rollout_type', p_rollout_type, 'rollout_value', p_rollout_value));
end $$;

revoke all on function public.admin_flag_list() from public, anon;
grant execute on function public.admin_flag_list() to authenticated;
revoke all on function public.admin_flag_set(text, text, text, text) from public, anon;
grant execute on function public.admin_flag_set(text, text, text, text) to authenticated;
