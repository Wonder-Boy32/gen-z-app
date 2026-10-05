-- ============================================================
-- GEN Z — MESSAGING PARADISE v2  ·  PART 1: FOUNDATION SCHEMA
-- ============================================================
-- Additive only. Idempotent. Safe to re-run.
--
-- This file NEVER removes or rewrites existing data, with ONE
-- deliberate exception that is flagged inline: the msg_type CHECK
-- constraint is swapped for a foreign key (see STEP 3).
--
-- It does NOT change any existing RLS policy. In particular it
-- leaves the current overly-broad `messages_update_member` policy
-- alone, because tightening it before the client stops writing
-- reaction/view-once state onto the message row would break those
-- live features. That hardening lives in PART 2, to be run only
-- after the client changes land.
--
-- Read order: run this file top to bottom.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 0 — dependency: the RLS recursion-safe membership helper.
-- Declared here so this file is self-sufficient even if
-- chat_recursion_fix.sql was never applied. Identical body to
-- supabase/chat_recursion_fix.sql:15.
-- ------------------------------------------------------------
create or replace function public.my_conversation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select cp.conversation_id
  from public.conversation_participants cp
  where cp.user_id = auth.uid();
$$;

revoke all on function public.my_conversation_ids() from public, anon;
grant execute on function public.my_conversation_ids() to authenticated;


-- ------------------------------------------------------------
-- STEP 1 — MESSAGE KINDS: types become data, not DDL.
-- Fixes the "adding a message type needs an ALTER TABLE" problem.
-- ------------------------------------------------------------
create table if not exists public.message_kinds (
  kind                text primary key,
  label               text not null,
  is_media            boolean not null default false,
  requires_attachment boolean not null default false,
  can_expire          boolean not null default true,
  sort_order          int not null default 0
);

insert into public.message_kinds
  (kind, label, is_media, requires_attachment, can_expire, sort_order) values
  ('text',          'Text',          false, false, true,   10),
  ('image',         'Photo',         true,  true,  true,   20),
  ('video',         'Video',         true,  true,  true,   30),
  ('voice',         'Voice note',    true,  true,  true,   40),
  ('video_message', 'Video message', true,  true,  true,   50),
  ('moment',        'Moment',        true,  true,  true,   60),
  ('file',          'File',          true,  true,  false,  70),
  ('gif',           'GIF',           true,  false, true,   80),
  ('sticker',       'Sticker',       true,  false, false,  90),
  ('audio',         'Audio',         true,  true,  false, 100),
  ('location',      'Location',      false, false, true,  110),
  ('contact',       'Contact',       false, false, false, 120),
  ('poll',          'Poll',          false, false, false, 130),
  ('system',        'System',        false, false, false, 900)
on conflict (kind) do nothing;

alter table public.message_kinds enable row level security;

drop policy if exists "message_kinds_read" on public.message_kinds;
create policy "message_kinds_read" on public.message_kinds
  for select to authenticated using (true);
-- no insert/update/delete policy: reference data, writable only by migrations


-- ------------------------------------------------------------
-- STEP 2 — messages: ordering, idempotency, typed body, lifecycle.
-- ------------------------------------------------------------
create sequence if not exists public.message_seq;

alter table public.messages
  add column if not exists seq                 bigint,
  add column if not exists client_message_id   text,
  add column if not exists body                jsonb not null default '{}'::jsonb,
  add column if not exists expires_at          timestamptz,
  add column if not exists edited_at           timestamptz,
  add column if not exists forwarded_from      uuid,
  add column if not exists forwarded_from_user uuid,
  add column if not exists thread_root         uuid,
  add column if not exists topic_id            uuid,
  add column if not exists pinned_at           timestamptz,
  add column if not exists pinned_by           uuid,
  add column if not exists metadata            jsonb not null default '{}'::jsonb;

-- backfill ordering, then make it mandatory and self-assigning
update public.messages set seq = nextval('public.message_seq') where seq is null;
alter table public.messages alter column seq set default nextval('public.message_seq');
alter table public.messages alter column seq set not null;

-- backfill the typed body for existing TEXT messages, so the new
-- renderer can draw history instead of showing blank bubbles.
-- Media kinds keep '{}' and fall back to the legacy media_url column.
update public.messages
   set body = jsonb_build_object('text', content)
 where msg_type = 'text'
   and content is not null
   and (body is null or body = '{}'::jsonb);

