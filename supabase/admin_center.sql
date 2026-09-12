-- ============================================================
-- GEN Z â€” ADMIN CONTROL CENTER (run ONCE, after all other SQL)
--
-- SECURITY MODEL:
--  * Admin identity lives in admin_users + admin_permissions.
--    Roles are NEVER set from the client; every admin function
--    is SECURITY DEFINER and gates on public.admin_require().
--  * Admin tables have NO grants to anon/authenticated â€” direct
--    reads/writes from the frontend are impossible.
--  * Every admin action writes to admin_audit_log.
--
-- 48-HOUR INVARIANT:
--  posts.expires_at is already immutable (lock_drop_timestamps
--  trigger). NO function in this file reads, writes, extends or
--  resets a Drop timer. Admin removal is a soft flag (removed_at)
--  so content can be restored â€” but never resurrected past 48h.
-- ============================================================

-- ------------------------------------------------------------
-- 1) PROFILE FIELDS (account statuses + verification)
-- ------------------------------------------------------------
alter table public.profiles add column if not exists account_status text not null default 'active'
  check (account_status in ('active','restricted','suspended','banned'));
alter table public.profiles add column if not exists verified boolean not null default false;
alter table public.profiles add column if not exists anon_disabled boolean not null default false;
alter table public.profiles add column if not exists location_region text;

-- ------------------------------------------------------------
-- 2) ADMIN CORE TABLES
-- ------------------------------------------------------------
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('super_admin','admin','moderator','support','analytics')),
  status text not null default 'active' check (status in ('active','disabled')),
  mfa_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists public.admin_permissions (
  role text not null,
  permission text not null,
  primary key (role, permission)
);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references auth.users(id) on delete set null,
  admin_email text,
  action text not null,
  category text not null,
  target_type text,
  target_id text,
  reason text,
  metadata jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_category_idx on public.admin_audit_log (category);
create index if not exists admin_audit_target_idx on public.admin_audit_log (target_id);

