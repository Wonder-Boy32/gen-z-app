-- ============================================================
-- Gen Z — chat RLS fix (RUN THIS in Supabase SQL editor)
-- Allows creating a conversation: insert conversation, then
-- insert yourself + the other participant.
-- ============================================================

-- Anyone authenticated can open a conversation row (they only
-- ever see conversations they are a participant of).
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations
  for insert to authenticated
  with check (true);

-- A participant may add another participant to their own conversation
-- (replaces the old "only yourself" policy from schema.sql).
drop policy if exists "participants_insert" on public.conversation_participants;
create policy "participants_insert" on public.conversation_participants
  for insert
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = conversation_id
        and cp.user_id = auth.uid()
    )
  );
