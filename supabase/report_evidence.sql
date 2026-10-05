-- ============================================================
-- GEN Z — report evidence retention.
--
-- RUN IN THE SUPABASE SQL EDITOR (project: GenZ, main/PRODUCTION).
-- Idempotent — safe to re-run.
--
-- THE PROBLEM
--
-- `chat_reports` stores `message_id` — a POINTER, not the content. So a report
-- references a message that is very likely to be gone by the time a moderator
-- opens it:
--
--   * the 48h/7-day purge hard-deletes posts and messages on a cron
--   * the sender can delete the message themselves (`deleted_at`)
--   * view-once explicitly NULLs media_url and content the moment it is opened
--     (ChatThread openOnce), and deletes the file from storage
--
-- The result is an admin queue full of dangling ids, on reports the platform is
-- expected to act on. Apple's UGC guideline requires "a mechanism to report
-- content and timely responses to concerns" — you cannot respond to a concern
-- whose evidence self-destructed on a timer.
--
-- THE FIX
--
-- Capture the reportable content AT THE MOMENT IT IS REPORTED, into the report
-- row itself. The report is then self-contained: it survives the purge, the
-- delete, and the view-once consumption, because it no longer depends on the
-- message still existing.
--
-- Why a jsonb blob rather than typed columns: the message envelope has fourteen
-- variants (src/messaging/types.ts MESSAGE_KINDS) with different payload shapes.
-- Enumerating them as columns would mean a migration every time a message kind
-- is added, and a report that fails to file is worse than a report with a
-- loosely-shaped body.
-- ============================================================

alter table public.chat_reports
  add column if not exists evidence jsonb;

comment on column public.chat_reports.evidence is
  'Snapshot of the reported message as it was when reported: kind, text, media_url, '
  'sender id/username, and when it was sent. Written by ReportSheet. Exists because '
  'message_id alone is a dangling pointer once the purge, a sender delete, or '
  'view-once consumption removes the original. NULL for reports filed before this '
  'column existed, and for non-message reports.';


-- ------------------------------------------------------------
-- Guard: evidence must stay out of reach of ordinary users.
--
-- chat_reports already has RLS (reporters insert their own row, moderators read).
-- The evidence column inherits that, but the reporter must not be able to READ
-- back or EDIT the snapshot after filing — a reporter editing the evidence of
-- their own report would undermine the queue it feeds.
--
-- This is a column-level revoke on top of the row-level policy: it costs nothing
-- and closes the obvious hole.
-- ------------------------------------------------------------
revoke update (evidence) on public.chat_reports from anon, authenticated;


-- ------------------------------------------------------------
-- PROOF
--   · evidence_column : 'jsonb'
--   · reports_total    : however many reports exist
--   · with_evidence    : 0 for now — every existing report predates the column
-- ------------------------------------------------------------
select 'evidence_column' as check,
       (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'chat_reports' and column_name = 'evidence') as value
union all select 'reports_total', (select count(*)::text from public.chat_reports)
union all select 'with_evidence', (select count(*)::text from public.chat_reports where evidence is not null);
