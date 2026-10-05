-- ============================================================
-- GEN Z — ADMIN ALERTS (notify admins when something needs a human)
-- Run ONCE, AFTER admin_center.sql.
-- Pairs with admin_verification_queue.sql. Additive + idempotent.
--
-- ------------------------------------------------------------
-- WHY THIS FILE EXISTS
-- ------------------------------------------------------------
-- admin_verification_queue.sql gave admins a way to REVIEW an application. It
-- did not give them any way to KNOW one had arrived. The gap was concrete:
--
--   · public.admin_notifications is the OPPOSITE direction — an admin writing
--     to users. Nothing existed for users -> admins.
--   · admin_stats_overview() counts only reports ('pending_reports'). There was
--     no pending-verification count anywhere.
--   · The admin app's navigation is a static list with no polling, no badge and
--     no realtime, so a pending item was invisible until someone happened to
--     open the right screen.
--
-- The effect: a user could submit a complete, valid verification application and
-- it would sit unread indefinitely. The applicant is told their request was
-- received; no human is told anything.
--
-- ------------------------------------------------------------
-- DESIGN — one generic trigger function, attached to every review queue
-- ------------------------------------------------------------
-- Every "needs a human decision" table here shares the same shape: a `status`
-- column that starts at 'pending' (or 'open') and moves to a decided value, and
-- an `id`. So one function covers all of them and each table just declares its
-- own kind/route/noun via trigger arguments. Adding a future queue is one
-- CREATE TRIGGER line, not a new function.
--
-- Alerts are RESOLVED BY TRIGGER, not by the resolve RPCs. That matters: if
-- admin_verification_resolve had to remember to close the alert, the two could
-- drift apart — a decision made, the alert still nagging. Watching the status
-- column instead means the alert cannot outlive the thing it points at.
-- ============================================================


-- ------------------------------------------------------------
-- 1) THE TABLE
-- ------------------------------------------------------------
create table if not exists public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  -- 'verification_request' | 'genzplus_payment' | 'report' | 'anon_report' | 'chat_report'
  kind text not null,
  -- 'attention' for something waiting on a human decision, 'urgent' reserved
  severity text not null default 'attention',
  title text not null,
  body text,
  -- what the alert is ABOUT, so the console can deep-link to it
  target_type text,
  target_id uuid,
  -- who caused it (the applicant / member / reporter), for context
  actor_id uuid,
  -- admin nav module key to open
  route text,
  created_at timestamptz not null default now(),
  -- set when the underlying item left its reviewable state
  resolved_at timestamptz,
  -- set when an admin has seen it (may be acked without being resolved)
  acknowledged_at timestamptz,
  acknowledged_by uuid
);

create index if not exists admin_alerts_open_idx
  on public.admin_alerts (created_at desc)
  where resolved_at is null;

alter table public.admin_alerts enable row level security;

-- Deliberately NO policies. Reads and writes happen only through the SECURITY
-- DEFINER functions below, which are gated by admin_require(). A regular user
-- therefore cannot see the admin alert feed at all — this table names the users
-- who filed reports.


-- ------------------------------------------------------------
-- 2) THE GENERIC PRODUCER
--    tg_argv[0] = kind   tg_argv[1] = admin route   tg_argv[2] = noun
-- ------------------------------------------------------------
create or replace function public.admin_alert_on_queue()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_kind   text := tg_argv[0];
  v_route  text := tg_argv[1];
  v_noun   text := tg_argv[2];
  v_status text;
  v_old    text := '';
  v_actor  uuid := null;
begin
  -- Both branches read the row generically, so this works for tables whose
  -- deciding column is called `status`.
  if tg_op = 'UPDATE' then
    v_old := coalesce(old.status, '');
  end if;

  v_status := coalesce(new.status, '');

  -- A queue leaving its reviewable state resolves whatever it raised.
  if tg_op = 'UPDATE' then
    if v_old in ('pending', 'open') and v_status not in ('pending', 'open') then
      update public.admin_alerts
         set resolved_at = now()
       where target_type = v_kind
         and target_id = new.id
         and resolved_at is null;
    end if;
    return new;
  end if;

  -- INSERT: only raise an alert for something actually awaiting a human.
  if v_status not in ('pending', 'open') then
    return new;
  end if;

  -- Not every queue table has a user_id; resolve it defensively so a schema
  -- difference can never block the applicant's own INSERT from succeeding.
  -- An alert failing to record is bad; losing the application is worse.
  begin
    v_actor := new.user_id;
  exception when others then
    v_actor := null;
  end;

  insert into public.admin_alerts
    (kind, severity, title, body, target_type, target_id, actor_id, route)
  values
    (v_kind, 'attention',
     'New ' || v_noun || ' to review',
     'A ' || v_noun || ' was submitted and is waiting for a decision.',
     v_kind, new.id, v_actor, v_route);

  return new;
end $$;


-- ------------------------------------------------------------
-- 3) ATTACH IT TO EVERY REVIEW QUEUE
--    `update of status` keeps this off hot write paths — an ordinary column
--    write on these tables does no alert work at all.
-- ------------------------------------------------------------
drop trigger if exists trg_alert_verification on public.verification_requests;
create trigger trg_alert_verification
  after insert or update of status on public.verification_requests
  for each row execute function public.admin_alert_on_queue(
    'verification_request', 'verification', 'verification request');

