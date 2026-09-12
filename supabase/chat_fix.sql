-- ============================================================
-- GEN Z — CHAT START FIX
-- The original conversations_insert policy required a
-- participant row to already exist for the brand-new
-- conversation (impossible) → creating a chat always failed.
-- Run this whole file in the Supabase SQL editor.
-- ============================================================

-- Allow an authenticated user to create a conversation.
-- (Participants are inserted right after — the next policy guards that.)
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations
  for insert to authenticated
  with check (true);

-- Allow inserting participants: yourself first, then other people
-- once you're already a participant of that conversation
-- (this is how "start chat with @james" adds both users).
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