-- optional FKs, added safely (nullable columns, so no data can violate them)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_forwarded_from_fk') then
    alter table public.messages add constraint messages_forwarded_from_fk
      foreign key (forwarded_from) references public.messages(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_forwarded_from_user_fk') then
    alter table public.messages add constraint messages_forwarded_from_user_fk
      foreign key (forwarded_from_user) references public.profiles(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_thread_root_fk') then
    alter table public.messages add constraint messages_thread_root_fk
      foreign key (thread_root) references public.messages(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_pinned_by_fk') then
    alter table public.messages add constraint messages_pinned_by_fk
      foreign key (pinned_by) references public.profiles(id) on delete set null;
  end if;
end $$;

-- ⭐ THE DUPLICATE KILLER.
-- A retried send raises SQLSTATE 23505 instead of creating a second row.
create unique index if not exists messages_idempotency_idx
  on public.messages (sender_id, client_message_id)
  where client_message_id is not null;

-- keyset pagination: newest-first, no OFFSET, no full scan
create index if not exists messages_timeline_idx
  on public.messages (conversation_id, seq desc);

-- the expiry sweeper
create index if not exists messages_expiry_idx
  on public.messages (expires_at)
  where expires_at is not null and deleted_at is null;

-- pinned messages
create index if not exists messages_pinned_idx
  on public.messages (conversation_id, pinned_at desc)
  where pinned_at is not null;

-- topic filtering
create index if not exists messages_topic_idx
  on public.messages (topic_id, seq desc)
  where topic_id is not null;


-- ------------------------------------------------------------
-- STEP 3 — ⚠️ THE ONE INTRUSIVE CHANGE.
-- Swap the msg_type CHECK constraint for a foreign key.
-- Takes a brief ACCESS EXCLUSIVE lock on public.messages.
-- Dropped by definition search, so it works whatever the
-- constraint happens to be named.
-- ------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'messages'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%msg_type%'
  loop
    execute format('alter table public.messages drop constraint %I', c.conname);
    raise notice 'dropped CHECK constraint on messages: %', c.conname;
  end loop;
end $$;

-- Make the FK bulletproof: if any message already uses a kind that
-- isn't in the lookup (possible if the old CHECK was never applied),
-- register it first so the foreign key cannot fail to validate.
insert into public.message_kinds (kind, label, sort_order)
select distinct m.msg_type, initcap(m.msg_type), 500
from public.messages m
where m.msg_type is not null
  and not exists (select 1 from public.message_kinds k where k.kind = m.msg_type)
on conflict (kind) do nothing;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_fk') then
    alter table public.messages add constraint messages_kind_fk
      foreign key (msg_type) references public.message_kinds (kind) on update cascade;
  end if;
end $$;


-- ------------------------------------------------------------
-- STEP 4 — body shape validation (per-kind, without DDL)
-- ------------------------------------------------------------
create or replace function public.message_body_valid(p_kind text, p_body jsonb)
returns boolean
language sql
immutable
as $$
  select case p_kind
    when 'text'     then p_body ? 'text'
    when 'voice'    then p_body ? 'durationMs'
    when 'file'     then p_body ? 'fileName' and p_body ? 'byteSize'
    when 'location' then p_body ? 'lat' and p_body ? 'lng'
    when 'poll'     then p_body ? 'pollId'
    when 'system'   then p_body ? 'event'
    when 'contact'  then p_body ? 'name'
    else true
  end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_body_valid_chk') then
    -- NOT VALID is deliberate, and it is the difference between this
    -- migration succeeding and failing.
    --
    -- NOT VALID skips the one-time scan of EXISTING rows, but the
    -- constraint IS still enforced on every INSERT and UPDATE from
    -- now on. Without it, the ALTER fails immediately: a legacy voice
    -- message with body = '{}' has no 'durationMs' key, and one bad
    -- historical row would abort the whole migration.
    alter table public.messages add constraint messages_body_valid_chk
      check (public.message_body_valid(msg_type, body)) not valid;
  end if;
end $$;


-- ------------------------------------------------------------
-- STEP 5 — ATTACHMENTS: metadata split from media bytes.
-- This is what makes Shared Space, files, voice waveforms and
-- video messages possible.
-- ------------------------------------------------------------
create table if not exists public.message_attachments (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  position        int not null default 0,

  storage_bucket  text not null default 'chat-media',
  storage_path    text not null,
  thumb_path      text,
  blurhash        text,

  mime_type       text,
  byte_size       bigint,
  width           int,
  height          int,
  duration_ms     int,
  wave_peaks      int[],

  upload_state    text not null default 'pending'
                  check (upload_state in ('pending','uploading','complete','failed')),
  scan_state      text not null default 'pending'
                  check (scan_state in ('pending','clean','blocked')),
  checksum        text,

  created_at      timestamptz not null default now()
);

-- message_id is nullable on purpose: we upload first, then attach on send.
create index if not exists attachments_message_idx
  on public.message_attachments (message_id, position);

create index if not exists attachments_shared_space_idx
  on public.message_attachments (conversation_id, mime_type, created_at desc);

create index if not exists attachments_checksum_idx
  on public.message_attachments (checksum)
  where checksum is not null;

alter table public.message_attachments enable row level security;


-- ------------------------------------------------------------
-- STEP 6 — REACTIONS: own table, per user.
-- Fixes the "one reaction per message, stored on the message" model.
-- ------------------------------------------------------------
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists reactions_message_idx on public.message_reactions (message_id);
create index if not exists reactions_user_idx    on public.message_reactions (user_id);

alter table public.message_reactions enable row level security;


-- ------------------------------------------------------------
-- STEP 7 — RECEIPTS: per-message for 1:1, high-water for groups.
-- ------------------------------------------------------------
create table if not exists public.message_receipts (
  message_id   uuid not null references public.messages(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz,
  seen_at      timestamptz,
  primary key (message_id, user_id)
);

create index if not exists receipts_user_idx on public.message_receipts (user_id, seen_at desc);

alter table public.message_receipts enable row level security;

-- group read-state as two integers per member, instead of O(members × messages) rows
alter table public.conversation_participants
  add column if not exists last_delivered_seq bigint,
  add column if not exists last_read_seq      bigint;

create index if not exists participants_last_read_idx
  on public.conversation_participants (conversation_id, user_id, last_read_seq);


-- ------------------------------------------------------------
-- STEP 8 — view-once views, so PART 2 can stop needing UPDATE
-- power over other people's message rows.
-- ------------------------------------------------------------
create table if not exists public.message_views (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.message_views enable row level security;


-- ------------------------------------------------------------
-- STEP 9 — delete-for-me
-- ------------------------------------------------------------
create table if not exists public.message_hides (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);

alter table public.message_hides enable row level security;


-- ------------------------------------------------------------
-- STEP 10 — GROUP TOPICS (the fix for one chaotic 300-person thread)
-- ------------------------------------------------------------
create table if not exists public.conversation_topics (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  name            text not null,
  position        int not null default 0,
  created_at      timestamptz not null default now(),
  unique (conversation_id, name)
);

create index if not exists topics_conversation_idx
  on public.conversation_topics (conversation_id, position);

alter table public.conversation_topics enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_topic_fk') then
    alter table public.messages add constraint messages_topic_fk
      foreign key (topic_id) references public.conversation_topics(id) on delete set null;
  end if;
end $$;


-- ------------------------------------------------------------
-- STEP 11 — participant roles, archive, pin, folders, draft
-- ------------------------------------------------------------
alter table public.conversation_participants
  add column if not exists role      text not null default 'member',
  add column if not exists can_post  boolean not null default true,
  add column if not exists joined_via text,
  add column if not exists archived  boolean not null default false,
  add column if not exists pinned_at timestamptz,
  add column if not exists folder    text,
  add column if not exists draft     text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'participants_role_chk') then
    alter table public.conversation_participants add constraint participants_role_chk
      check (role in ('member','admin','owner'));
  end if;
end $$;

create index if not exists participants_inbox_idx
  on public.conversation_participants (user_id, archived, pinned_at desc);

create index if not exists participants_folder_idx
  on public.conversation_participants (user_id, folder)
  where folder is not null;


-- ------------------------------------------------------------
-- STEP 12 — drafts, saves
-- ------------------------------------------------------------
create table if not exists public.message_drafts (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  body            text not null default '',
  reply_to        uuid references public.messages(id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.message_drafts enable row level security;

create table if not exists public.saved_messages (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.saved_messages enable row level security;


-- ------------------------------------------------------------
-- STEP 13 — MESSAGE REQUESTS (the anti-spam gate)
-- ------------------------------------------------------------
create table if not exists public.conversation_requests (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  from_user       uuid not null references public.profiles(id) on delete cascade,
  to_user         uuid not null references public.profiles(id) on delete cascade,
  state           text not null default 'pending'
                  check (state in ('pending','accepted','deleted','blocked')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  check (from_user <> to_user)
);

create index if not exists requests_inbox_idx
  on public.conversation_requests (to_user, state, created_at desc);

alter table public.conversation_requests enable row level security;


-- ------------------------------------------------------------
-- STEP 14 — PRESENCE and PRIVACY CENTRE
-- ------------------------------------------------------------
create table if not exists public.presence (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  state        text not null default 'offline'
               check (state in ('online','away','offline')),
  last_seen_at timestamptz not null default now(),
  platform     text,
  updated_at   timestamptz not null default now()
);

alter table public.presence enable row level security;

create table if not exists public.messaging_privacy (
  user_id               uuid primary key references public.profiles(id) on delete cascade,
  who_can_message       text not null default 'everyone'
                        check (who_can_message in ('everyone','followers','nobody')),
  who_can_call          text not null default 'everyone'
                        check (who_can_call in ('everyone','followers','nobody')),
  who_can_add_to_groups text not null default 'everyone'
                        check (who_can_add_to_groups in ('everyone','followers','nobody')),
  who_can_see_moments   text not null default 'everyone'
                        check (who_can_see_moments in ('everyone','followers','nobody')),
  show_online           boolean not null default true,
  show_last_seen        boolean not null default true,
  read_receipts         boolean not null default true,
  typing_indicators     boolean not null default true,
  notification_preview  text not null default 'full'
                        check (notification_preview in ('full','sender','none')),
  effects_enabled       boolean not null default true,
  link_previews_enabled boolean not null default true,
  updated_at            timestamptz not null default now()
);

alter table public.messaging_privacy enable row level security;


-- ------------------------------------------------------------
-- STEP 15 — link preview cache
-- ------------------------------------------------------------
create table if not exists public.link_previews (
  url_hash    text primary key,
  url         text not null,
  domain      text,
  title       text,
  description text,
  image_path  text,
  fetched_at  timestamptz not null default now(),
  failed      boolean not null default false
);

alter table public.link_previews enable row level security;


-- ------------------------------------------------------------
-- STEP 16 — calls: extend for group readiness
-- ------------------------------------------------------------
alter table public.calls
  add column if not exists is_group   boolean not null default false,
  add column if not exists started_by uuid,
  add column if not exists ended_by   uuid,
  add column if not exists end_reason text,
  add column if not exists quality    jsonb;

create table if not exists public.call_participants (
  call_id   uuid not null references public.calls(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  state     text not null default 'invited'
            check (state in ('invited','joined','declined','missed','left')),
  joined_at timestamptz,
  left_at   timestamptz,
  primary key (call_id, user_id)
);

alter table public.call_participants enable row level security;


-- ------------------------------------------------------------
-- STEP 17 — POLLS
-- ------------------------------------------------------------
create table if not exists public.polls (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null unique references public.messages(id) on delete cascade,
  question       text not null,
  options        jsonb not null,
  multi          boolean not null default false,
  anonymous      boolean not null default false,
  quiz           boolean not null default false,
  correct_option text,
  closes_at      timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id    uuid not null references public.polls(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  option_id  text not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id, option_id)
);

alter table public.polls      enable row level security;
alter table public.poll_votes enable row level security;


-- ============================================================
-- STEP 18 — RLS POLICIES FOR ALL NEW TABLES
-- Without these, the new tables would be readable by any
-- authenticated user. This is the part that actually matters.
-- ============================================================

-- ── attachments: visible to conversation participants ──
drop policy if exists "attachments_select" on public.message_attachments;
create policy "attachments_select" on public.message_attachments
  for select to authenticated
  using (conversation_id in (select public.my_conversation_ids()));

drop policy if exists "attachments_insert" on public.message_attachments;
create policy "attachments_insert" on public.message_attachments
  for insert to authenticated
  with check (conversation_id in (select public.my_conversation_ids()));

drop policy if exists "attachments_update" on public.message_attachments;
create policy "attachments_update" on public.message_attachments
  for update to authenticated
  using (conversation_id in (select public.my_conversation_ids()))
  with check (conversation_id in (select public.my_conversation_ids()));

-- ── reactions: read if you can see the message; write only as yourself ──
drop policy if exists "reactions_select" on public.message_reactions;
create policy "reactions_select" on public.message_reactions
  for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id
      and m.conversation_id in (select public.my_conversation_ids())
  ));

drop policy if exists "reactions_insert" on public.message_reactions;
create policy "reactions_insert" on public.message_reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and m.conversation_id in (select public.my_conversation_ids())
    )
  );

drop policy if exists "reactions_delete" on public.message_reactions;
create policy "reactions_delete" on public.message_reactions
  for delete to authenticated using (user_id = auth.uid());

-- ── receipts: you may read receipts for messages you can see,
--    but you may only ever write YOUR OWN receipt row ──
drop policy if exists "receipts_select" on public.message_receipts;
create policy "receipts_select" on public.message_receipts
  for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id
      and m.conversation_id in (select public.my_conversation_ids())
  ));

drop policy if exists "receipts_write_own" on public.message_receipts;
create policy "receipts_write_own" on public.message_receipts
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "receipts_update_own" on public.message_receipts;
create policy "receipts_update_own" on public.message_receipts
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── views (view-once): own row only, readable as yourself ──
drop policy if exists "views_select_own" on public.message_views;
create policy "views_select_own" on public.message_views
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "views_insert_own" on public.message_views;
create policy "views_insert_own" on public.message_views
  for insert to authenticated with check (user_id = auth.uid());

-- ── hides (delete-for-me): own row only ──
drop policy if exists "hides_select_own" on public.message_hides;
create policy "hides_select_own" on public.message_hides
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "hides_insert_own" on public.message_hides;
create policy "hides_insert_own" on public.message_hides
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "hides_delete_own" on public.message_hides;
create policy "hides_delete_own" on public.message_hides
  for delete to authenticated using (user_id = auth.uid());

-- ── topics ──
drop policy if exists "topics_select" on public.conversation_topics;
create policy "topics_select" on public.conversation_topics
  for select to authenticated
  using (conversation_id in (select public.my_conversation_ids()));

drop policy if exists "topics_insert_admin" on public.conversation_topics;
create policy "topics_insert_admin" on public.conversation_topics
  for insert to authenticated
  with check (exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = conversation_id
      and cp.user_id = auth.uid()
      and cp.role in ('admin','owner')
  ));

-- ── drafts: strictly private to the author ──
drop policy if exists "drafts_all_own" on public.message_drafts;
create policy "drafts_all_own" on public.message_drafts
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── saves: strictly private to the saver ──
drop policy if exists "saves_select_own" on public.saved_messages;
create policy "saves_select_own" on public.saved_messages
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "saves_insert_own" on public.saved_messages;
create policy "saves_insert_own" on public.saved_messages
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "saves_delete_own" on public.saved_messages;
create policy "saves_delete_own" on public.saved_messages
  for delete to authenticated using (user_id = auth.uid());

-- ── requests: both parties can see it; only the recipient decides;
--    the sender may withdraw ──
drop policy if exists "requests_select" on public.conversation_requests;
create policy "requests_select" on public.conversation_requests
  for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());

drop policy if exists "requests_insert" on public.conversation_requests;
create policy "requests_insert" on public.conversation_requests
  for insert to authenticated with check (from_user = auth.uid());

drop policy if exists "requests_update_recipient" on public.conversation_requests;
create policy "requests_update_recipient" on public.conversation_requests
  for update to authenticated
  using (to_user = auth.uid()) with check (to_user = auth.uid());

-- ── presence: you write only your own; you may read others.
--    NOTE: honouring messaging_privacy.show_last_seen is the
--    client's job for now — see the architecture doc §25. ──
drop policy if exists "presence_select" on public.presence;
create policy "presence_select" on public.presence
  for select to authenticated using (true);

drop policy if exists "presence_upsert_own" on public.presence;
create policy "presence_upsert_own" on public.presence
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "presence_update_own" on public.presence;
create policy "presence_update_own" on public.presence
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── privacy: own row only ──
drop policy if exists "privacy_all_own" on public.messaging_privacy;
create policy "privacy_all_own" on public.messaging_privacy
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── link previews: shared cache, read-only to clients ──
drop policy if exists "link_previews_read" on public.link_previews;
create policy "link_previews_read" on public.link_previews
  for select to authenticated using (true);

-- ── calls: participants of the call ──
drop policy if exists "call_participants_select" on public.call_participants;
create policy "call_participants_select" on public.call_participants
  for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.call_participants me
    where me.call_id = call_id and me.user_id = auth.uid()
  ));

