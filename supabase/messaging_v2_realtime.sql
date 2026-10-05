-- ============================================================
-- GEN Z — MESSAGING PARADISE v2  ·  REALTIME + PRIVATE CHANNELS
-- ============================================================
-- Additive and idempotent. Safe to re-run.
--
-- This is a separate file from messaging_v2.sql because it does one
-- thing: make live delivery actually work, and make it not leak.
--
-- READ THIS BEFORE ADDING CHAT COLUMNS AGAIN:
-- a realtime channel's `filter:` is applied by the server only to
-- rows the subscriber is ALREADY allowed to see, but a BROADCAST
-- channel has no such protection by default. Anyone who learns a
-- conversation's UUID can subscribe to `conv:<uuid>` in the clear.
-- Conv UUIDs are not secrets — they appear in API responses, deep
-- links and screenshots. Hence steps 3 and 4 below.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 1 — publish the chat tables to realtime.
-- Without this, message inserts never reach the other client live:
-- messages only appear on reload, and typing/read receipts do not
-- sync at all.
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['messages', 'conversation_participants', 'conversations']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added public.% to supabase_realtime', t;
    end if;
  end loop;
end $$;


-- ------------------------------------------------------------
-- STEP 2 — REPLICA IDENTITY FULL.
--
-- Supabase Realtime cannot send the OLD row for UPDATE/DELETE
-- unless the table replicates its full identity. Without this,
-- a delete arrives with no id, so the client cannot remove the
-- bubble — the "ghost message" bug. This is the single most
-- commonly missed step when wiring Supabase realtime.
--
-- TRADE-OFF, stated honestly: REPLICA IDENTITY FULL makes
-- Postgres write the entire previous row into the WAL for every
-- UPDATE and DELETE, so WAL volume grows. That is the right
-- trade here because `messages` is updated rarely (edits, soft
-- deletes) versus how often it is inserted. Do NOT apply it to
-- high-churn tables like `presence`.
-- ------------------------------------------------------------
alter table public.messages               replica identity full;
alter table public.message_reactions      replica identity full;
alter table public.conversation_participants replica identity full;


-- ------------------------------------------------------------
-- STEP 3 — AUTHORISE PRIVATE BROADCAST CHANNELS.
--
-- A user may join the topic for a conversation only if they are a
-- participant of it. The client must subscribe with
-- `{ config: { private: true } }` for this policy to be consulted;
-- with a public channel it is ignored entirely and the channel is
-- open to the internet.
--
-- This is additive: it only ever GRANTS topics that RLS permits,
-- and it does not affect any existing public channel, because
-- public channels never evaluate this policy.
-- ------------------------------------------------------------
-- NOTE — one statement you might expect here is deliberately ABSENT:
--
--     alter table realtime.messages enable row level security;
--
-- Do NOT add it back. Row level security is ALREADY enabled on
-- realtime.messages by Supabase itself, and re-issuing the ALTER requires
-- OWNERSHIP of that table. The SQL editor runs as `postgres`, but
-- realtime.messages is owned by `supabase_realtime_admin`, so the statement
-- fails with:
--
--     ERROR: 42501: must be owner of table messages
--
-- Because the Supabase SQL editor wraps a multi-statement script in ONE
-- transaction, that single redundant line rolled back this entire file,
-- including the replica-identity and policy statements that DO work.
-- Verified by running each statement separately: the three REPLICA IDENTITY
-- statements and the CREATE POLICY below all succeed as `postgres`.
--
-- Lesson worth keeping: on Supabase, role ownership differs per schema.
-- `public.*` is owned by `postgres`; `realtime.*` is not.

-- Private channel authorisation. This CREATE POLICY succeeds as `postgres`
-- even though it does not own the table, because Supabase grants it that right.
drop policy if exists "realtime_join_own_conversations" on realtime.messages;
create policy "realtime_join_own_conversations"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() in (
    select 'conv:' || cp.conversation_id::text
    from public.conversation_participants cp
    where cp.user_id = auth.uid()
  )
);


-- ------------------------------------------------------------
-- STEP 4 — VERIFY
-- ------------------------------------------------------------
select 'chat tables in realtime publication (expect 3)' as check_name,
       count(*) as n
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('messages', 'conversation_participants', 'conversations');

select 'replica identity full (expect 3)' as check_name,
       count(*) as n
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('messages', 'message_reactions', 'conversation_participants')
  and c.relreplident = 'f';

select 'private-channel policy present (expect 1)' as check_name,
       count(*) as n
from pg_policies
where schemaname = 'realtime'
  and tablename = 'messages'
  and policyname = 'realtime_join_own_conversations';
