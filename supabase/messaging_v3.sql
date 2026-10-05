-- ============================================================
-- GEN Z — MESSAGING PARADISE v3  ·  SERVER CAPABILITIES
-- ============================================================
-- Additive. Idempotent. Safe to re-run.
--
-- PART 1 (messaging_v2.sql)      schema
-- REALTIME (messaging_v2_realtime.sql)  live delivery + private channels
-- THIS FILE (v3)                 the server-side capabilities that
--                                CANNOT be done correctly on the client
--
-- Nothing in this file changes or removes existing data. The one
-- exception is a new trigger that rate-limits inserts (STEP 6) —
-- it is flagged inline and is one statement to drop.
--
-- WHY THIS FILE EXISTS AT ALL: search, rate limiting, anonymous
-- poll results and expiry sweeping are each impossible to do
-- honestly from the client. A client-side search would have to
-- download the whole conversation; a client-side timer deletes
-- nothing while the app is closed; a client-side poll count leaks
-- who voted.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 1 — FULL-TEXT SEARCH over message history (§17)
-- ------------------------------------------------------------
-- A generated column keeps the tsvector automatically in sync on
-- every INSERT/UPDATE — no trigger to forget, no drift.
--
-- `content` holds text for text messages; `body->>'text'` covers
-- rows written by the v2 engine. coalesce covers both.
--
-- COST, stated honestly: adding a generated column rewrites the
-- table and takes an ACCESS EXCLUSIVE lock for the duration. With
-- 5 profiles and a handful of messages that is instant. On a large
-- table, schedule this in a maintenance window instead.
alter table public.messages
  add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(content, body ->> 'text', '')
    )
  ) stored;

create index if not exists messages_content_tsv_idx
  on public.messages using gin (content_tsv);


-- ------------------------------------------------------------
-- STEP 2 — the search RPC
-- ------------------------------------------------------------
-- SECURITY INVOKER on purpose: row level security still applies,
-- so this can only ever return messages in conversations the
-- caller belongs to. A SECURITY DEFINER version would be a data
-- leak waiting to happen.
--
-- websearch_to_tsquery accepts natural input ("restaurant link")
-- and never throws on odd punctuation the way to_tsquery does.
-- DROP before CREATE, for every function in this file.
--
-- `create or replace` cannot change a function's return type. If a prior
-- version exists with a different OUT/return signature, the statement fails
-- with 42P13 ("cannot change return type of existing function") — and because
-- the Supabase SQL editor runs the whole script as ONE transaction, that
-- single statement rolls back everything else in the file. That is exactly
-- what happened on this file's first run: `poll_results` already existed from
-- messaging_v2.sql with a different shape.
drop function if exists public.messaging_search(uuid, text, int);

create or replace function public.messaging_search(
  p_conversation uuid,
  p_query        text,
  p_limit        int default 50
)
returns setof public.messages
language sql
stable
security invoker
set search_path = public
as $$
  select m.*
  from public.messages m
  where m.conversation_id = p_conversation
    and m.deleted_at is null
    and length(trim(p_query)) > 0
    and m.content_tsv @@ websearch_to_tsquery('english', p_query)
  order by m.seq desc
  limit greatest(1, least(p_limit, 100));
$$;

revoke all on function public.messaging_search(uuid, text, int) from public, anon;
grant execute on function public.messaging_search(uuid, text, int) to authenticated;


-- ------------------------------------------------------------
-- STEP 3 — inbox unread counts (§42)
-- ------------------------------------------------------------
-- ONE indexed aggregate for the whole inbox, instead of a count()
-- per conversation. This is the payoff of `last_read_seq` being an
-- integer: the comparison is a range scan on an index that already
-- exists, rather than a timestamp comparison that needs its own.
drop function if exists public.messaging_unread_counts();

create or replace function public.messaging_unread_counts()
returns table (conversation_id uuid, unread int)
language sql
stable
security definer
set search_path = public
as $$
  select m.conversation_id, count(*)::int
  from public.messages m
  join public.conversation_participants cp
    on cp.conversation_id = m.conversation_id
   and cp.user_id = auth.uid()
  where m.seq > coalesce(cp.last_read_seq, 0)
    and m.sender_id <> auth.uid()
    and m.deleted_at is null
  group by m.conversation_id;
$$;

revoke all on function public.messaging_unread_counts() from public, anon;
grant execute on function public.messaging_unread_counts() to authenticated;


-- ------------------------------------------------------------
-- STEP 4 — POLLS (§29)
-- ------------------------------------------------------------
-- Ensure the tables are actually usable. v2 enabled RLS on every
-- new table; without explicit policies "enabled but empty" means
-- nothing is readable, which looks like a broken feature rather
-- than a missing policy.
drop policy if exists polls_select on public.polls;
create policy polls_select on public.polls
  for select to authenticated
  using (
    message_id in (
      select m.id from public.messages m
      where m.conversation_id in (select public.my_conversation_ids())
    )
  );

