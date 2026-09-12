-- ============================================================
-- Gen Z - CHAT RECURSION FIX (run this ENTIRE file once)
-- Error: "infinite recursion detected in policy for relation
--         conversation_participants"
-- Cause: participants_select / participants_insert policies
--        queried conversation_participants inside their own
--        USING / WITH CHECK. Postgres rejects self-recursion.
-- Fix:   resolve "my conversation ids" via a SECURITY DEFINER
--        helper (runs as owner, bypasses RLS), then policies
--        reference the helper. All statements are single-line
--        and ASCII-only to survive any copy/paste path.
-- ============================================================

-- 1) Helper function (idempotent)
create or replace function public.my_conversation_ids() returns setof uuid language sql stable security definer set search_path = public as $$ select cp.conversation_id from public.conversation_participants cp where cp.user_id = auth.uid(); $$;
revoke all on function public.my_conversation_ids() from public, anon;
grant execute on function public.my_conversation_ids() to authenticated;

-- 2) conversations_insert: allow creating a brand-new conversation.
--    (The old policy required a participant row to already exist at
--    insert time - impossible - so every create was rejected.)
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations for insert to authenticated with check (true);

-- 3) participants_select: see your own rows...
drop policy if exists "participants_select" on public.conversation_participants;
create policy "participants_select_own" on public.conversation_participants for select to authenticated using (user_id = auth.uid());
-- ...and all rows of conversations you are in
create policy "participants_select_member" on public.conversation_participants for select to authenticated using (conversation_id in (select public.my_conversation_ids()));

-- 4) participants_insert: add yourself...
drop policy if exists "participants_insert" on public.conversation_participants;
create policy "participants_insert_own" on public.conversation_participants for insert to authenticated with check (user_id = auth.uid());
-- ...or add people to a conversation you are already in (start chat with @james inserts both rows)
create policy "participants_insert_member" on public.conversation_participants for insert to authenticated with check (conversation_id in (select public.my_conversation_ids()));

-- 5) Sanity check - expected policies on these tables:
--    conversations_insert, conversations_select,
--    participants_select_own, participants_select_member,
--    participants_insert_own, participants_insert_member,
--    participants_update_own, messages_insert, messages_select,
--    messages_update_own
select schemaname, tablename, policyname, cmd from pg_policies where tablename in ('conversations', 'conversation_participants', 'messages') order by tablename, cmd;
