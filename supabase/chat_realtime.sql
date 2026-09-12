-- ============================================================
-- GEN Z — ENABLE REALTIME FOR CHAT (run ONCE)
-- Without this, message inserts/updates never reach the other
-- client live — messages only appear on reload, and typing
-- indicators / read receipts don't sync. This adds the chat
-- tables to Supabase's realtime publication (idempotent —
-- safe to run even if some are already enabled).
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_participants'
  ) then
    alter publication supabase_realtime add table public.conversation_participants;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

-- verify what's now live (should list messages, conversation_participants, conversations)
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
order by tablename;