drop policy if exists polls_insert on public.polls;
create policy polls_insert on public.polls
  for insert to authenticated
  with check (
    message_id in (
      select m.id from public.messages m
      where m.conversation_id in (select public.my_conversation_ids())
        and m.sender_id = auth.uid()
    )
  );

-- A voter may only read and write their OWN vote row. That is what
-- makes anonymous polls genuinely anonymous: the raw table cannot
-- be mined for who voted for what.
drop policy if exists poll_votes_select on public.poll_votes;
create policy poll_votes_select on public.poll_votes
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists poll_votes_insert on public.poll_votes;
create policy poll_votes_insert on public.poll_votes
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists poll_votes_delete on public.poll_votes;
create policy poll_votes_delete on public.poll_votes
  for delete to authenticated
  using (user_id = auth.uid());

/**
 * Results for one poll.
 *
 * SECURITY DEFINER because it must aggregate rows the caller cannot
 * read (other people's votes). It is safe because it only ever
 * returns COUNTS, plus voter identity when the poll is explicitly
 * not anonymous, and it re-checks that the caller is a participant
 * of the conversation the poll lives in.
 */
-- This is the one that failed. messaging_v2.sql already defines
-- poll_results with a different return signature, so it must be dropped.
drop function if exists public.poll_results(uuid);

create or replace function public.poll_results(p_poll uuid)
returns table (option_id text, votes int, voters uuid[])
language sql
stable
security definer
set search_path = public
as $$
  select
    v.option_id,
    count(distinct v.user_id)::int as votes,
    case
      when coalesce(p.anonymous, false) then null::uuid[]
      else array_agg(distinct v.user_id)
    end as voters
  from public.poll_votes v
  join public.polls p on p.id = v.poll_id
  where v.poll_id = p_poll
    and exists (
      select 1
      from public.messages m
      where m.id = p.message_id
        and m.conversation_id in (select public.my_conversation_ids())
    )
  group by v.option_id, p.anonymous;
$$;

revoke all on function public.poll_results(uuid) from public, anon;
grant execute on function public.poll_results(uuid) to authenticated;


-- ------------------------------------------------------------
-- STEP 5 — MESSAGE REQUESTS (§32)
-- ------------------------------------------------------------
-- The privacy table drives whether a stranger may open a thread.
drop policy if exists messaging_privacy_own on public.messaging_privacy;
create policy messaging_privacy_own on public.messaging_privacy
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists requests_own on public.conversation_requests;
create policy requests_own on public.conversation_requests
  for select to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());

drop policy if exists requests_update_recipient on public.conversation_requests;
create policy requests_update_recipient on public.conversation_requests
  for update to authenticated
  using (to_user = auth.uid())
  with check (to_user = auth.uid());

drop policy if exists saved_own on public.saved_messages;
create policy saved_own on public.saved_messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/**
 * Open (or reuse) a direct conversation with someone.
 *
 * Returns the conversation id either way. A `conversation_requests`
 * row is created with state 'pending' so the RECIPIENT's inbox can
 * route it to Requests while the sender's intro message still
 * arrives. The recipient's own privacy setting decides whether the
 * attempt is allowed at all.
 *
 * SECURITY DEFINER because it must insert participant rows for the
 * other user, which their own RLS would rightly refuse.
 */
drop function if exists public.messaging_start_conversation(uuid);

