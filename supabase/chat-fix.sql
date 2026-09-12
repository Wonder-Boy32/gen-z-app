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
-- Uses my_conversation_ids() helper (SECURITY DEFINER) so the
-- policy does NOT recurse into itself.
create or replace function public.my_conversation_ids()
returns setof uuid language sql stable security definer set search_path = public
as $$ select cp.conversation_id from public.conversation_participants cp
      where cp.user_id = auth.uid(); $$;
revoke all on function public.my_conversation_ids() from public, anon;
grant execute on function public.my_conversation_ids() to authenticated;

drop policy if exists "participants_insert" on public.conversation_participants;
create policy "participants_insert" on public.conversation_participants for insert to authenticated with check (user_id = auth.uid() or conversation_id in (select public.my_conversation_ids()));