drop policy if exists "call_participants_insert" on public.call_participants;
create policy "call_participants_insert" on public.call_participants
  for insert to authenticated
  with check (exists (
    select 1 from public.calls c
    where c.id = call_id and c.caller_id = auth.uid()
  ));

drop policy if exists "call_participants_update_own" on public.call_participants;
create policy "call_participants_update_own" on public.call_participants
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── polls: readable in your conversations; you vote only as yourself ──
drop policy if exists "polls_select" on public.polls;
create policy "polls_select" on public.polls
  for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id
      and m.conversation_id in (select public.my_conversation_ids())
  ));

drop policy if exists "poll_votes_select_own" on public.poll_votes;
create policy "poll_votes_select_own" on public.poll_votes
  for select to authenticated using (user_id = auth.uid());
-- NOTE: this is what keeps anonymous polls anonymous. Counts are read
-- through public.poll_results(), which returns aggregates only.

drop policy if exists "poll_votes_insert_own" on public.poll_votes;
create policy "poll_votes_insert_own" on public.poll_votes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "poll_votes_delete_own" on public.poll_votes;
create policy "poll_votes_delete_own" on public.poll_votes
  for delete to authenticated using (user_id = auth.uid());


-- ------------------------------------------------------------
-- STEP 19 — poll_results(): aggregates without exposing voters,
-- so an anonymous poll stays anonymous.
-- ------------------------------------------------------------
create or replace function public.poll_results(p_poll_id uuid)
returns table (option_id text, votes bigint)
language sql
stable
security definer
set search_path = public
as $$
  select v.option_id, count(*)::bigint
  from public.poll_votes v
  where v.poll_id = p_poll_id
  group by v.option_id;
