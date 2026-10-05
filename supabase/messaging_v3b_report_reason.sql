-- ============================================================
-- GEN Z — MESSAGING v3b · chat_reports.reason
-- ============================================================
-- Additive. Idempotent. Safe to re-run.
--
-- WHY THIS EXISTS: building the report sheet (§34) revealed that
-- `public.chat_reports` has no column for the report CATEGORY.
-- Its columns are:
--
--   id, reporter_id, conversation_id, reported_user_id, created_at,
--   status ('open'|'resolved'|'dismissed'), severity, message_id,
--   resolved_by, resolved_at, resolution
--
-- So a user could only ever tell a moderator "spam" by bending
-- `severity` to carry it — meaning the moderator's queue would show
-- a *severity* while the actual reason was thrown away. Reported
-- harassment and reported spam would look identical.
--
-- `reason` is intentionally nullable and has NO check constraint:
-- existing rows have no value, and a CHECK would make this ALTER
-- fail against them. The client supplies one of the seven §34
-- categories.
-- ============================================================

alter table public.chat_reports
  add column if not exists reason text;

comment on column public.chat_reports.reason is
  'Report category from §34: spam | harassment | scam | impersonation | inappropriate | abuse | suspicious_account';

-- A moderator queue reads newest-first, usually filtered by status.
create index if not exists chat_reports_queue_idx
  on public.chat_reports (status, created_at desc);

-- ------------------------------------------------------------
-- VERIFY
-- ------------------------------------------------------------
select 'chat_reports.reason column present (expect 1)' as check_name,
       count(*) as n
from information_schema.columns
where table_schema = 'public'
  and table_name = 'chat_reports'
  and column_name = 'reason';

select 'chat_reports queue index present (expect 1)' as check_name,
       count(*) as n
from pg_indexes
where schemaname = 'public'
  and indexname = 'chat_reports_queue_idx';
