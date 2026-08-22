-- ============================================================
-- Gen Z — Chat 2.0 (RUN THIS after chat-fix.sql + streak.sql)
-- Groups, media/typed messages, replies, soft delete, seen,
-- typing + online (typing/presence ride on realtime broadcast).
-- ============================================================

-- conversations: group support
alter table public.conversations add column if not exists type text not null default 'direct'
  check (type in ('direct', 'group'));
alter table public.conversations add column if not exists name text;
alter table public.conversations add column if not exists avatar_url text;
alter table public.conversations add column if not exists created_by uuid
  references public.profiles(id) on delete set null;

-- per-participant read marker (drives seen status + unread counts)
alter table public.conversation_participants add column if not exists last_read_at timestamptz;

-- messages: reply + typed content + soft delete
alter table public.messages add column if not exists reply_to uuid
  references public.messages(id) on delete set null;
alter table public.messages add column if not exists msg_type text not null default 'text'
  check (msg_type in ('text', 'image', 'video', 'voice', 'gif'));
alter table public.messages add column if not exists deleted_at timestamptz;

-- online status (updated by the app on open/foreground)
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- RLS: own-message update (soft delete), own-participant update (read marker)
drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own" on public.messages
  for update using (sender_id = auth.uid()) with check (sender_id = auth.uid());

drop policy if exists "participants_update_own" on public.conversation_participants;
create policy "participants_update_own" on public.conversation_participants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- sanity: select id, type, name from public.conversations limit 5;