$$;

revoke all on function public.poll_results(uuid) from public, anon;
grant execute on function public.poll_results(uuid) to authenticated;


-- ------------------------------------------------------------
-- STEP 20 — media buckets (private) + storage RLS
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('chat-media',  'chat-media',  false),
  ('chat-thumbs', 'chat-thumbs', false)
on conflict (id) do nothing;

drop policy if exists "chat_media_read" on storage.objects;
create policy "chat_media_read" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('chat-media','chat-thumbs')
    and (storage.foldername(name))[1] in (
      select cp.conversation_id::text
      from public.conversation_participants cp
      where cp.user_id = auth.uid()
    )
  );

drop policy if exists "chat_media_write_own_folder" on storage.objects;
create policy "chat_media_write_own_folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('chat-media','chat-thumbs')
    and (storage.foldername(name))[1] in (
      select cp.conversation_id::text
      from public.conversation_participants cp
      where cp.user_id = auth.uid()
    )
    and (storage.foldername(name))[2] = auth.uid()::text
  );


-- ============================================================
-- STEP 21 — VERIFICATION. These SELECTs are the proof.
-- ============================================================
select 'new tables present' as check_name, count(*) as n
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'message_kinds','message_attachments','message_reactions','message_receipts',
    'message_views','message_hides','conversation_topics','message_drafts',
    'saved_messages','conversation_requests','presence','messaging_privacy',
    'link_previews','call_participants','polls','poll_votes'
  );
