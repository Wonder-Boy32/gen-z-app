-- ============================================================
-- GEN Z — MESSAGING HARDENING v2 (corrected)
-- ============================================================
-- Supersedes: messaging_v2_hardening.sql
-- Additive and idempotent. Safe to re-run. Requires nothing from v1.
--
-- WHY A v2 EXISTS — the bug in v1
-- v1 tightened message updates to the author only:
--
--     create policy "messages_update_own" on public.messages
--       for update using (sender_id = auth.uid());
--
-- That is the right instinct but it silently breaks PINNING. The message menu
-- offers Pin on ANY message, not just your own (ConversationScreen, the one
-- action not gated on authorship). Pinning someone else's message is an UPDATE
-- on a row you do not own. Under an author-only policy RLS filters that row
-- out, so the statement affects ZERO rows and raises NO error — the pin just
-- quietly never sticks. Silent failure is the worst outcome, so v1 was not run.
--
-- THE FIX
-- RLS is row-level and cannot say "only the author may change content". So the
-- split moves: the POLICY answers "may this user touch this row?" (any
-- participant may) and a TRIGGER answers "may this user change this column?"
-- (author only, except the pin). That is the only place a column rule can live.
--
-- AUDIT OF EVERY WRITE THE CLIENT MAKES TO public.messages
-- (src/messaging/api.ts — the new engine; the old ChatThread is unused)
--   L175 insert            send
--   L221 update            edit        -> content/body/edited_at   (author)
--   L239 update            delete all  -> deleted_at/content/body  (author)
--   L343 update            pin/unpin   -> pinned_at/pinned_by      (ANY member)
--   L421/L464 insert       forward / create
--   L495 delete            hard delete
--   L505 update            poll attach -> body                     (author)
-- Pin is the ONLY non-author write. Nothing else needs the old looseness.
--
-- PRE-FLIGHT (verified before writing this file)
--   [x] reactions write public.message_reactions  (api.ts:256), not messages
--   [x] delete-for-me writes public.message_hides (api.ts:247), not messages
--   [x] the client never writes viewed_by / message_views
--   [x] the client never calls purge_expired_messages, so it runs server-side
--   [x] messages has sender_id, conversation_id, client_message_id, seq,
--       content, body, edited_at, deleted_at, pinned_at, pinned_by, expires_at
-- ============================================================


-- ------------------------------------------------------------
-- 1) UPDATE policy — participant level, so pinning still works.
--
-- `my_conversation_ids()` is SECURITY DEFINER (chat-fix.sql), which is what
-- keeps this recursion-free. A raw subquery on conversation_participants here
-- would re-enter that table's own RLS and fail.
-- ------------------------------------------------------------
drop policy if exists "messages_update_own"    on public.messages;
drop policy if exists "messages_update_member" on public.messages;

create policy "messages_update_member" on public.messages
  for update to authenticated
  using (conversation_id in (select public.my_conversation_ids()))
  with check (conversation_id in (select public.my_conversation_ids()));


-- ------------------------------------------------------------
-- 2) Column-level guard.
--
-- Immutable identity for EVERYONE, including the author. Then: a non-author
-- may change nothing except the pin. The whole row is compared as jsonb with
-- the pin columns removed, so any column added in future is protected by
-- default rather than silently left writable.
-- ------------------------------------------------------------
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid     uuid    := auth.uid();
  v_purging boolean := coalesce(current_setting('app.msg_purge', true), 'off') = 'on';
  -- the ONLY columns a non-author is allowed to touch
  v_open    text[]  := array['pinned_at', 'pinned_by'];
begin
  -- identity is immutable for everyone
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

  -- author-only content.
  --
  -- v_uid IS NULL means there is no end-user JWT: a server-side job, where the
  -- only writer is the purge below. v_purging covers the case where an
  -- authenticated user invokes purge_expired_messages(), which legitimately
  -- clears content on OTHER people's expired messages.
  if not v_purging and v_uid is not null and v_uid <> old.sender_id then
    if (to_jsonb(new) - v_open) is distinct from (to_jsonb(old) - v_open) then
      raise exception 'only the author may change this message';
    end if;
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


-- ------------------------------------------------------------
-- 3) Disappearing messages are swept by the server, not by a client DELETE
--    policy. SECURITY DEFINER bypasses RLS by design.
-- ------------------------------------------------------------
create or replace function public.purge_expired_messages(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  -- Tell the guard this is a server sweep, not a user editing someone else's
  -- message. Transaction-local (third arg true), so it cannot leak into any
  -- later statement on the same pooled connection.
  perform set_config('app.msg_purge', 'on', true);

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

  perform set_config('app.msg_purge', 'off', true);

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


-- ------------------------------------------------------------
-- 4) Private realtime channels. Without this, broadcast channels are PUBLIC:
--    anyone who learns a conversation UUID can subscribe to its typing and
--    call traffic. The client must subscribe with { config: { private: true } }
--    for this policy to be consulted.
--
--    Only 'conv:' topics are listed, which is why call signalling rides that
--    channel instead of opening its own.
-- ------------------------------------------------------------
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
-- VERIFY AFTER RUNNING
-- ============================================================
-- a) policies on messages — expect UPDATE (member), DELETE (member), plus
--    INSERT/SELECT from earlier files.
--      select policyname, cmd from pg_policies
--      where schemaname='public' and tablename='messages' order by cmd;
--
-- b) the guard trigger is wired:
--      select tgname from pg_trigger
--      where tgrelid = 'public.messages'::regclass and not tgisinternal;
--
-- c) the purge bypass does NOT leak: after any purge call,
--      select current_setting('app.msg_purge', true);   -- expect NULL or 'off'
--
-- d) FUNCTIONAL CHECK — the whole point of this file. As user A, try to pin a
--    message sent by user B. It must persist. Then try to change its content;
--    it must raise 'only the author may change this message'.