create table if not exists public.admin_settings (
  key text primary key,
  value jsonb not null,
  category text not null default 'general',
  label text,
  description text,
  is_safe boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.feature_flags (
  key text primary key,
  state text not null default 'enabled' check (state in ('enabled','disabled','beta')),
  rollout_type text not null default 'all' check (rollout_type in ('all','users','percent')),
  rollout_value text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.platform_notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  audience_type text not null default 'all' check (audience_type in ('all','country','region','new_users','verified','creators')),
  audience_value text,
  scheduled_for timestamptz,
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.platform_notification_deliveries (
  notification_id uuid not null references public.platform_notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- ------------------------------------------------------------
-- 3) MODERATION DATA EXTENSIONS
-- ------------------------------------------------------------
alter table public.reports add column if not exists reported_user_id uuid;
alter table public.reports add column if not exists message_id uuid;
alter table public.reports add column if not exists severity text not null default 'medium'
  check (severity in ('critical','high','medium','low'));
alter table public.reports add column if not exists assigned_to uuid;
alter table public.reports add column if not exists resolved_by uuid;
alter table public.reports add column if not exists resolved_at timestamptz;
alter table public.reports add column if not exists resolution text;
alter table public.reports add column if not exists note text;

alter table public.anonymous_reports add column if not exists status text not null default 'open'
  check (status in ('open','resolved','dismissed'));
alter table public.anonymous_reports add column if not exists severity text not null default 'medium';
alter table public.anonymous_reports add column if not exists resolved_by uuid;
alter table public.anonymous_reports add column if not exists resolved_at timestamptz;
alter table public.anonymous_reports add column if not exists resolution text;

alter table public.chat_reports add column if not exists status text not null default 'open'
  check (status in ('open','resolved','dismissed'));
alter table public.chat_reports add column if not exists severity text not null default 'medium';
alter table public.chat_reports add column if not exists message_id uuid;
alter table public.chat_reports add column if not exists resolved_by uuid;
alter table public.chat_reports add column if not exists resolved_at timestamptz;
alter table public.chat_reports add column if not exists resolution text;

-- posts: admin removal is a SOFT flag so content can be restored.
-- expires_at is never touched (48h rule).
alter table public.posts add column if not exists removed_at timestamptz;
alter table public.posts add column if not exists removed_by uuid;

drop policy if exists "posts_select_active" on public.posts;
create policy "posts_select_active" on public.posts
  for select using (expires_at > now() and removed_at is null);

-- ------------------------------------------------------------
-- 4) ROLE â†’ PERMISSION MATRIX (config-driven; future roles are
--    just rows here â€” no schema redesign needed)
-- ------------------------------------------------------------
insert into public.admin_permissions (role, permission) values
  ('super_admin','*'),
  ('admin','dashboard.view'),('admin','pulse.view'),('admin','users.view'),('admin','users.manage'),
  ('admin','drops.view'),('admin','drops.manage'),('admin','moderation.view'),('admin','moderation.manage'),
  ('admin','anon.view'),('admin','anon.manage'),('admin','safety.view'),('admin','safety.manage'),
  ('admin','chat.view'),('admin','chat.manage'),('admin','chains.view'),('admin','regions.view'),
  ('admin','discovery.view'),('admin','notifications.manage'),('admin','analytics.view'),
  ('admin','settings.manage'),('admin','flags.manage'),('admin','audit.view'),
  ('moderator','dashboard.view'),('moderator','pulse.view'),('moderator','users.view'),
  ('moderator','drops.view'),('moderator','drops.manage'),('moderator','moderation.view'),
  ('moderator','moderation.manage'),('moderator','anon.view'),('moderator','anon.manage'),
  ('moderator','safety.view'),('moderator','safety.manage'),('moderator','chat.view'),
  ('moderator','chat.manage'),('moderator','chains.view'),('moderator','discovery.view'),
  ('support','dashboard.view'),('support','users.view'),('support','moderation.view'),
  ('support','anon.view'),('support','chat.view'),
  ('analytics','dashboard.view'),('analytics','pulse.view'),('analytics','analytics.view'),
  ('analytics','discovery.view'),('analytics','regions.view')
on conflict (role, permission) do nothing;

-- ------------------------------------------------------------
-- 5) HELPERS â€” role gate + audit (used by every admin RPC)
-- ------------------------------------------------------------
create or replace function public.admin_require(p_perm text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;
  select role into v_role from public.admin_users where user_id = v_uid and status = 'active';
  if v_role is null then
    raise exception 'not_an_admin';
  end if;
  if p_perm is not null and v_role <> 'super_admin' and not exists (
    select 1 from public.admin_permissions where role = v_role and permission = p_perm
  ) then
    raise exception 'permission_denied';
  end if;
  return v_uid;
end $$;

revoke all on function public.admin_require(text) from public, anon;
grant execute on function public.admin_require(text) to authenticated;

create or replace function public.admin_audit(
  p_action text, p_category text,
  p_target_type text default null, p_target_id text default null,
  p_reason text default null, p_meta jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_email text;
  v_ip text;
begin
  v_uid := auth.uid();
  select email into v_email from auth.users where id = v_uid;
  begin
    v_ip := nullif(current_setting('request.headers', true), '')::jsonb->>'x-forwarded-for';
  exception when others then
    v_ip := null;
  end;
  insert into public.admin_audit_log
    (admin_id, admin_email, action, category, target_type, target_id, reason, metadata, ip)
  values
    (v_uid, v_email, p_action, p_category, p_target_type, p_target_id, p_reason, p_meta, v_ip);
end $$;

revoke all on function public.admin_audit(text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.admin_audit(text, text, text, text, text, jsonb) to authenticated;

-- identity + access for the admin app
create or replace function public.admin_whoami()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require();
  select jsonb_build_object(
    'user_id', u.id,
    'email', u.email,
    'role', a.role,
    'status', a.status,
    'mfa_enabled', a.mfa_enabled,
    'permissions', coalesce((select jsonb_agg(p.permission) from public.admin_permissions p where p.role = a.role), '[]'::jsonb)
  ) into v
  from auth.users u join public.admin_users a on a.user_id = u.id
  where u.id = v_uid;
  update public.admin_users set last_login_at = now() where user_id = v_uid;
  return v;
end $$;

revoke all on function public.admin_whoami() from public, anon;
grant execute on function public.admin_whoami() to authenticated;

-- ------------------------------------------------------------
-- 6) USERS
-- ------------------------------------------------------------
create or replace function public.admin_user_list(
  p_search text default null, p_status text default null,
  p_limit int default 50, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('users.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select pr.id, pr.username, pr.display_name, pr.avatar_url,
           pr.account_status, pr.verified, pr.anon_disabled, pr.location_region,
           pr.created_at, pr.last_seen_at,
           (select count(*) from public.follows f where f.following_id = pr.id) as followers,
           (select count(*) from public.follows f where f.follower_id = pr.id) as following,
           (select count(*) from public.posts p where p.user_id = pr.id and p.expires_at > now() and p.removed_at is null) as active_drops,
           (select count(*) from public.reports r where (r.reported_user_id = pr.id or r.post_id in (select p2.id from public.posts p2 where p2.user_id = pr.id)) and r.status = 'open') as open_reports
    from public.profiles pr
    where (p_search is null or pr.username ilike '%'||p_search||'%' or pr.display_name ilike '%'||p_search||'%' or pr.id::text = p_search)
      and (p_status is null or pr.account_status = p_status)
    order by pr.created_at desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('users', v_rows);
end $$;

revoke all on function public.admin_user_list(text, text, int, int) from public, anon;
grant execute on function public.admin_user_list(text, text, int, int) to authenticated;

create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v jsonb;
begin
  v_uid := public.admin_require('users.view');
  select jsonb_build_object(
    'user', row_to_json(u)::jsonb,
    'drops', coalesce((select jsonb_agg(d) from (
        select id, media_type, caption, content, created_at, expires_at, likes_count, comments_count,
               removed_at, (select count(*) from public.post_views pv where pv.post_id = posts.id) as views
        from public.posts where user_id = p_user_id order by created_at desc limit 50) d), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(r) from (
        select id, reason, severity, status, created_at from public.reports
        where reported_user_id = p_user_id or post_id in (select id from public.posts where user_id = p_user_id)
        order by created_at desc limit 50) r), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(h) from (
        select admin_email, action, reason, metadata, created_at from public.admin_audit_log
        where target_id = p_user_id::text order by created_at desc limit 50) h), '[]'::jsonb)
  ) into v
  from (
    select id, username, display_name, avatar_url, account_status, verified, anon_disabled,
           location_region, created_at, last_seen_at,
           (select count(*) from public.follows f where f.following_id = profiles.id) as followers,
           (select count(*) from public.follows f where f.follower_id = profiles.id) as following
    from public.profiles where id = p_user_id
  ) u;
  return v;
end $$;

revoke all on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;

create or replace function public.admin_user_set_status(
  p_user_id uuid, p_status text, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('users.manage');
  if p_status not in ('active','restricted','suspended','banned') then
    raise exception 'invalid status';
  end if;
  update public.profiles set account_status = p_status where id = p_user_id;
  perform public.admin_audit('set_user_status', 'users', 'user', p_user_id::text, p_reason,
    jsonb_build_object('status', p_status));
end $$;

-- internal variant (no gate) used by moderation flows, so moderators can
-- suspend/ban through a report without needing the users.manage permission.
create or replace function public.admin_user_set_status_internal(
  p_user_id uuid, p_status text, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set account_status = p_status where id = p_user_id;
  perform public.admin_audit('set_user_status', 'users', 'user', p_user_id::text, p_reason,
    jsonb_build_object('status', p_status));
end $$;

revoke all on function public.admin_user_set_status_internal(uuid, text, text) from public, anon;

create or replace function public.admin_user_set_verified(
  p_user_id uuid, p_verified boolean, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('users.manage');
  update public.profiles set verified = p_verified where id = p_user_id;
  perform public.admin_audit('set_user_verified', 'users', 'user', p_user_id::text, p_reason,
    jsonb_build_object('verified', p_verified));
end $$;

create or replace function public.admin_user_set_anon(
  p_user_id uuid, p_disabled boolean, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('safety.manage');
  update public.profiles set anon_disabled = p_disabled where id = p_user_id;
  perform public.admin_audit('set_user_anon_disabled', 'safety', 'user', p_user_id::text, p_reason,
    jsonb_build_object('anon_disabled', p_disabled));
end $$;

revoke all on function public.admin_user_set_status(uuid, text, text) from public, anon;
grant execute on function public.admin_user_set_status(uuid, text, text) to authenticated;
revoke all on function public.admin_user_set_verified(uuid, boolean, text) from public, anon;
grant execute on function public.admin_user_set_verified(uuid, boolean, text) to authenticated;
revoke all on function public.admin_user_set_anon(uuid, boolean, text) from public, anon;
grant execute on function public.admin_user_set_anon(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 7) DROPS (48H CONTENT â€” moderation only, NEVER the timer)
-- ------------------------------------------------------------
create or replace function public.admin_drop_list(
  p_filter text default 'active', p_search text default null,
  p_limit int default 50, p_offset int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('drops.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select po.id, po.user_id, pr.username as creator, po.media_type, po.caption, po.content,
           po.created_at, po.expires_at, po.likes_count, po.comments_count,
           po.removed_at, po.visibility, po.location,
           (select count(*) from public.post_views pv where pv.post_id = po.id) as views,
           (select count(*) from public.reposts rp where rp.post_id = po.id) as reposts,
           (select count(*) from public.saved_posts sp where sp.post_id = po.id) as saves,
           (select count(*) from public.reports r where r.post_id = po.id and r.status = 'open') as open_reports
    from public.posts po
    join public.profiles pr on pr.id = po.user_id
    where (p_search is null or pr.username ilike '%'||p_search||'%' or po.caption ilike '%'||p_search||'%' or po.content ilike '%'||p_search||'%')
      and (
        (p_filter = 'active' and po.expires_at > now() and po.removed_at is null) or
        (p_filter = 'expired' and po.expires_at <= now()) or
        (p_filter = 'removed' and po.removed_at is not null) or
        (p_filter = 'reported' and exists (select 1 from public.reports r where r.post_id = po.id and r.status = 'open')) or
        (p_filter = 'expiring' and po.expires_at between now() and now() + interval '6 hours' and po.removed_at is null) or
        (p_filter = 'all')
      )
    order by po.created_at desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('drops', v_rows);
end $$;

revoke all on function public.admin_drop_list(text, text, int, int) from public, anon;
grant execute on function public.admin_drop_list(text, text, int, int) to authenticated;

create or replace function public.admin_drop_remove(
  p_post_id uuid, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('drops.manage');
  update public.posts set removed_at = now(), removed_by = auth.uid() where id = p_post_id;
  perform public.admin_audit('remove_drop', 'drops', 'drop', p_post_id::text, p_reason);
end $$;

create or replace function public.admin_drop_restore(
  p_post_id uuid, p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require('drops.manage');
  -- restored content still obeys the 48h rule: never past expires_at
  update public.posts set removed_at = null, removed_by = null
  where id = p_post_id and expires_at > now();
  perform public.admin_audit('restore_drop', 'drops', 'drop', p_post_id::text, p_reason);
end $$;

revoke all on function public.admin_drop_remove(uuid, text) from public, anon;
grant execute on function public.admin_drop_remove(uuid, text) to authenticated;
revoke all on function public.admin_drop_restore(uuid, text) from public, anon;
grant execute on function public.admin_drop_restore(uuid, text) to authenticated;

-- ============================================================
-- PART 2 Ã¢â‚¬â€ MODERATION / ANON / CHAT / SAFETY / NOTIFICATIONS /
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
    perform public.admin_user_set_status_internal(
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
    perform public.admin_user_set_status_internal(
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


-- ============================================================
-- PART 3 Ã¢â‚¬â€ PULSE / ANALYTICS / REGIONS / DISCOVERY / ADMINS /
--           ENFORCEMENT / FINAL SECURITY
-- ============================================================

-- ------------------------------------------------------------
-- 15) 48H PULSE Ã¢â‚¬â€ monitors the temporary-content ecosystem.
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
-- 16) OVERVIEW Ã¢â‚¬â€ headline numbers (all real backend counts)
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
-- 17) ANALYTICS Ã¢â‚¬â€ time-series (real activity from real tables)
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
        union select sender_id from public.messages where created_at::date = d.d
        union select sender_id from public.anonymous_messages where created_at::date = d.d
        -- follows has follower_id/following_id, not user_id
        union select follower_id from public.follows where created_at::date = d.d
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

revoke all on function public.admin_analytics_snapshot() from public, anon;
grant execute on function public.admin_analytics_snapshot() to authenticated;

-- ------------------------------------------------------------
-- 18) AROUND YOU Ã¢â‚¬â€ privacy-preserving REGIONAL aggregates only
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
-- 19) DISCOVERY Ã¢â‚¬â€ trending based on REAL activity only
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
-- 22) ENFORCEMENT Ã¢â‚¬â€ account statuses are enforced server-side.
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
-- 23) FINAL SECURITY Ã¢â‚¬â€ admin tables are RPC-only. No direct
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


-- ------------------------------------------------------------
-- 24) MFA STATUS SYNC (called by the admin app after enroll)
-- ------------------------------------------------------------
create or replace function public.admin_mfa_status(p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require();
  update public.admin_users set mfa_enabled = p_enabled where user_id = auth.uid();
  perform public.admin_audit('set_mfa', 'security', 'admin', auth.uid()::text, null,
    jsonb_build_object('enabled', p_enabled));
end $$;

revoke all on function public.admin_mfa_status(boolean) from public, anon;
grant execute on function public.admin_mfa_status(boolean) to authenticated;

-- ------------------------------------------------------------
-- 25) DROP CHAINS â€” a chain is a root drop with replies.
--     Every member keeps its OWN 48h timer; responses never
--     extend the root (enforced by lock_drop_timestamps).
-- ------------------------------------------------------------
create or replace function public.admin_chain_list(p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid;
  v_rows jsonb;
begin
  v_uid := public.admin_require('chains.view');
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select root.id as chain_id, root.user_id, pr.username as creator, root.caption,
           root.created_at, root.expires_at,
           (select count(*) from public.posts c where c.parent_drop_id = root.id) as responses,
           (select count(*) from public.post_views pv where pv.post_id = root.id) as views,
           root.likes_count, root.comments_count,
           (select count(*) from public.reports r where r.post_id = root.id and r.status = 'open') as open_reports
    from public.posts root
    join public.profiles pr on pr.id = root.user_id
    where exists (select 1 from public.posts c where c.parent_drop_id = root.id)
      and root.expires_at > now() and root.removed_at is null
    order by responses desc, views desc
    limit p_limit offset p_offset
  ) t;
  return jsonb_build_object('chains', v_rows);
end $$;

revoke all on function public.admin_chain_list(int, int) from public, anon;
grant execute on function public.admin_chain_list(int, int) to authenticated;