drop trigger if exists trg_alert_genzplus on public.genzplus_payments;
create trigger trg_alert_genzplus
  after insert or update of status on public.genzplus_payments
  for each row execute function public.admin_alert_on_queue(
    'genzplus_payment', 'payments', 'GenZ+ payment claim');

drop trigger if exists trg_alert_reports on public.reports;
create trigger trg_alert_reports
  after insert or update of status on public.reports
  for each row execute function public.admin_alert_on_queue(
    'report', 'moderation', 'report');

drop trigger if exists trg_alert_anon_reports on public.anonymous_reports;
create trigger trg_alert_anon_reports
  after insert or update of status on public.anonymous_reports
  for each row execute function public.admin_alert_on_queue(
    'anon_report', 'anon', 'anonymous report');

drop trigger if exists trg_alert_chat_reports on public.chat_reports;
create trigger trg_alert_chat_reports
  after insert or update of status on public.chat_reports
  for each row execute function public.admin_alert_on_queue(
    'chat_report', 'chat', 'chat report');


-- ------------------------------------------------------------
-- 4) BACKFILL — things already waiting when this is first run
--    Triggers only see FUTURE rows. Without this, any application that arrived
--    before this migration would stay invisible, which is the exact bug being
--    fixed. Guarded so re-running does not duplicate.
-- ------------------------------------------------------------
insert into public.admin_alerts (kind, severity, title, body, target_type, target_id, actor_id, route)
select 'verification_request', 'attention', 'New verification request to review',
       'An application filed before alerting existed is still awaiting a decision.',
       'verification_request', vr.id, vr.user_id, 'verification'
  from public.verification_requests vr
 where vr.status = 'pending'
   and not exists (
     select 1 from public.admin_alerts a
      where a.target_type = 'verification_request' and a.target_id = vr.id);

insert into public.admin_alerts (kind, severity, title, body, target_type, target_id, actor_id, route)
select 'genzplus_payment', 'attention', 'New GenZ+ payment claim to review',
       'A claim filed before alerting existed is still awaiting a decision.',
       'genzplus_payment', gp.id, gp.user_id, 'payments'
  from public.genzplus_payments gp
 where gp.status = 'pending'
   and not exists (
     select 1 from public.admin_alerts a
      where a.target_type = 'genzplus_payment' and a.target_id = gp.id);


-- ------------------------------------------------------------
-- 5) READ / ACK — what the console polls
-- ------------------------------------------------------------
-- One call drives the bell and every nav badge, so the console does not need
-- per-section count queries.
create or replace function public.admin_alert_summary()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  -- No permission argument on purpose: any admin should see that work is
  -- waiting, even one who is not allowed to act on it yet.
  perform public.admin_require();

  select jsonb_build_object(
    'unresolved',   (select count(*) from public.admin_alerts
                      where resolved_at is null and acknowledged_at is null),
    'verification', (select count(*) from public.verification_requests where status = 'pending'),
    'payments',     (select count(*) from public.genzplus_payments where status = 'pending'),
    'reports',      (select count(*) from public.reports where status = 'open')
                  + (select count(*) from public.anonymous_reports where status = 'open')
                  + (select count(*) from public.chat_reports where status = 'open')
  ) into v;

  return v;
end $$;

revoke all on function public.admin_alert_summary() from public, anon;
grant execute on function public.admin_alert_summary() to authenticated;


create or replace function public.admin_alert_list(p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb;
begin
  perform public.admin_require();

  -- Unresolved only. A decided item is history, and the audit log already
  -- records who decided it and why.
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) into v_rows from (
    select a.id, a.kind, a.severity, a.title, a.body, a.target_type, a.target_id,
           a.actor_id, a.route, a.created_at, a.acknowledged_at, a.resolved_at,
           pr.username as actor_username
      from public.admin_alerts a
      left join public.profiles pr on pr.id = a.actor_id
     where a.resolved_at is null
     order by a.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t;

  return jsonb_build_object('alerts', v_rows);
end $$;

revoke all on function public.admin_alert_list(int) from public, anon;
grant execute on function public.admin_alert_list(int) to authenticated;


create or replace function public.admin_alert_ack(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_require();

  -- Ack = "I have seen this", NOT "this is handled". It deliberately does not
  -- resolve the alert: only the underlying item leaving its pending state does
  -- that, so dismissing a notification can never hide unfinished work.
  update public.admin_alerts
     set acknowledged_at = now(), acknowledged_by = auth.uid()
   where id = p_id and acknowledged_at is null;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.admin_alert_ack(uuid) from public, anon;
grant execute on function public.admin_alert_ack(uuid) to authenticated;


-- ============================================================
-- VERIFY AFTER RUNNING
--
--   -- backfill should have produced one alert per pending application:
--   select kind, count(*) from public.admin_alerts
--   where resolved_at is null group by kind;
--
--   -- the summary the console polls:
--   select public.admin_alert_summary();
--
--   -- end-to-end: submit an application as a user, then re-run the summary —
--   -- 'verification' and 'unresolved' must BOTH increase by one.
--   --
--   -- then approve it and re-run: 'verification' drops, and the alert for that
--   -- id resolves by itself (resolved_at is no longer null) without the resolve
--   -- function touching this table.
--
--   -- a non-admin must be refused:
--   select public.admin_alert_summary();
-- ============================================================
