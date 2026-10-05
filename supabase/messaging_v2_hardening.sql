-- ============================================================
-- GEN Z — MESSAGING PARADISE v2  ·  PART 2: HARDENING
-- ============================================================
--
-- ⚠️  DO NOT RUN THIS YET.  ⚠️
--
-- Running this file before the client is updated will BREAK two
-- working features in your live app. Read why, then run it only
-- when the checklist at the bottom is satisfied.
--
-- ────────────────────────────────────────────────────────────
-- WHAT PROBLEM THIS FIXES
-- ────────────────────────────────────────────────────────────
-- supabase/chat_settings.sql:56 currently grants EVERY participant
-- UPDATE power over EVERY row in the message table:
--
--   create policy "messages_update_member" on public.messages
--     for update to authenticated
--     using (conversation_id in (select public.my_conversation_ids()))
--     with check (conversation_id in (select public.my_conversation_ids()));
--
-- USING lets any participant target any message in a conversation
-- they belong to, and WITH CHECK only re-validates conversation_id.
-- Nothing pins sender_id and nothing protects content.
--
-- Consequence: in a group, member A can UPDATE member B's message
-- and change its text, or reassign sender_id so it appears to have
-- come from C. The file's own comment says the policy was widened
-- so reactions, view-once "viewed_by" and disappearing sweeps would
-- work — the intent was to let members touch a row, but the effect
-- is that members can rewrite it.
--
-- Note the precise scope: messages_insert (schema.sql:295) DOES
-- require sender_id = auth.uid(), so nobody can forge a NEW message
-- as someone else. This is a write-after-the-fact integrity hole in
-- existing rows, among people who already share a conversation.
-- Real, but not impersonation from scratch.
--
-- ────────────────────────────────────────────────────────────
-- WHY RUNNING THIS NOW WOULD BREAK YOUR APP
-- ────────────────────────────────────────────────────────────
-- The current client writes reaction and view-once state ONTO the
-- message row, which is exactly what needs UPDATE power over rows
-- it does not own. Tighten the policy first and these break:
--   1. reactions        — sender-only UPDATE means the recipient
--                         can no longer react to your message
--   2. view-once media  — the recipient can no longer append
--                         themselves to messages.viewed_by, so
--                         viewed media would keep re-opening
--   3. disappearing     — needs the sweeper to delete rows it
--                         does not own
--
-- PART 1 already created the replacement tables (message_reactions,
-- message_views). The client must be moved onto them BEFORE this
-- runs. That is a client change, not a database change.
--
-- ────────────────────────────────────────────────────────────
-- WHAT THIS FILE DOES
-- ────────────────────────────────────────────────────────────

-- 1) Restore author-only editing.
drop policy if exists "messages_update_member" on public.messages;
drop policy if exists "messages_update_own"    on public.messages;

create policy "messages_update_own" on public.messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- 2) Belt and braces: even the author cannot rewrite identity.
--    A trigger closes what a policy cannot express.
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.sender_id <> old.sender_id then
    raise exception 'sender_id is immutable';
  end if;
  if new.conversation_id <> old.conversation_id then
    raise exception 'conversation_id is immutable';
  end if;
  if new.client_message_id is distinct from old.client_message_id then
    raise exception 'client_message_id is immutable';
  end if;
  if new.seq is distinct from old.seq then
    raise exception 'seq is immutable';
  end if;

  -- stamp the edit time in the database; never trust a client clock
  if new.content is distinct from old.content
     or new.body is distinct from old.body then
    new.edited_at := now();
  end if;

  return new;
end $$;

drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update
  before update on public.messages
  for each row execute function public.messages_guard_update();

-- 3) Disappearing messages must be swept by the server, not by a
--    client DELETE policy. SECURITY DEFINER bypasses RLS by design.
create or replace function public.purge_expired_messages(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  with expired as (
    select id from public.messages
    where expires_at is not null
      and expires_at < now()
      and deleted_at is null
    order by expires_at
    limit p_limit
  ), upd as (
    -- soft-delete first so clients can render "message expired"
    update public.messages m
       set deleted_at = now(), content = null, body = '{}'::jsonb
      from expired e
     where m.id = e.id
    returning m.id
  )
  select count(*) into v_count from upd;

  -- queue the bytes for real deletion (reuses expiry_v2.sql's table if present)
  if to_regclass('public.media_cleanup_queue') is not null then
    execute $q$
      insert into public.media_cleanup_queue (storage_bucket, storage_path)
      select a.storage_bucket, a.storage_path
      from public.message_attachments a
      join public.messages m on m.id = a.message_id
      where m.deleted_at is not null and a.storage_path is not null
    $q$;
  end if;

  return v_count;
end $$;

revoke all on function public.purge_expired_messages(int) from public, anon;
grant execute on function public.purge_expired_messages(int) to authenticated;

-- 4) Private realtime channels. Without this, broadcast channels are
--    PUBLIC: anyone who learns a conversation UUID can subscribe to
--    its typing/presence traffic. The client must subscribe with
--    { config: { private: true } } for this policy to be consulted.
drop policy if exists "realtime_join_own_conversations" on realtime.messages;
create policy "realtime_join_own_conversations"
on realtime.messages for select to authenticated
using (
  realtime.topic() in (
    select 'conv:' || cp.conversation_id::text
    from public.conversation_participants cp
    where cp.user_id = auth.uid()
  )
);

-- ============================================================
-- PRE-FLIGHT CHECKLIST — all four must be true before running
-- ============================================================
-- [ ] 1. Client reactions read/write public.message_reactions
--        (not messages.reaction).
-- [ ] 2. Client view-once writes public.message_views
--        (not messages.viewed_by).
-- [ ] 3. Client disappearing messages rely on purge_expired_messages()
--        scheduled server-side, not on a client DELETE.
-- [ ] 4. Client realtime subscribes with { private: true }.
--
-- Then verify with:
--   select policyname, cmd from pg_policies
--   where schemaname='public' and tablename='messages' order by cmd;
--   -- expect exactly: INSERT, SELECT, UPDATE (own only), DELETE (member)
-- ============================================================