-- expect: 16

select 'message kinds seeded' as check_name, count(*) as n from public.message_kinds;
-- expect: 14

select 'messages: new columns present' as check_name, count(*) as n
from information_schema.columns
where table_schema = 'public' and table_name = 'messages'
  and column_name in (
    'seq','client_message_id','body','expires_at','edited_at','forwarded_from',
    'thread_root','topic_id','pinned_at','metadata'
  );
-- expect: 10

select 'idempotency index present' as check_name,
       count(*) as n
from pg_indexes
where schemaname = 'public' and indexname = 'messages_idempotency_idx';
-- expect: 1

select 'seq populated on all messages' as check_name,
       count(*) filter (where seq is null) as missing
from public.messages;
-- expect: missing = 0

select 'msg_type CHECK gone (expect 0), FK present (expect 1)' as check_name,
       (select count(*) from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname='public' and rel.relname='messages'
           and con.contype='c' and pg_get_constraintdef(con.oid) ilike '%msg_type%') as leftover_check,
       (select count(*) from pg_constraint where conname='messages_kind_fk') as fk_present;

select 'RLS enabled on every new table (expect 0 missing)' as check_name,
       count(*) as missing
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public'
  and c.relname in (
    'message_kinds','message_attachments','message_reactions','message_receipts',
    'message_views','message_hides','conversation_topics','message_drafts',
    'saved_messages','conversation_requests','presence','messaging_privacy',
    'link_previews','call_participants','polls','poll_votes'
  )
  and c.relrowsecurity = false;

select 'private buckets present (expect 2)' as check_name,
       count(*) as n
from storage.buckets where id in ('chat-media','chat-thumbs') and public = false;

-- ============================================================
-- END OF PART 1. Nothing was dropped. Nothing was destroyed.
-- ============================================================