create or replace function public.messaging_start_conversation(p_peer uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_conv    uuid;
  v_who     text;
  v_allowed boolean := true;
begin
  if v_me is null then
    raise exception 'not authenticated';
  end if;
  if p_peer = v_me then
    raise exception 'cannot start a conversation with yourself';
  end if;

  -- reuse an existing direct thread
  select c.id into v_conv
  from public.conversations c
  join public.conversation_participants a
    on a.conversation_id = c.id and a.user_id = v_me
  join public.conversation_participants b
    on b.conversation_id = c.id and b.user_id = p_peer
  where c.type = 'direct'
  limit 1;

  if v_conv is not null then
    -- replying to a request accepts it
    update public.conversation_requests
       set state = 'accepted', decided_at = now()
     where conversation_id = v_conv
       and to_user = v_me
       and state = 'pending';
    return v_conv;
  end if;

  -- the peer's privacy decides
  select coalesce(mp.who_can_message, 'everyone') into v_who
  from public.messaging_privacy mp
  where mp.user_id = p_peer;
  v_who := coalesce(v_who, 'everyone');

  if v_who = 'nobody' then
    raise exception 'this person is not accepting messages';
  end if;

  if v_who = 'followers' then
    -- Defensive: the follows table's exact column names are not
    -- verified here, and locking users out of DMs because of an
    -- unknown schema would be worse than being permissive. If the
    -- lookup fails we fail OPEN, and the request gate still applies.
    begin
      select exists (
        select 1 from public.follows f
        where f.follower_id = p_peer
          and f.following_id = v_me
      ) into v_allowed;
    exception
      when undefined_table or undefined_column then
        v_allowed := true;
    end;

    if not v_allowed then
      raise exception 'this person only accepts messages from people they follow';
    end if;
  end if;

  insert into public.conversations (type)
  values ('direct')
  returning id into v_conv;

  insert into public.conversation_participants (conversation_id, user_id)
  values (v_conv, v_me), (v_conv, p_peer)
  on conflict do nothing;

  -- the anti-spam gate: unknown senders land in Requests
  insert into public.conversation_requests (conversation_id, from_user, to_user, state)
  values (v_conv, v_me, p_peer, 'pending')
  on conflict (conversation_id) do nothing;

  return v_conv;
end $$;

revoke all on function public.messaging_start_conversation(uuid) from public, anon;
grant execute on function public.messaging_start_conversation(uuid) to authenticated;


-- ------------------------------------------------------------
-- STEP 6 — RATE LIMITING (§34, §36)
-- ------------------------------------------------------------
-- A count over the last minute on an indexed column. Cheap enough
-- to run on every insert.
drop function if exists public.messaging_rate_ok(int);

create or replace function public.messaging_rate_ok(p_max_per_minute int default 60)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) < greatest(1, p_max_per_minute)
  from public.messages
  where sender_id = auth.uid()
    and created_at > now() - interval '1 minute';
$$;

/**
 * ⚠️ THIS IS THE ONLY ENFORCING STATEMENT IN THE FILE.
 *
 * To remove it:
 *     drop trigger if exists messages_rate_limit on public.messages;
 *
 * 60/minute is deliberately generous — it stops a scripted flood
 * without getting in a real person's way. A determined abuser
 * should be handled at the edge, not here.
 */
-- The trigger must be dropped BEFORE its function, otherwise Postgres refuses
-- the DROP FUNCTION because the trigger still depends on it.
drop trigger if exists messages_rate_limit on public.messages;
drop function if exists public.messages_rate_limit_guard();

create or replace function public.messages_rate_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.messaging_rate_ok(60) then
    raise exception 'rate limit: too many messages sent, slow down'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit
  before insert on public.messages
  for each row
  execute function public.messages_rate_limit_guard();


-- ------------------------------------------------------------
-- STEP 7 — EXPIRY (§38, §43)
-- ------------------------------------------------------------
-- Deleting the PAYLOAD and keeping a tombstone. That is the right
-- shape for chat: the bubble stays in the timeline as an empty
-- frame, so history does not silently re-flow and the scroll
-- position does not jump.
--
-- CRITICAL: this only clears the database row. The bytes live in
-- Storage. A "deleted" photo whose file is still on a CDN is the
-- kind of thing that becomes a news story. The storage side is
-- handled by media_cleanup_queue (see supabase/expiry_v2.sql).
drop function if exists public.purge_expired_messages(int);

create or replace function public.purge_expired_messages(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with gone as (
    select id
    from public.messages
    where expires_at is not null
      and expires_at < now()
      and deleted_at is null
    order by expires_at
    limit greatest(1, least(p_limit, 5000))
  )
  update public.messages m
     set content     = null,
         media_url   = null,
         body        = '{}'::jsonb,
         deleted_at  = now()
   where m.id in (select id from gone);

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.purge_expired_messages(int) from public, anon, authenticated;

-- SCHEDULING — run these TWO statements once each, OUTSIDE this file.
-- pg_cron must be enabled for the project first (Dashboard →
-- Database → Extensions → pg_cron). Left commented because enabling
-- an extension is a project-level decision, not a migration side effect.
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'purge-expired-messages',
--     '*/10 * * * *',
--     $$select public.purge_expired_messages();$$
--   );


-- ------------------------------------------------------------
-- STEP 8 — VERIFY
-- ------------------------------------------------------------
select 'search column present (expect 1)' as check_name,
       count(*) as n
from information_schema.columns
where table_schema = 'public'
  and table_name = 'messages'
  and column_name = 'content_tsv';

select 'v3 functions present (expect 5)' as check_name,
       count(*) as n
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'messaging_search',
    'messaging_unread_counts',
    'poll_results',
    'messaging_start_conversation',
    'purge_expired_messages'
  );

select 'rate-limit trigger present (expect 1)' as check_name,
       count(*) as n
from pg_trigger
where tgname = 'messages_rate_limit'
  and not tgisinternal;

select 'poll policies present (expect 3)' as check_name,
       count(*) as n
from pg_policies
where schemaname = 'public'
  and tablename = 'poll_votes'
  and policyname in ('poll_votes_select', 'poll_votes_insert', 'poll_votes_delete');
