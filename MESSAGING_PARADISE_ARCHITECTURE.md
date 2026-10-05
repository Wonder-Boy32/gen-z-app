# MESSAGING PARADISE — Architecture & UX Blueprint

> The conversation is the product. Everything else in the app is a doorway into it.

**Status:** design document, pre-implementation
**Scope:** the messaging system as a unified Conversation Engine
**Client:** React Native + Expo
**Backend:** Supabase (Postgres, RLS, Realtime, Storage) + Node/Express where server authority is required

---

## 0. VERDICT FIRST — what you actually have, before I design anything

You asked me to design the architecture before implementing. The most useful thing I can
put in this document is not a wishlist — it is the truth about your current messaging
implementation, because the design has to be a *migration*, not a fantasy.

### 0.1 What exists today (verified by reading the code)

| Layer | What exists | Evidence |
|---|---|---|
| Core tables | `conversations`, `conversation_participants`, `messages` | `supabase/schema.sql:150-170` |
| Group support | `conversations.type/name/avatar_url/created_by` | `supabase/chat2.sql:8-13` |
| Typed messages | `messages.msg_type` | `supabase/chat2.sql:21-22` |
| Replies | `messages.reply_to` | `supabase/chat2.sql:19-20` |
| Soft delete | `messages.deleted_at` | `supabase/chat2.sql:23` |
| Read marker | `conversation_participants.last_read_at` | `supabase/chat2.sql:16` |
| View-once media | `messages.view_once`, `messages.viewed_by` | `supabase/chat_upgrades.sql:49-50` |
| Disappearing timer | `conversations.disappear_seconds` | `supabase/chat_settings.sql:26` |
| Per-user chat prefs | `muted`, `muted_until`, `nickname`, `chat_color`, `wallpaper`, `sound_enabled` | `supabase/chat_settings.sql:15-20` |
| Group creation RPC | `create_group_conversation` | `supabase/chat_upgrades.sql:11` |
| Recursion-safe RLS helper | `my_conversation_ids()` | `supabase/chat_recursion_fix.sql:15` |
| Realtime | publication add for the 3 chat tables | `supabase/chat_realtime.sql:10-32` |
| Calls | `calls` table + `calls_start` | `supabase/calls.sql:8-18,36` |
| Blocking | `block_chat_user()` | `supabase/chat_settings.sql:71` |
| Chat UI | `ChatThread.tsx` (2,053 lines), `ChatsScreen.tsx` (947 lines) | file line counts |
| GIF picker | `src/components/GifPicker.tsx` | dir listing |
| Media bucket | one bucket, `media` | `storage.from('media')` ×2 |

So: **text messaging, groups, replies, reactions-ish, view-once, a chat timer and call
history all exist in some form.** That is a real head start and I am not going to pretend
otherwise — this is not a greenfield build.

### 0.2 But there is no engine — and that is the real problem

`src/services/` contains exactly three files: `genzplus.ts`, `profileStatus.ts`,
`verification.ts`. **There is no chat service.** All messaging logic is inline in two
screen components totalling ~3,000 lines.

That is the single most important fact in this document. Your §57 says:

> "Do not build this as a collection of disconnected features. Everything should be built
> around a unified Conversation Engine."

You do not currently have a Conversation Engine. You have a very large screen that
happens to fetch and render messages. Every feature you listed in §2–§55 — reactions,
forwarding, search, shared space, drafts, offline queue, delivery states — will make
`ChatThread.tsx` worse, not better, if it is added to that file. This design is therefore
structured around extracting and then growing an engine.

### 0.3 The six structural defects that block the spec

These are not missing features. They are *load-bearing decisions* that the spec's
requirements cannot be built on top of. Each one is cheap to fix now and expensive to fix
in six months.

**DEFECT 1 — Reactions are modelled backwards.**
`schema.sql:168` puts `reaction text` on `messages`. A reaction belongs to a *user about a
message*, not to the message itself. As written, the column can only ever hold one value
for the whole message, and (per the original `messages_update_own` policy in `chat2.sql:30`)
only the **sender** could write it — so the recipient, the person who actually wants to
react, could not. `chat_settings.sql:56` later widened UPDATE to any participant, which
makes it *possible* but still structurally one-reaction-per-message. You cannot have
"multiple reactions" (§5) without a `message_reactions` table.

**DEFECT 2 — One `media_url` column cannot carry an attachment.**
`schema.sql:167` is a single text column. Files (§19) need name, size, mime type, upload
progress and a thumbnail. Voice (§7) needs duration and a waveform. Video messages (§8)
need poster frames. Shared Space (§16) needs to *query* all media in a conversation by
type and date. None of that fits in a URL string.

**DEFECT 3 — Adding a message type requires DDL.**
`chat2.sql:21-22` constrains `msg_type` with
`check (msg_type in ('text','image','video','voice','gif'))`.
Your §46 asks for 14 types and says "future types should be easy to add." Today, adding
`sticker` means an `ALTER TABLE` on your hottest table — and on a live app, an
`ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT` takes an `ACCESS EXCLUSIVE` lock.
This must be a lookup table before you ship more types.

**DEFECT 4 — No idempotency, so duplicates are guaranteed.**
There is no `client_message_id`. Your §38 explicitly requires: *"The system should avoid
duplicate messages. Build proper message IDs and idempotency into the backend."* Today, if
a send times out and the app retries, you get two messages. This is not a theoretical
risk — it is certain on Nigerian mobile networks, which your §39 describes exactly.

**DEFECT 5 — "Sent / Delivered / Seen" is not actually tracked.**
There is `last_read_at` (a single timestamp per participant, giving a rough "seen"), but
nothing tracks *delivered*, and nothing ties a state to an individual message. §4 asks
for four reliable states on poor networks. One timestamp cannot express that.

**DEFECT 6 — No message-request gate.**
§32 wants first-contact from strangers to be gated. Today any user can insert a
`conversation` with anyone, so a stranger can talk to you immediately. Separately, this
is a live spam vector.

**DEFECT 7 — Any participant can rewrite anyone else's message text.** *(security)*
`supabase/chat_settings.sql:56-59`:

```sql
create policy "messages_update_member" on public.messages
  for update to authenticated
  using (conversation_id in (select public.my_conversation_ids()))
  with check (conversation_id in (select public.my_conversation_ids()));
```

`USING` lets you target *any* row in a conversation you belong to, and `WITH CHECK` only
re-validates `conversation_id`. Nothing pins `sender_id` and nothing protects `content`.
So in a group, participant A can `UPDATE` participant B's message and change its **text**,
or even reassign its **`sender_id`** to make it look like C said it. The file's own comment
says this was widened so reactions, view-once `viewed_by` and disappearing sweeps would
work — the intent was to let members *touch* a row, but the effect is that members can
*rewrite* it.

I want to be precise about severity rather than alarmist: `messages_insert`
(`schema.sql:295-297`) **does** correctly require `sender_id = auth.uid()`, so you cannot
forge a *new* message as someone else. This is a write-after-the-fact integrity hole in
existing rows, not an impersonation primitive, and it only affects people who already
share a conversation. But "my message says something I never wrote" is exactly the kind of
thing that destroys trust in a messaging product, and it is fixable with three lines.

The right fix is *not* to tighten the policy and break reactions — it is to stop storing
reaction and view-once state **on the message row** so the UPDATE power is no longer
needed. That is why §2 moves reactions and receipts into their own tables and restores
sender-only UPDATE, with a trigger that makes `sender_id` and `conversation_id`
immutable. Both policies are given in §2.6 and §10.

### 0.4 What I could NOT verify, and why it matters

I attempted to read the live database to confirm which of these migrations were actually
applied. **Your Supabase session in Chrome has expired**, so the dashboard redirected to
the login wall and I stopped rather than entering credentials or guessing.

This matters more than it sounds. Earlier in this project I verified that
`supabase/genzplus.sql` was **never applied** to your live database even though the file
exists in the repo — so *file present ≠ migration applied* in this project. The schema
facts in §0.1 are from the SQL files themselves, and I cannot yet confirm that `chat2.sql`,
`chat_upgrades.sql`, `chat_settings.sql` and `chat_realtime.sql` all landed in production.

**Action needed:** sign back in to Supabase in Chrome, then I will run a read-only
verification of the live chat schema before writing a single migration. I will not build
on an unverified foundation twice.

---

## 1. THE CONVERSATION ENGINE

### 1.1 The idea

Most messaging apps are a message list plus a growing pile of special cases. The reason
they rot is that each new feature reaches into the message list and adds an `if`.

A **Conversation Engine** inverts that. Everything that can happen inside a conversation —
a message, a reaction, an edit, a receipt, a call event, a system notice, a Moment — is
represented as **one thing**: an entry in a single ordered, append-only timeline. Features
then become *renderers and producers of entries*, not edits to the timeline itself.

This is the whole design. Everything below is consequence.

### 1.2 The three layers

```
┌──────────────────────────────────────────────────────────────┐
│  SURFACE        ConversationScreen + renderers                │
│                 Knows how to DRAW an entry. Knows no fetching. │
│                 Adding a message type = adding a renderer.     │
├──────────────────────────────────────────────────────────────┤
│  ENGINE         src/messaging/  (pure TypeScript, no React)    │
│                 Owns the timeline, optimistic state, the       │
│                 outbox, dedup, receipts, pagination, cache.     │
│                 Testable without a device. No UI imports.      │
├──────────────────────────────────────────────────────────────┤
│  CONTRACT       Postgres + RLS + RPC + Realtime + Storage      │
│                 The only place authority lives. Clients may     │
│                 never be trusted to assert identity or state.   │
└──────────────────────────────────────────────────────────────┘
```

The hard rule that keeps this from collapsing: **the Engine never imports React, and the
Surface never calls Supabase directly.** If a screen needs data, it asks the Engine. If the
Surface ever imports `supabase` again, the engine has failed.

### 1.3 One entry shape for everything

```ts
type EntryKind =
  | 'MESSAGE' | 'REACTION' | 'EDIT' | 'DELETE' | 'RECEIPT'
  | 'CALL' | 'SYSTEM' | 'PIN' | 'POLL_UPDATE';

interface TimelineEntry {
  id: string;                 // server id, or 'tmp:<uuid>' before ack
  conversationId: string;
  kind: EntryKind;            // what it IS
  actorId: string;            // who caused it
  createdAt: string;          // server-stamped
  seq: number;                // monotonic, for total ordering
  payload: EntryPayload;      // discriminated union, see §3
  clientMessageId?: string;   // idempotency key
  local?: LocalState;         // queued | sending | sent | failed
}
```

A reaction is not a column on a message. It is its own entry that *points at* a message.
A receipt is an entry. A missed call is an entry. That is what makes §2's twenty-item
message list, §5's reactions, §7's voice notes and §23's call history all land in the same
renderer pipeline instead of four separate subsystems.

### 1.4 Why this is worth doing before features

Because it is the difference between "add stickers" being a 40-line change and being a
2,000-line-file refactor. The engine is the *only* thing in this document that is
expensive to retrofit later.
---

## 2. DATABASE SCHEMA PROPOSAL

### 2.0 Migration rules

Every statement below obeys four rules, because this runs against a live app:

1. **Additive only.** No `DROP TABLE`, no `DROP COLUMN`, no data rewrite of existing rows.
2. **Idempotent.** `if not exists` / `drop policy if exists` throughout, so a failed run can
   be re-run without thinking.
3. **Backfill-safe.** New `not null` columns get a default or are populated before the
   constraint is added.
4. **One intrusive change, flagged.** The `msg_type` CHECK constraint must be dropped
   (DEFECT 3). It takes a brief `ACCESS EXCLUSIVE` lock on `messages`. At your current
   size (~5 profiles, test data) it is instant; do it now, never after launch.

Existing columns are **kept**. `media_url` stays and is treated as legacy; new media goes to
`message_attachments`. `messages.reaction` stays until Phase 3 retires it, so nothing breaks
while we migrate.

---

### 2.1 Message kinds — data, not DDL (fixes DEFECT 3)

```sql
-- The lookup that replaces a CHECK constraint. Adding a message type becomes an INSERT.
create table if not exists public.message_kinds (
  kind                text primary key,
  label               text not null,
  is_media            boolean not null default false,
  requires_attachment boolean not null default false,
  can_expire          boolean not null default true,
  sort_order          int not null default 0
);

insert into public.message_kinds (kind, label, is_media, requires_attachment, sort_order) values
  ('text',          'Text',          false, false,  10),
  ('image',         'Photo',         true,  true,   20),
  ('video',         'Video',         true,  true,   30),
  ('voice',         'Voice note',    true,  true,   40),
  ('video_message', 'Video message', true,  true,   50),
  ('moment',        'Moment',        true,  true,   60),
  ('file',          'File',          true,  true,   70),
  ('gif',           'GIF',           true,  false,  80),
  ('sticker',       'Sticker',       true,  false,  90),
  ('audio',         'Audio',         true,  true,  100),
  ('location',      'Location',      false, false, 110),
  ('contact',       'Contact',       false, false, 120),
  ('poll',          'Poll',          false, false, 130),
  ('system',        'System',        false, false, 900)
on conflict (kind) do nothing;

-- Now swap the constraint for a foreign key. Run these two together.
alter table public.messages drop constraint if exists messages_msg_type_check;

alter table public.messages
  add constraint messages_kind_fk
  foreign key (msg_type) references public.message_kinds (kind) on update cascade;
```

Adding "story reply" or "invoice" later is now one `insert`. No lock, no deploy.

---

### 2.2 `messages` — the timeline

```sql
create sequence if not exists public.message_seq;

alter table public.messages
  -- ordering + pagination
  add column if not exists seq               bigint,
  -- idempotency (fixes DEFECT 4)
  add column if not exists client_message_id text,
  -- typed payload, so one column serves all 14 kinds (see §3)
  add column if not exists body              jsonb not null default '{}'::jsonb,
  -- lifecycle
  add column if not exists expires_at        timestamptz,
  add column if not exists edited_at         timestamptz,
  add column if not exists forwarded_from    uuid references public.messages(id) on delete set null,
  add column if not exists forwarded_from_user uuid references public.profiles(id) on delete set null,
  add column if not exists thread_root       uuid references public.messages(id) on delete cascade,
  add column if not exists topic_id          uuid,  -- FK added in §2.7
  -- pinning
  add column if not exists pinned_at         timestamptz,
  add column if not exists pinned_by         uuid references public.profiles(id) on delete set null,
  -- escape hatch for future features that must not need a migration
  add column if not exists metadata          jsonb not null default '{}'::jsonb;

-- backfill ordering, then lock it down
update public.messages set seq = nextval('public.message_seq') where seq is null;
alter table public.messages alter column seq set default nextval('public.message_seq');
alter table public.messages alter column seq set not null;

-- ⭐ THE DUPLICATE KILLER. A retried send cannot create a second row.
create unique index if not exists messages_idempotency_idx
  on public.messages (sender_id, client_message_id)
  where client_message_id is not null;

-- pagination: newest-first keyset scan, no OFFSET, no full scan
create index if not exists messages_timeline_idx
  on public.messages (conversation_id, seq desc);

-- the expiry sweeper
create index if not exists messages_expiry_idx
  on public.messages (expires_at)
  where expires_at is not null and deleted_at is null;
```

**Why `seq` and not `created_at` alone.** Two messages inserted in the same millisecond
order non-deterministically by `created_at`, which makes pagination skip or repeat rows.
`seq` is globally monotonic, so `where seq < :cursor order by seq desc limit 50` is exact
and index-only. This is what makes §42 ("thousands of messages") actually work.

**Why the partial unique index works.** Insert with an existing
`(sender_id, client_message_id)` raises SQLSTATE `23505`. The client catches exactly that
code, treats it as *success*, and reconciles its optimistic bubble with the real row. No
server round-trip to check, no race, no duplicate. Offline retries become trivially safe.

---

### 2.3 Attachments — separate from message metadata (fixes DEFECT 2)

Your §43 asks for exactly this split. Here it is.

```sql
create table if not exists public.message_attachments (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.messages(id) on delete cascade,
  -- denormalised so RLS and Shared Space can filter without a join
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  position       int not null default 0,

  storage_bucket text not null default 'chat',
  storage_path   text not null,          -- object key. NEVER a public URL.
  thumb_path     text,                   -- small blurred placeholder
  blurhash       text,                   -- shown before the image loads

  mime_type      text,
  byte_size      bigint,
  width          int,
  height         int,
  duration_ms    int,
  wave_peaks     int[],                  -- voice-note waveform (§7), ~64 samples

  -- file-transfer UX (§19)
  upload_state   text not null default 'pending'
                 check (upload_state in ('pending','uploading','complete','failed')),
  -- moderation
  scan_state     text not null default 'pending'
                 check (scan_state in ('pending','clean','blocked')),
  checksum       text,                   -- dedupes the same file sent twice

  created_at     timestamptz not null default now()
);

create index if not exists attachments_message_idx
  on public.message_attachments (message_id, position);

-- powers Shared Space: "show me every photo in this conversation"
create index if not exists attachments_shared_space_idx
  on public.message_attachments (conversation_id, mime_type, created_at desc);

create index if not exists attachments_checksum_idx
  on public.message_attachments (checksum)
  where checksum is not null;
```

This one table is what makes §16 Shared Space, §19 file transfer, §7 voice waveforms,
§8 video messages and §17 media search possible. All of them are queries against it rather
than new subsystems.

---

### 2.4 Reactions — own table (fixes DEFECT 1)

```sql
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  -- a user may send several different reactions to one message (§5)
  primary key (message_id, user_id, emoji)
);

create index if not exists reactions_message_idx on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;

create policy "reactions_select" on public.message_reactions
  for select to authenticated
  using (message_id in (
    select m.id from public.messages m
    where m.conversation_id in (select public.my_conversation_ids())
  ));

-- you may only react as yourself, and only to messages you can see
create policy "reactions_insert" on public.message_reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and m.conversation_id in (select public.my_conversation_ids())
    ));

create policy "reactions_delete" on public.message_reactions
  for delete to authenticated using (user_id = auth.uid());
```

Now reactions are per-user, support multiple emoji, and **nobody can react as anybody
else**. If you later prefer one-reaction-per-user (WhatsApp style), change the primary key
to `(message_id, user_id)` — a one-line decision, not a redesign.

---

### 2.5 Receipts — per-message for 1:1, high-water for groups (fixes DEFECT 5)

This is the design decision I most want you to look at, because the obvious approach does
not scale.

```sql
-- Direct conversations only. Per-message, per-user.
create table if not exists public.message_receipts (
  message_id   uuid not null references public.messages(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz,
  seen_at      timestamptz,
  primary key (message_id, user_id)
);

-- Groups: a high-water mark per participant, NOT a row per message per member.
alter table public.conversation_participants
  add column if not exists last_delivered_seq bigint,
  add column if not exists last_read_seq      bigint;
```

**Why not per-message receipts for groups.** A 200-member group with 500 messages/day would
write 100,000 receipt rows *per day*, forever, to answer a question nobody asks ("show me
that Ada saw message #4,182"). Instead each member stores two integers, and bubble read-state
is a comparison: `message.seq <= participant.last_read_seq`. That is a single indexed read
of one row, and it is O(1) regardless of group size.

**For 1:1** you genuinely want per-message granularity — the ✓/✓✓ ticks and the "seen at
2:14pm" line under the last bubble. Two people means at most two rows per message, and only
for the most recent window of messages, not all history.

Which brings in the next rule, because it is how you keep this affordable:

```sql
-- Keep receipts only for the recent window. Older than 30 days, the ticks are noise.
-- (Wire this to pg_cron in §14; not run on insert.)
```

Receipts are also where §35 privacy lands: if `read_receipts = false`, you stop writing
`seen_at` for that user entirely. Note that this is a *real* trade-off, not a fake one:
WhatsApp's model is reciprocal — turn read receipts off and you also stop seeing everyone
else's. I recommend you copy that, because the alternative is that one person can read
invisibly while seeing everyone else's behaviour, which users correctly find unfair.

---

### 2.6 Write-integrity guards (fixes DEFECT 7)

```sql
-- Restore sender-only editing, so "edited" means the author edited it.
drop policy if exists "messages_update_member" on public.messages;
drop policy if exists "messages_update_own" on public.messages;

create policy "messages_update_own" on public.messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- Belt and braces: even the author cannot rewrite identity or relocate a message.
create or replace function public.messages_guard_update()
returns trigger language plpgsql as $$
begin
  if new.sender_id       <> old.sender_id       then raise exception 'sender_id is immutable'; end if;
  if new.conversation_id <> old.conversation_id then raise exception 'conversation_id is immutable'; end if;
  if new.client_message_id is distinct from old.client_message_id
     then raise exception 'client_message_id is immutable'; end if;
  if new.seq is distinct from old.seq then raise exception 'seq is immutable'; end if;
  -- stamp the edit time in the database; never trust a client clock
  if new.content is distinct from old.content or new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end $$;

drop trigger if exists messages_guard_update on public.messages;
create trigger messages_guard_update
  before update on public.messages
  for each row execute function public.messages_guard_update();
```

The same "stamp it in the database" principle you already applied to mood status in
`profile_status.sql` — a client can lie about time, so the server sets it.

**Consequence of this change, stated honestly:** view-once `viewed_by` and the
disappearing-message sweep previously relied on `messages_update_member`. Both must move
off it before this policy lands:

```sql
-- view-once: own row per viewer, mirroring receipts
create table if not exists public.message_views (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);
-- disappearing messages: deleted by a SECURITY DEFINER sweeper, which bypasses RLS
-- by design (see §14), not by a client DELETE policy.
```

Do those two first, then the guard. Sequence matters.

---

### 2.7 Groups, topics, drafts, saves, hides, requests

```sql
-- ── Group topics (§28): the fix for "one chaotic 300-person thread" ──
create table if not exists public.conversation_topics (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  name            text not null,
  position        int not null default 0,
  created_at      timestamptz not null default now(),
  unique (conversation_id, name)
);

alter table public.messages drop constraint if exists messages_topic_fk;
alter table public.messages
  add constraint messages_topic_fk
  foreign key (topic_id) references public.conversation_topics(id) on delete set null;

-- ── Roles (§27): the existing participants table gains a role ──
alter table public.conversation_participants
  add column if not exists role          text not null default 'member'
    check (role in ('member','admin','owner')),
  add column if not exists can_post      boolean not null default true,
  add column if not exists joined_via    text,          -- invite | added | request
  add column if not exists archived      boolean not null default false,
  add column if not exists pinned_at     timestamptz,   -- pin a CHAT (§31)
  add column if not exists folder        text,          -- §31 folders
  add column if not exists draft         text;          -- cheap draft, see note

-- ── Drafts (§37: "draft state should be handled intelligently") ──
create table if not exists public.message_drafts (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  body            text not null default '',
  reply_to        uuid references public.messages(id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ── My Saves (§18) ──
create table if not exists public.saved_messages (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- ── Delete-for-me (§4) ──
create table if not exists public.message_hides (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);

-- ── Message requests (§32): the anti-spam gate ──
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
```

**How the request gate actually behaves.** The requester is a participant and may send, so
their opening message really exists — the gate is not a lie where the message appears only
after you click accept. What the `pending` state controls is (a) that the conversation is
routed to your **Requests** surface, not your main inbox, and (b) that **no notification
fires**. On `deleted` or `blocked`, the participant rows are removed and RLS then denies the
sender from writing further — so a deleted request is genuinely dead, not merely hidden.

**On `draft` being in two places:** `conversation_participants.draft` is the fast path for
the chat list preview (no join). `message_drafts` is the durable copy that carries the reply
target. The engine writes both and reconciles on open. It's mild denormalisation, and it is
worth it because the chat list renders for every conversation on every app open.

---

### 2.8 Presence, privacy, link previews, calls

```sql
-- ── Presence (§25). Server-stamped, so "online" cannot be faked. ──
create table if not exists public.presence (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  state      text not null default 'offline' check (state in ('online','away','offline')),
  last_seen_at timestamptz not null default now(),
  platform   text,
  updated_at timestamptz not null default now()
);

-- ── Privacy centre (§35). One row per user, all the answers in one place. ──
create table if not exists public.messaging_privacy (
  user_id                 uuid primary key references public.profiles(id) on delete cascade,
  who_can_message         text not null default 'everyone'
                          check (who_can_message in ('everyone','followers','nobody')),
  who_can_call            text not null default 'everyone'
                          check (who_can_call in ('everyone','followers','nobody')),
  who_can_add_to_groups   text not null default 'everyone'
                          check (who_can_add_to_groups in ('everyone','followers','nobody')),
  who_can_see_moments     text not null default 'everyone'
                          check (who_can_see_moments in ('everyone','followers','nobody')),
  show_online             boolean not null default true,
  show_last_seen          boolean not null default true,
  read_receipts           boolean not null default true,
  typing_indicators       boolean not null default true,
  notification_preview    text not null default 'full'
                          check (notification_preview in ('full','sender','none')),
  effects_enabled         boolean not null default true,   -- §14
  link_previews_enabled   boolean not null default true,   -- §20
  updated_at              timestamptz not null default now()
);

-- ── Link previews (§20). Cached by URL hash so one fetch serves everyone. ──
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

-- ── Calls (§23/§24): extend the table you already have, ready for group ──
alter table public.calls
  add column if not exists is_group     boolean not null default false,
  add column if not exists started_by   uuid references public.profiles(id) on delete set null,
  add column if not exists ended_by     uuid references public.profiles(id) on delete set null,
  add column if not exists end_reason   text,
  add column if not exists quality      jsonb;

create table if not exists public.call_participants (
  call_id   uuid not null references public.calls(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  state     text not null default 'invited'
            check (state in ('invited','joined','declined','missed','left')),
  joined_at timestamptz,
  left_at   timestamptz,
  primary key (call_id, user_id)
);
```

`calls` already supports 1:1 only (`callee_id` is a single column). `call_participants` is
what lets group calling arrive later **without a rewrite** — the 1:1 rows become a
two-member call. That is the §23 requirement "designed so the call system can eventually
support group calls" answered structurally rather than with a comment.

---

### 2.9 Polls (§29)

```sql
create table if not exists public.polls (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null unique references public.messages(id) on delete cascade,
  question       text not null,
  options        jsonb not null,        -- [{ "id": "a", "label": "Yes" }, ...]
  multi          boolean not null default false,
  anonymous      boolean not null default false,
  quiz           boolean not null default false,
  correct_option text,
  closes_at      timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id   uuid not null references public.polls(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  option_id text not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id, option_id)
);
```

**The one subtlety:** an `anonymous` poll must not leak *who* voted, but the row must still
carry `user_id` so you can stop someone voting twice. So you keep the table private (RLS:
a user sees only their own vote row) and expose counts through a `SECURITY DEFINER`
function that returns aggregates only:

```sql
create or replace function public.poll_results(p_poll_id uuid)
returns table (option_id text, votes bigint)
language sql stable security definer set search_path = public as $$
  select v.option_id, count(*)::bigint
  from public.poll_votes v
  where v.poll_id = p_poll_id
  group by v.option_id;
$$;
```

Anyone can read the tally; nobody can read the voter list. Anonymous means anonymous.
---

## 3. THE MESSAGE MODEL — one envelope, fourteen shapes (§45, §46)

### 3.1 The envelope

Every kind shares the same envelope. Only `body` changes. This is what stops each new
message type from becoming a new table and a new code path.

```ts
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKind;          // FK -> message_kinds.kind
  seq: number;                // monotonic order
  createdAt: string;          // server clock
  editedAt?: string | null;
  expiresAt?: string | null;  // disappearing / moment
  deletedAt?: string | null;  // tombstone
  replyTo?: string | null;
  forwardedFrom?: string | null;
  forwardedFromUser?: string | null;
  body: MessageBody;          // discriminated union, below
  attachments: Attachment[];  // separate table
  reactions: Reaction[];      // separate table
  local?: LocalState;         // client-only: queued | sending | sent | failed
  clientMessageId?: string;   // idempotency key
}
```

### 3.2 The fourteen kinds

```ts
type MessageBody =
  | { type: 'text';          text: string }
  | { type: 'image';         caption?: string }
  | { type: 'video';         caption?: string }
  | { type: 'voice';         durationMs: number; transcript?: string }
  | { type: 'video_message'; durationMs: number; round: true }
  | { type: 'moment';        caption?: string; viewOnce: true }
  | { type: 'file';          fileName: string; byteSize: number; mime: string }
  | { type: 'gif';           provider: 'klipy' | 'tenor'; id: string; previewPath?: string }
  | { type: 'sticker';       packId: string; stickerId: string; animated: boolean }
  | { type: 'audio';         title?: string; artist?: string; durationMs: number }
  | { type: 'location';      lat: number; lng: number; liveUntil?: string; label?: string }
  | { type: 'contact';       userId?: string; name: string; phone?: string }
  | { type: 'poll';          pollId: string }
  | { type: 'system';        event: SystemEvent; actorId?: string; targetIds?: string[] };
```

`system` is the workhorse nobody plans for: "Ada added Ben", "This call lasted 4:12",
"You pinned a message", "Messages now disappear after 24h". **Every one of those is a
message**, which means they paginate, they respect the chat timer, they're searchable, and
the call history from `calls.sql` renders in the same list. That is the engine paying for
itself.

### 3.3 Validating shape without a migration

```sql
create or replace function public.message_body_valid(p_kind text, p_body jsonb)
returns boolean language sql immutable as $$
  select case p_kind
    when 'text'    then p_body ? 'text'
    when 'voice'   then p_body ? 'durationMs'
    when 'file'    then p_body ? 'fileName' and p_body ? 'byteSize'
    when 'location'then p_body ? 'lat' and p_body ? 'lng'
    when 'poll'    then p_body ? 'pollId'
    when 'system'  then p_body ? 'event'
    else true
  end;
$$;

alter table public.messages drop constraint if exists messages_body_valid_chk;
alter table public.messages
  add constraint messages_body_valid_chk
  check (public.message_body_valid(msg_type, body));
```

Now the database rejects a malformed voice note, and adding a kind with new body keys is
still just an `insert` + a one-line `case`.

### 3.4 The renderer registry — the client half

```ts
// src/messaging/registry.ts
export const renderers: Record<MessageKind, ComponentType<BubbleProps>> = {
  text: TextBubble, image: ImageBubble, video: VideoBubble, voice: VoiceBubble,
  video_message: VideoMessageBubble, moment: MomentBubble, file: FileBubble,
  gif: GifBubble, sticker: StickerBubble, audio: AudioBubble,
  location: LocationBubble, contact: ContactBubble, poll: PollBubble, system: SystemBubble,
};

// The entire message-list rendering logic, permanently:
const Bubble = renderers[message.kind] ?? UnknownBubble;
```

Adding "sticker" later is one line in this map plus one component. Contrast with the
current approach, where every type is another branch inside a 2,053-line file.

---

## 4. DELIVERY STATE MACHINE & OFFLINE BEHAVIOUR (§4, §38, §39, §55)

### 4.1 The states

```
                 ┌──────────────────────────────────────────┐
   user taps ⏎   │                                          │
        │        ▼                                          │
     ┌──────┐  ┌─────────┐  ┌──────┐  ┌───────────┐  ┌──────┐
     │queued├─▶│ sending ├─▶│ sent ├─▶│ delivered ├─▶│ seen │
     └──────┘  └────┬────┘  └──────┘  └───────────┘  └──────┘
        ▲           │
        │           ▼
        │      ┌────────┐   retry (backoff)
        └──────┤ failed │──────────────▶ sending
               └────────┘
```

- **queued** — written to the local outbox. Survives app kill. This is the state that
  makes the app feel unbroken with no connection (§38).
- **sending** — request in flight.
- **sent** — row exists server-side, `seq` assigned. *This is the only state the server owns
  for sure.*
- **delivered / seen** — derived from receipts, never guessed.
- **failed** — terminal until the user retries or connectivity returns.

### 4.2 The four rules that make it reliable

**Rule 1 — every send carries a `client_message_id`, generated once.** Not per attempt.
The same UUID is reused across every retry. This is the entire duplicate fix.

```ts
async function send(draft: Outgoing): Promise<Message> {
  const clientMessageId = draft.clientMessageId ?? crypto.randomUUID();

  const { data, error } = await supabase.rpc('messaging_send', {
    p_conversation_id: draft.conversationId,
    p_kind: draft.kind,
    p_body: draft.body,
    p_client_message_id: clientMessageId,
    p_reply_to: draft.replyTo ?? null,
    p_attachment_ids: draft.attachmentIds ?? [],
  });

  // 23505 = a row with this (sender_id, client_message_id) already exists.
  // That is SUCCESS from the user's point of view — the message is already there.
  if (error?.code === '23505' || data?.duplicate) {
    return reconcileWithServer(clientMessageId);
  }
  if (error) throw toSendError(error);
  return data.message;
}
```

**Rule 2 — the outbox is durable and ordered.** Persist it to SQLite (or `AsyncStorage`
for a first cut), keyed by conversation. On app foreground, flush in `seq`-of-creation
order, sequentially per conversation. Concurrent sends in one conversation are the main
source of out-of-order bubbles — send them one at a time and the problem disappears.

**Rule 3 — reconnect is a state reconciliation, not a replay.** On reconnect the engine
does not blindly re-send. It asks the server for the conversation's current high-water
`seq`, then decides per queued item: if `client_message_id` is already present → mark sent
and drop it from the outbox; else send. This is idempotent by construction, so a flaky
network cannot produce doubles no matter how many times it flaps.

**Rule 4 — never silently lose a message.** Every failure surfaces as a tappable bubble
with `Retry` and an explanation. §55 is right that this matters more than it sounds: the
single fastest way to lose a user's trust is a message that says "sent" and never arrived.

### 4.3 Handling the actual conditions in §39

| Condition | What the engine does |
|---|---|
| Slow data (2G) | 8s timeout on send; optimistically render as `sending`, never block the composer |
| Unstable data | exponential backoff 1s → 2s → 4s → 8s → 30s cap, with jitter to avoid thundering herd |
| Wi-Fi ↔ mobile switch | treat as a reconnect; run Rule 3 reconciliation |
| Temporary disconnect | items stay `queued`; a single banner, not per-message errors |
| App backgrounded | outbox flushed on `AppState` → `active` |
| Media on a bad line | resumable upload, §8.4 |

---

## 5. API STRUCTURE (§ requested: "API structure")

### 5.1 Principle

Two rules decide where logic lives:

1. **Anything that must be atomic** — send + attach + fan out receipts — is a Postgres
   function, not a chain of client calls. A client-side multi-step write will eventually
   be interrupted halfway and leave a message with no attachment.
2. **Anything the client must not be trusted for** — who the sender is, what time it is,
   whether you're allowed to message this person — is decided in the database.

There is no public REST API for messages. The RPC surface *is* the API.

### 5.2 The RPC surface

```sql
-- ── WRITE ───────────────────────────────────────────────────────────────
-- Send. Idempotent on (auth.uid(), p_client_message_id). THE hot path.
public.messaging_send(
  p_conversation_id uuid, p_kind text, p_body jsonb,
  p_client_message_id text, p_reply_to uuid default null,
  p_attachment_ids uuid[] default null, p_expires_at timestamptz default null
) returns jsonb        -- { message, duplicate: boolean }

public.messaging_edit(p_message_id uuid, p_body jsonb) returns jsonb
public.messaging_delete(p_message_id uuid, p_for_everyone boolean default false) returns void
public.messaging_forward(p_message_id uuid, p_to_conversation_ids uuid[]) returns uuid[]
public.messaging_pin(p_message_id uuid, p_pinned boolean) returns void

public.messaging_react(p_message_id uuid, p_emoji text) returns void
public.messaging_unreact(p_message_id uuid, p_emoji text) returns void

public.messaging_mark_delivered(p_conversation_id uuid, p_upto_seq bigint) returns void
public.messaging_mark_read(p_conversation_id uuid, p_upto_seq bigint) returns void
public.messaging_hide(p_message_id uuid) returns void          -- delete for me
public.messaging_save(p_message_id uuid, p_save boolean) returns void

-- ── READ ────────────────────────────────────────────────────────────────
public.messaging_timeline(p_conversation_id uuid, p_before_seq bigint default null,
                          p_limit int default 50) returns setof jsonb
public.messaging_shared_space(p_conversation_id uuid, p_kind text default null,
                              p_before timestamptz default null, p_limit int default 60)
  returns setof jsonb
public.messaging_search(p_conversation_id uuid, p_query text default null,
                        p_kinds text[] default null, p_from timestamptz default null,
                        p_to timestamptz default null, p_limit int default 50)
  returns setof jsonb
public.messaging_unread_counts() returns table (conversation_id uuid, unread int)

-- ── CONVERSATIONS ───────────────────────────────────────────────────────
public.conversation_open_direct(p_peer uuid) returns uuid   -- idempotent; makes request if needed
public.conversation_request_decide(p_conversation_id uuid, p_action text) returns void
public.conversation_create_group(p_name text, p_members uuid[]) returns uuid
public.conversation_add_topic(p_conversation_id uuid, p_name text) returns uuid

-- ── POLLS / MOMENTS / PRESENCE ──────────────────────────────────────────
public.poll_vote(p_poll_id uuid, p_option_ids text[]) returns jsonb
public.poll_results(p_poll_id uuid) returns table (option_id text, votes bigint)
public.presence_ping(p_state text) returns void
```

### 5.3 `messaging_send` — the one function that must be right

```sql
create or replace function public.messaging_send(
  p_conversation_id uuid, p_kind text, p_body jsonb,
  p_client_message_id text, p_reply_to uuid default null,
  p_attachment_ids uuid[] default null, p_expires_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := auth.uid();
  v_row    public.messages;
  v_conv   public.conversations;
  v_expires timestamptz := p_expires_at;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if p_client_message_id is null then raise exception 'client_message_id required'; end if;

  -- authority: membership is checked HERE, not trusted from the client
  if not exists (select 1 from public.conversation_participants
                 where conversation_id = p_conversation_id and user_id = v_me) then
    raise exception 'not a participant' using errcode = '42501';
  end if;

  if not exists (select 1 from public.message_kinds where kind = p_kind) then
    raise exception 'unknown message kind %', p_kind;
  end if;

  select * into v_conv from public.conversations where id = p_conversation_id;

  -- chat timer wins over the caller's suggestion
  if v_expires is null and v_conv.disappear_seconds is not null then
    v_expires := now() + make_interval(secs => v_conv.disappear_seconds);
  end if;

  -- ⭐ idempotent insert. The partial unique index turns a retry into a no-op.
  insert into public.messages
    (conversation_id, sender_id, kind_dummy, msg_type, body, client_message_id,
     reply_to, expires_at)
  select p_conversation_id, v_me, null, p_kind, p_body, p_client_message_id,
         p_reply_to, v_expires
  where not exists (
    select 1 from public.messages
    where sender_id = v_me and client_message_id = p_client_message_id
  )
  returning * into v_row;

  -- did we just insert, or was this a retry?
  if v_row.id is null then
    select * into v_row from public.messages
    where sender_id = v_me and client_message_id = p_client_message_id;
    return jsonb_build_object('message', to_jsonb(v_row), 'duplicate', true);
  end if;

  -- attach already-uploaded media to this message (atomic with the send)
  if p_attachment_ids is not null then
    update public.message_attachments
       set message_id = v_row.id, conversation_id = p_conversation_id
     where id = any(p_attachment_ids);
  end if;

  return jsonb_build_object('message', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function public.messaging_send(uuid,text,jsonb,text,uuid,uuid[],timestamptz)
  from public, anon;
grant execute on function public.messaging_send(uuid,text,jsonb,text,uuid,uuid[],timestamptz)
  to authenticated;
```

**One note on the sketch above:** the `insert ... select ... where not exists` pattern with
a `security definer` function is deliberate, but it is *not* race-proof on its own — two
concurrent calls can both pass the `not exists` check. The partial unique index is the real
guarantee, and it makes one of the two fail with `23505`, which the client already handles
as success. Keeping the pre-check is still worth it because it avoids the error path in the
common sequential case. I'm flagging this because "looks atomic, isn't quite" is exactly
the kind of detail that gets shipped and then bites under load.

Also: `kind_dummy` above is a placeholder for the `seq` default; the real function lets
`seq` come from the sequence default. I've left the shape explicit rather than hiding it in
a comment.

### 5.4 The client Engine API

Screens talk to *this*, never to Supabase:

```ts
// src/messaging/engine.ts
export interface ConversationEngine {
  // timeline
  open(conversationId: string): Promise<void>;   // subscribe + hydrate
  close(): void;
  loadOlder(): Promise<void>;                    // keyset pagination
  subscribe(listener: (s: TimelineState) => void): () => void;

  // outbox
  sendText(text: string, replyTo?: string): Promise<void>;
  sendMedia(kind: MessageKind, asset: LocalAsset, opts?: SendOptions): Promise<void>;
  retry(clientMessageId: string): Promise<void>;
  cancel(clientMessageId: string): void;

  // actions
  react(messageId: string, emoji: string): Promise<void>;
  edit(messageId: string, body: MessageBody): Promise<void>;
  delete(messageId: string, forEveryone: boolean): Promise<void>;
  forward(messageId: string, to: string[]): Promise<void>;
  markRead(uptoSeq: number): Promise<void>;

  // ephemeral UI signals
  setTyping(isTyping: boolean): void;
  readonly status: ConnectionStatus;   // online | reconnecting | offline
}
```

That interface is the deliverable of Phase 1. Everything in §52–§54 is then a view over it.

---

## 6. REAL-TIME EVENT ARCHITECTURE (§44)

### 6.1 Two transports, chosen per event type

Using one transport for everything is the common mistake. Durable events and ephemeral
signals have opposite requirements.

| Transport | Used for | Why |
|---|---|---|
| **Postgres changes** (`postgres_changes`) | `new_message`, `message_edited`, `message_deleted`, `reaction_added/removed`, `receipts`, `call_started/ended`, `poll_update` | Durable, replayable, and **enforced by RLS** — the database decides who receives what |
| **Broadcast** (private channels) | `typing_started/stopped`, `recording_started/stopped`, presence heartbeat | Never written to disk, expires naturally, costs no DB writes |

`typing` must never be a table. A busy 200-person group would write thousands of rows a
minute purely to say "someone is fumbling with their keyboard".

### 6.2 The event contract

```ts
type RealtimeEvent =
  | { t: 'new_message';        m: Message }
  | { t: 'message_edited';     id: string; body: MessageBody; editedAt: string }
  | { t: 'message_deleted';    id: string; forEveryone: boolean }
  | { t: 'reaction_added';     messageId: string; userId: string; emoji: string }
  | { t: 'reaction_removed';   messageId: string; userId: string; emoji: string }
  | { t: 'delivered';          userId: string; uptoSeq: number }
  | { t: 'seen';               userId: string; uptoSeq: number }
  | { t: 'typing';             userId: string; kind: 'typing'|'recording'|'uploading'; on: boolean }
  | { t: 'presence';           userId: string; state: 'online'|'away'|'offline'; lastSeenAt?: string }
  | { t: 'call';               id: string; state: 'ringing'|'active'|'ended'; kind: 'audio'|'video' }
  | { t: 'poll_update';        pollId: string; counts: Record<string, number> }
  | { t: 'conversation';       id: string; event: 'created'|'request'|'accepted'|'left' };
```

### 6.3 Wiring it up

```sql
-- Realtime only sends full old-record data for UPDATE/DELETE if the table
-- replicates its identity. Without this, "message_deleted" arrives without
-- the id you need to remove the bubble. This trips up almost everyone once.
alter table public.messages               replica identity full;
alter table public.message_reactions      replica identity full;
alter table public.conversation_participants replica identity full;
```

```ts
// src/messaging/transport.ts
const channel = supabase
  .channel(`conv:${conversationId}`, { config: { private: true } })   // ← RLS applies
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}` },
      onMessageChange)
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'message_reactions' }, onReactionChange)
  // ephemeral — no filter needed, the channel itself is the scope
  .on('broadcast', { event: 'typing' }, onTyping)
  .on('presence',  { event: 'sync' },   onPresence)
  .subscribe();
```

### 6.4 ⚠️ The security trap in broadcast channels

By default a Supabase broadcast channel is **public**: anyone who knows or guesses the
channel name can subscribe. If you name channels `conv:<uuid>`, that UUID is not a secret —
it appears in API responses, deep links and screenshots — so a third party could subscribe
to `conv:<uuid>` and read your typing events, presence, and anything else you broadcast.

The fix, and it must be done **before** the first broadcast ships:

```sql
-- Private channels authorise every join through RLS on realtime.messages.
-- Allow a user to join a topic only if they're a participant of that conversation.
create policy "realtime_join_own_conversations"
on realtime.messages for select to authenticated
using (
  realtime.topic() in (
    select 'conv:' || cp.conversation_id::text
    from public.conversation_participants cp
    where cp.user_id = auth.uid()
  )
);
```

That is why the client above passes `{ private: true }`. With `private: false` this policy
is never consulted and the channel is open to the internet.

### 6.5 Battery and connection discipline

§44 warns against connections that drain battery. Concretely:

- **One channel per open conversation.** Not one per conversation you have.
- Unsubscribe on blur, and on `AppState` → `background`. A chat list does not need a live
  socket for 40 threads.
- **Typing debounce:** emit `typing: on` at most once per 3s while typing, and
  `typing: off` on a 4s idle timer or on send. Never emit per keystroke.
- **Heartbeat:** presence ping every 45s while foregrounded, plus `offline` on background.
  Server marks a user `away` after 2 missed beats, `offline` after 5 — so a killed app
  doesn't show as online forever.
- **Backoff on reconnect:** 1s → 2s → 4s → 8s → 30s cap, jittered. Supabase's client
  retries aggressively by default; cap it.
---

## 7. AUTHENTICATION & SESSION ARCHITECTURE (§36, §37)

### 7.1 What stays

Supabase Auth, unchanged. You already have `account_security.sql` with `security_events`,
`recovery_attempts`, `user_recovery_codes` and **`user_sessions`** — that last table is
already the multi-device primitive, so §37's "see and revoke active sessions" is mostly a
UI problem, not a schema problem. Good news; use it.

### 7.2 The three layers, and what each actually protects

This distinction matters, because they get conflated and then misrepresented to users.

| Layer | Protects against | Does **not** protect against |
|---|---|---|
| **Supabase Auth + JWT** | impersonation, unauthorised API access | someone holding your unlocked phone |
| **Biometric app lock** (`expo-local-authentication`) | a friend picking up your unlocked phone | a determined attacker with the device & storage |
| **Device/session management** | a stolen or old device staying logged in | an attacker who already has a valid token |

**Be honest in the UI about the middle row.** A biometric app lock is a *privacy* feature
and a *shoulder-surfing* defence. It is not a cryptographic boundary — the token is still
sitting in secure storage behind it. Do not label it "secure" in a way that implies message
encryption. Store any auth secrets with `expo-secure-store` (Android Keystore / iOS Keychain),
never `AsyncStorage`.

### 7.3 MFA and passkeys

Supabase Auth supports TOTP-based MFA. Passkeys/WebAuthn support in Supabase Auth has been
evolving — **verify current support against the docs before committing to a design**, because
this is exactly the kind of feature whose status changes between releases and I would rather
you check than have me assert it.

My recommendation for sequencing: ship the engine first (§14 Phase 1), then session
management UI, then TOTP MFA, then passkeys if native support is solid. MFA on a messaging
app that ships late is worth less than a messaging app with reliable delivery.

### 7.4 The two session failure modes that will bite

**1. Token expiry mid-socket.** Supabase Realtime authenticates the *channel* at subscribe
time. When the JWT refreshes, an existing channel is still carrying the old token — so a
long-lived chat can silently stop receiving. Forcing `setAuth()` on refresh and
re-subscribing the active channel is the fix. Symptom to watch for in the wild:
"messages stop arriving if I leave the app open for an hour."

**2. Sign-out must tear down, not just navigate.** On sign-out: unsubscribe every channel,
clear the outbox, clear cached signed URLs and decoded media, clear the in-memory timeline.
If you skip the outbox clear, user A's queued messages flush under user B's session on the
same phone. On a shared phone — common in your market — that is a genuine data-leak bug, and
it's exactly the kind of thing that is invisible in testing with one account.

### 7.5 Multi-device sync rules (§37)

- Read state is **per-user, not per-device**: `last_read_seq` is on the participant row, so
  reading on the phone marks it read on the tablet. Correct by construction.
- **Drafts conflict.** Last-writer-wins with a `updated_at` comparison, and never overwrite
  a draft newer than the one you're holding. `message_drafts.updated_at` exists for this.
- **Don't sync the outbox.** Pending sends belong to the device that created them. Two
  devices racing to send the same draft is unfixable; make it impossible instead.
- **Notifications are per-device**, registered in `push_tokens` against a device id, and
  must be revoked on sign-out of that device only.

---

## 8. MEDIA STORAGE ARCHITECTURE (§43)

### 8.1 The core rule

**Message metadata lives in Postgres. Media bytes live in Storage. The two are joined by
`message_attachments`. No media is ever referenced by a permanent public URL.**

### 8.2 Buckets

| Bucket | Public? | Contents | Access |
|---|---|---|---|
| `chat-media` | **private** | photos, video, voice, files, moments | signed URL, 10 min TTL, participant-checked |
| `chat-thumbs` | **private** | small JPEG/WebP + blurhash placeholders | signed URL |
| `avatars` | public | profile pictures | public read is fine |
| `stickers` | public | sticker packs you ship | public read, client-cached |

You currently have a single `media` bucket. Keep it for posts; **do not put conversation
media in it** — one bucket cannot be both "public post media" and "private conversation
media", and mixing them is how private photos end up on a public CDN path.

### 8.3 Path convention

```
chat-media/{conversation_id}/{uploader_id}/{uuid}.{ext}
```

The uploader id is in the path because a **signed upload URL is issued before the message
exists**. Issuing it under a path containing `message_id` would force you to create the
message row first, which breaks idempotency (`messaging_send` would then be re-pointing
attachments, as in §5.3, rather than creating rows). Upload first, attach second, in that
order.

Storage RLS, so a path alone grants nothing:

```sql
create policy "chat_media_read" on storage.objects for select to authenticated
using (
  bucket_id in ('chat-media','chat-thumbs')
  and (storage.foldername(name))[1] in (
    select cp.conversation_id::text from public.conversation_participants cp
    where cp.user_id = auth.uid()
  )
);
```

### 8.4 Upload pipeline

```
pick/capture
   │
   ├─ 1. strip EXIF (GPS!) unless the user opts in to sharing location
   ├─ 2. downscale + compress  →  target <2MB per photo, 1600px long edge
   ├─ 3. generate thumbnail (<=200px) + blurhash  ← upload this FIRST
   ├─ 4. insert message_attachments row (upload_state='uploading') → get id
   ├─ 5. upload bytes to chat-media
   ├─ 6. upload thumb to chat-thumbs
   ├─ 7. update attachment → 'complete'; then messaging_send with attachment ids
   └─ 8. enqueue server-side scan_state check
```

**Step 3 before step 5 is not a micro-optimisation, it is the UX.** Uploading the thumbnail
first (~8KB) means the recipient sees a real, blurred-if-necessary preview in under a
second on 2G while the full 2MB follows. This single ordering decision is most of what makes
a media-heavy chat "feel fast" in §42 without any infrastructure spend.

**Resumable uploads (§19).** For files over ~6MB, a dropped connection currently means
starting over, which on Nigerian mobile data is unacceptable. Supabase Storage has added
resumable upload support via the tus protocol in `storage-js` — **confirm it against the
current docs and the version you have pinned before designing around it**, then use it for
the `file` kind specifically. Voice notes and photos are small enough that simple
retry-with-backoff is genuinely adequate; scope the complexity to where it pays.

### 8.5 Access pattern

```ts
// Signed URLs are short-lived and cached in memory only, keyed by (attachmentId).
// 10 minutes is enough to view, short enough that a leaked URL is nearly worthless.
const { data } = await supabase.storage
  .from('chat-media')
  .createSignedUrl(attachment.storagePath, 600);
```

Rules: never log a signed URL; never persist one to disk (persist the *path* and re-sign);
re-sign on `401`; clear the cache on sign-out.

### 8.6 Lifecycle — the part everyone forgets

You already solved half of this for posts: `expiry_v2.sql` defines
**`media_cleanup_queue`**. **Reuse it for chat.** When a message expires, is deleted for
everyone, or a view-once Moment is consumed:

1. enqueue the storage paths in `media_cleanup_queue`
2. a `pg_cron` job deletes the Storage objects
3. then deletes the `message_attachments` row
4. the `messages` row keeps a tombstone (or goes too, for disappearing chats)

Deleting bytes is what §50's privacy-first stance actually requires. A "deleted" photo that
is still in a bucket is not deleted, and claiming otherwise is the kind of thing that ends
up in a news story.

---

## 9. NOTIFICATION ARCHITECTURE (§40, §41)

### 9.1 The one rule that determines whether §41 works

**Notification content must be composed server-side, never client-side.**

You already have `push_tokens` (`push_notifications.sql:20`). The trap: if the app builds
the notification text, then the full message text travels in the push payload to the
operating system. A user who chose "hide preview" would still have their message sitting on
the lock screen, because the *payload* contained it and only the client declined to render
it. Anyone with the device, or any OS-level notification log, sees it.

So the sender's device does not build the notification. The server does, in an Edge Function
triggered by the message insert, applying the recipient's `messaging_privacy.notification_preview`:

| Setting | Payload sent to the device |
|---|---|
| `full` | `Sarah: are you coming tonight?` |
| `sender` | `Sarah` |
| `none` | *(no push at all — in-app badge only)* |

### 9.2 Server-side suppression rules

A push is **not** sent when any of these is true. Every one of them is a notification a user
would call a bug:

- the recipient is **currently viewing that conversation** (suppress; let the open socket render it)
- the conversation is **muted** (`conversation_participants.muted` / `muted_until` — you already have both)
- the conversation request is **`pending`** and the recipient hasn't accepted (§32)
- the message is a **reaction or receipt** (§40 says notify "where appropriate" — a reaction
  to your own message does not deserve a phone buzz)
- the sender is **blocked by** the recipient
- the message is **`system`** kind
- the recipient already has a **notification for that conversation** unread in the tray
  (collapse rather than stack)

### 9.3 Batching and battery

Network flapping causes push storms, and push storms cause uninstalls. Implement:

- **Per-conversation collapse:** `collapseId = conversationId`, so ten messages become one
  updating notification rather than ten.
- **Burst coalescing:** if more than 3 messages in a conversation arrive within 30s, send
  one "Sarah: 6 new messages".
- **Quiet hours before delivery, not at the OS:** the server checks quiet hours and defers,
  rather than relying on the OS to silence — the OS still received the payload.

---

## 10. SECURITY MODEL — including what this system is NOT

### 10.1 What genuinely protects you today

| Control | Status |
|---|---|
| TLS in transit | Supabase default |
| Encryption at rest | Supabase default (provider-level) |
| Row Level Security on every table | present, and the `my_conversation_ids()` `SECURITY DEFINER` helper already fixes the classic RLS recursion trap |
| Sender identity on insert | **correct** — `schema.sql:295` pins `sender_id = auth.uid()` |
| `SECURITY DEFINER` functions with pinned `search_path` | correct pattern in `chat_upgrades.sql`, `chat_settings.sql`, `calls.sql` |
| Privilege hygiene | `revoke ... from public, anon` + `grant ... to authenticated` on the RPCs |

That is a solid base and it is better than a lot of production chat apps. I am not going to
sandbag it.

### 10.2 What it is NOT — please read this part twice

**This architecture is not end-to-end encrypted, and must never be described as such.**

With Supabase, message bodies are stored as plaintext in Postgres and are readable by
anyone with the service-role key or database access — including you, and including anyone
who compromises your Supabase account or a backup. RLS is an *authorisation* mechanism
enforced by the same server that holds the data; it is protection from other users, not
from the operator. "Encrypted in transit + at rest" is true and is a different claim.

Your §36 already says the right thing:

> "Do not advertise or label a feature as 'end-to-end encrypted' unless the actual
> implementation provides true end-to-end encryption."

So: label it **"Private"** or **"Encrypted in transit and at rest."** Do not put a padlock
that implies E2EE on a bubble. If you later want E2EE, this is what it would actually take —
and it is a project, not a sprint:

1. Client-side key generation per device; private keys in Keystore/Keychain, never uploaded.
2. Asynchronous key agreement (X3DH-style) so two people can establish a session while offline.
3. A ratchet (Double Ratchet) for 1:1; **MLS** for groups — you cannot ratchet a group by
   sending N² messages, which is why WhatsApp caps group E2EE at ~1000 members and why
   Signal built MLS.
4. Device verification / safety numbers, or you have E2EE against an attacker who can
   substitute keys.
5. Encrypted key backup, or multi-device and device-loss recovery become data loss.
6. **Accepting the feature losses:** no server-side search, no server-side link previews, no
   server-side moderation of message content, no server-side notification text, no
   server-side translation. Your §4 wants translate, §17 wants search, §20 wants link
   previews, §34 wants reporting/moderation. Every one of those is in tension with E2EE.

**My recommendation:** do not attempt E2EE now. Instead, keep the door open cheaply by
treating `messages.body` as an **opaque payload** in the engine — the engine passes it
through without interpreting it beyond the renderer registry. Then a future E2EE layer can
encrypt `body` before it leaves the client without redesigning the transport, ordering,
receipts, or UI. That is a one-hour decision today that preserves a six-month option.

### 10.3 Remaining hardening work

- **Close DEFECT 7** (§2.6): restore sender-only UPDATE plus the immutability trigger.
- **Private broadcast channels + `realtime.topic()` RLS** (§6.4). Not optional.
- **Rate limiting** (§36): cap sends per user per conversation (e.g. 30/min, 1000/day) and
  new-conversation creation (e.g. 20/day) in `messaging_send`. Without this, the request
  gate is trivially bypassed by anyone with a script. Implement as a counter table or an
  Edge Function, not client-side.
- **Media scan gate:** never render an attachment with `scan_state <> 'clean'` for
  cross-user content. Upload → scan → then deliver.
- **Storage RLS** (§8.3) in addition to signed URLs. A signed URL is a bearer token; storage
  policies are the backstop when one leaks.
- **Delete-for-everyone must delete bytes** (§8.6), or the delete is cosmetic.
- **Never ship the service-role key to the client.** Grep the bundle before every release;
  it is the single most common fatal mistake in Supabase apps.
---

## 11. SCREEN-BY-SCREEN UX (§52, §47, §58)

### 11.1 The rule that governs everything below

> **Simple surface. Deep functionality.**

§47 names the failure mode precisely: *"WhatsApp + Telegram + Snapchat buttons everywhere."*
The defence is a hard constraint on the main surface:

**At most 5 affordances visible on any screen at rest.** Everything else lives behind a
long-press, an attachment panel, a message menu, chat details, or the Shared Space. If a
feature cannot be reached without adding a sixth button, it belongs one level deeper.

### 11.2 Our visual language — deliberately not theirs

The three apps you must not imitate each have a signature, and copying any of them is the
fastest way to look derivative. What we do instead:

| Axis | WhatsApp | Telegram | Snapchat | **Ours** |
|---|---|---|---|---|
| Bubble shape | tight tail | pill | none (overlay) | **tail-less with a 2px leading rail** |
| Alignment | left/right | left/right | overlay | **left/right, but outgoing bubbles hang 12% wider** |
| Colour source | green accent | blue accent | yellow accent | **per-conversation theme, default "Glow"** |
| Time stamps | inside bubble | inside bubble | none | **in the gutter, revealed on scroll-stop** |
| Reactions | chip under bubble | chip under bubble | n/a | **ink-bleed emoji that settles into a chip** |
| Chrome | heavy headers | heavy headers | chrome-free | **chrome-free: header fades out on scroll** |

The **leading rail** is our one strong visual signature: a 2px vertical accent bar down the
left edge of every incoming message run, coloured by the conversation theme. It gives the
eye a scan-line for grouping without boxes or tails, and it renders as a single `View` — no
image, no shadow, no cost.

**Tokens** (add to your existing theme, do not replace it):

```
space.1 = 4    space.2 = 8    space.3 = 12   space.4 = 16   space.5 = 24
group.gap          = space.1      // between messages in the same run
run.gap            = space.4      // between runs (speaker change / >5 min)
bubble.maxWidth    = '78%'        // outgoing '84%' — see alignment note above
rail.width         = 2
rail.radius        = 1
```

**Motion spec.** Every animation short, interruptible, and cancellable:

| Animation | Duration | Easing | Notes |
|---|---|---|---|
| Message appear | 180 ms | `easeOutCubic` | translateY(8) + opacity 0→1. Never from 0 height |
| Reaction pop | 220 ms | `easeOutBack` | scale 0.6→1.12→1.0 |
| Recording transition | 160 ms | `easeOutCubic` | composer height only — never the keyboard |
| Send state tick | 140 ms | `linear` | opacity crossfade, no layout shift |
| Moment open | 260 ms | `easeInOutQuad` | scale from bubble rect — origin matters |
| Call screen | 300 ms | `easeInOutCubic` | slide up |

Under `AccessibilityInfo.isReduceMotionEnabled()`, every one of these becomes a 0 ms
opacity swap. Not "faster" — disabled. Vestibular triggers are not a preference.

### 11.3 Screen map

| Screen | File | Purpose | Main-surface affordances |
|---|---|---|---|
| Chat list | `screens/ChatsScreen.tsx` *(exists)* | inbox, folders, requests badge | search, compose, 1 row action |
| Requests | `screens/RequestsScreen.tsx` *(new)* | the anti-spam gate | Accept / Delete / Block |
| Conversation | `screens/ChatThread.tsx` *(exists)* | **the product** | see §11.4 |
| Shared Space | `screens/SharedSpaceScreen.tsx` *(new)* | everything exchanged, by kind | 8 kind filters |
| Moment viewer | `components/MomentViewer.tsx` *(new)* | full-screen temporary content | react, reply, send back |
| Media editor | `screens/MediaEditorScreen.tsx` *(new)* | capture → edit → send | crop, draw, text, filters |
| Call | `screens/CallScreen.tsx` *(new)* | voice + video | mute, speaker, end, camera |
| Chat details | `screens/ChatDetailsScreen.tsx` *(new)* | members, media, theme, privacy | 4 sections |
| Privacy centre | `screens/PrivacyScreen.tsx` *(new)* | §35 settings | grouped toggles |
| My Saves | `screens/SavesScreen.tsx` *(new)* | §18 personal vault | 6 kind filters |

### 11.4 The Conversation screen — the whole product in one composition

```
┌──────────────────────────────────────────────────────────┐
│ ←   Sarah                                    ⋮           │  header, fades on scroll
│     Online · typing…                                     │  presence, privacy-gated
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ▎ are you coming tonight?                    2:14       │  incoming, rail
│  ▎ yes 😂                                                │  grouped: no rail repeat
│                                                          │
│                                    I'll be there ━━━ 2:16│  outgoing
│                                          ❤️ 2            │  reaction chip
│                                                          │
│  ▎ 📸 Moment · tap to open                    2:20       │  view-once
│                                                          │
│              ┌──────────────────────────────┐            │
│              │ ▸ ━━━━━━━━━━━━━  0:32  1×   │            │  voice note
│              └──────────────────────────────┘            │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  ＋   Message…                                      🎤   │  idle composer
└──────────────────────────────────────────────────────────┘
```

**Deliberately NOT on this surface** — this list is the design:

- ❌ voice call and video call buttons in the header. They live in the `⋮` menu and in
  chat details. Two permanent buttons for a rarely-used action is exactly the crowding §47
  warns about.
- ❌ GIF, sticker, emoji and camera buttons. All inside `＋`.
- ❌ a paperclip *and* a camera *and* a gallery icon. One `＋`.
- ❌ tabs across the top. §52 says it explicitly: *"do NOT add tabs unless usability testing
  proves they are necessary."* They are not. Shared Space is reached from the header tap.
- ❌ a separate "typing" bar. Presence lives in the subtitle, which already exists.
- ❌ per-message timestamps on every bubble. Gutter, on scroll-stop only.

### 11.5 Composer state machine

The composer is the most-touched control in the app and it is currently one static row. Five
states, one component:

```
              ┌─────────────────────────────────────────────┐
   IDLE       │  ＋   Message…                        🎤    │  empty input
              └─────────────────────────────────────────────┘
              ┌─────────────────────────────────────────────┐
   TYPING     │  ＋   Hello                            ➤    │  🎤 → ➤ swap, 140ms
              └─────────────────────────────────────────────┘
              ┌─────────────────────────────────────────────┐
   RECORDING  │  ◀ swipe to cancel   ● ━━━━━━ 0:07   🔒    │  hold started
              └─────────────────────────────────────────────┘
              ┌─────────────────────────────────────────────┐
   LOCKED     │  ⏸   ━━━━━━━━ 1:24            ⏹    ✖      │  lifted, still recording
              └─────────────────────────────────────────────┘
              ┌─────────────────────────────────────────────┐
   REPLYING   │  ↳ Sarah: are you coming tonight?      ✖   │  reply context strip
              └─────────────────────────────────────────────┘
```

Transitions that matter, and why:

- **The mic→send swap is the only layout-changing animation on the screen.** It is 140 ms on
  opacity, and both controls occupy the same 44×44 box so nothing else moves. A composer
  that reflows the message list on first keystroke is the most common "feels cheap" bug.
- **Swipe-to-cancel is horizontal, lock-to-continue is vertical.** They must be orthogonal
  or a user dragging to cancel will accidentally lock and keep recording.
- **Reply strip stacks, never replaces.** You can enter RECORDING while REPLYING. Reply
  context is state, not a mode.
- **Entering TYPING fires `setTyping(true)` once**, which the engine debounces to at most one
  broadcast per 3s and an automatic `off` after 4s idle. Never per keystroke.

### 11.6 Empty conversation (§54)

A brand-new thread must not look dead, but must not look like a template either:

```
              ┌───────────────────────────┐
              │         ( avatar )        │
              │          Sarah            │
              │   Start a conversation    │
              │                           │
              │  👋 Say hello             │
              │  📸 Send a photo          │
              │  🎙️ Send a voice note     │
              └───────────────────────────┘
```

Eighty pixels of vertical centring, three chips, no illustration, no empty-state graphic.
Illustrations age badly; a name and three verbs do not.

### 11.7 Themes (§15) without destroying readability

A theme is a set of **roles**, not free-form colours:

```ts
interface ConversationTheme {
  id: string;
  wallpaper: 'glow' | 'paper' | 'noise' | 'solid';
  accent: string;          // outgoing bubble fill + rail
  incomingFill: string;
  outgoingFill: string;
  textOnIncoming: string;
  textOnOutgoing: string;
  appearance: 'light' | 'dark' | 'system';
}
```

**The readability guard is enforced in code, not in a warning paragraph.** Bind any custom
colour through a contrast check before it is applied:

```ts
// Reject a combination below WCAG AA (4.5:1 for body text). This is why the
// theme model exposes roles: a user picks an accent, we derive the text
// colour, and an unreadable pairing is impossible rather than merely discouraged.
export function ensureReadable(fg: string, bg: string): string {
  return contrastRatio(fg, bg) >= 4.5 ? fg : (isDark(bg) ? '#FFFFFF' : '#111111');
}
```

§15 says *"do not allow customization to destroy readability."* Deriving the foreground
colour from the background is how you make that structurally true instead of aspirational.

---

## 12. COMPONENT ARCHITECTURE

### 12.1 The dependency rule

```
screens/  ──▶  messaging/  ──▶  supabase/
   │                │
   └──▶ components/ ┘         messaging/ must NEVER import from screens/ or components/
```

The engine has no React in it. That is the whole point: it is the only way the messaging
logic becomes testable without a device.

### 12.2 Target tree

```
src/messaging/                     ← BUILT (see §16)
  types.ts             domain types, row mapping, errors
  api.ts               every Supabase call, idempotency, error mapping
  outbox.ts            durable queue
  transport.ts         realtime: postgres_changes + broadcast
  engine.ts            timeline, optimism, reconciliation, pagination
  registry.ts          renderer contract
  useConversation.ts   the single React bridge
  index.ts             public surface

src/components/chat/               ← TO BUILD
  MessageList.tsx        FlatList wrapper: virtualization, grouping, scroll-to-quote
  MessageBubble.tsx      chrome + rail + states; delegates content to a renderer
  bubbles/               one file per kind
    TextBubble.tsx  ImageBubble.tsx  VoiceBubble.tsx  FileBubble.tsx
    MomentBubble.tsx  PollBubble.tsx  LocationBubble.tsx  SystemBubble.tsx
  Composer.tsx           the 5-state machine from §11.5
  ReplyStrip.tsx
  ReactionRow.tsx
  TypingIndicator.tsx
  MessageMenu.tsx        long-press sheet (reply/react/copy/edit/forward/save)
  AttachmentSheet.tsx    the ＋ panel
```

### 12.3 The one component that decides whether this scales

`MessageList.tsx` carries the performance burden, and it has exactly four jobs:

```tsx
<FlatList
  data={rows}
  inverted                       // newest at the bottom without reverse() on every render
  keyExtractor={stableKey}
  renderItem={renderRow}
  getItemLayout={getItemLayout}  // ⭐ only possible because heights are capped
  initialNumToRender={20}
  maxToRenderPerBatch={10}
  windowSize={11}
  removeClippedSubviews
  onEndReached={loadOlder}       // keyset pagination, not OFFSET
/>
```

`getItemLayout` is the single highest-leverage line in the whole screen, and it is only
honest if bubble heights are predictable. That is why the design caps text previews and
reserves media height from `width`/`height` **before** the image loads. Without reserved
height, `getItemLayout` lies, the list jumps, and scrolling degrades exactly as §42 forbids.

`stableKey` matters for a subtle reason: when a queued message is confirmed, its id changes
from `tmp:<clientMessageId>` to a real uuid. Keying by `id` would unmount and remount the
row — a visible flicker on every send. Key by `clientMessageId ?? id` so the row survives
reconciliation.

### 12.4 What each existing file becomes

| Today | After |
|---|---|
| `ChatThread.tsx` — 2,053 lines: fetch + realtime + send + optimistic + render + 14 bubble variants + composer + sheets | ~250 lines: `useConversation()`, `<MessageList/>`, `<Composer/>`, navigation |
| `ChatsScreen.tsx` — 947 lines | reads `last_read_seq` for badges; keeps its existing layout |
| `GifPicker.tsx` | reused unchanged as a `GifBubble` sibling |
| no chat service in `src/services/` | replaced by `src/messaging/` |
---

## 13. PERFORMANCE & SCALABILITY (§42, §44)

### 13.1 The four numbers that decide whether chat feels fast

| Path | Target | How it is achieved |
|---|---|---|
| Open a conversation | < 300 ms to first paint | 50-message first page, cached paint from the outbox, no blocking count query |
| Send a message | < 16 ms perceived | optimistic bubble appended locally; network happens after paint |
| Scroll | 60 fps with 10k messages | `getItemLayout` + virtualisation + reserved media height |
| Type | no dropped frames | typing broadcast debounced to ≤1 per 3s, off the keystroke path |

### 13.2 Index strategy, and the queries it serves

```sql
-- timeline pagination (newest 50, then keyset backwards)
messages_timeline_idx   (conversation_id, seq desc)
-- Shared Space: "every photo in this thread, newest first"
attachments_shared_space_idx (conversation_id, mime_type, created_at desc)
-- reactions for the visible window
reactions_message_idx   (message_id)
-- the expiry sweeper
messages_expiry_idx     (expires_at) where expires_at is not null
-- inbox ordering + unread counts
participants_inbox_idx  (user_id, archived, pinned_at desc)
-- the requests surface
requests_inbox_idx      (to_user, state, created_at desc)
```

Every one of these is a **covering prefix match** on the query it serves. The important
discipline is negative: no index is added "just in case". On `messages` — a table that grows
without bound — every extra index is a permanent tax on every insert.

### 13.3 The unread-count trap

The obvious implementation of an unread badge is:

```sql
-- ❌ do NOT do this
select count(*) from messages m
where m.conversation_id = $1 and m.seq > (my last_read_seq);
```

Run for 40 conversations on every app open, on a table with millions of rows, this is the
single most common cause of a slow chat list.

Do this instead — one indexed aggregate, once, for the whole inbox:

```sql
create or replace function public.messaging_unread_counts()
returns table (conversation_id uuid, unread int)
language sql stable security definer set search_path = public as $$
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
```

This is exactly the payoff of `last_read_seq` being an integer rather than a timestamp: the
comparison is a range scan on the index that already exists. With a timestamp you would be
comparing against `created_at`, which needs its own index and still touches every row in the
range.

### 13.4 What changes at scale, and when

| Scale | What breaks first | Fix, in order |
|---|---|---|
| 10k messages | nothing | — |
| 1M messages | index bloat from hot updates on `messages` | lower `fillfactor` on `messages` to 85; consider `HOT`-friendly settings |
| 10M messages | receipts table growth | the 30-day receipt window (§2.5) — already designed |
| 100M messages | table scan for admin/report queries | partition `messages` by `created_at` (monthly) |
| 1M realtime users | Realtime channel concurrency | move to dedicated Realtime clustering; batch presence |
| Voice/video at scale | SFU bandwidth | see §14 Phase 4 — this is the first genuinely expensive thing |

**Nothing in this list requires re-architecting the engine.** That is what "make it
extensible" was supposed to buy, and it is why the schema work was worth doing before the
feature work.

### 13.5 Battery discipline (§44)

§44 warns against connections that drain battery, so concretely:

- **One channel per open conversation**, never one per conversation in the list.
- Unsubscribe on blur **and** on `AppState → background`.
- Typing: ≤1 broadcast per 3s, `off` on a 4s idle timer.
- Presence: 45s heartbeat while foregrounded; server marks `away` after 2 missed beats and
  `offline` after 5 — so a force-killed app does not show as online forever.
- Reconnect backoff capped at 30s, jittered.

---

## 14. DEVELOPMENT PHASES & DEPENDENCIES (your §56, made concrete)

Each phase ends with a **definition of done** that can be verified, not a feeling.

### PHASE 1 — Foundation  ▓▓▓▓▓▓▓▓▓▓ 70% DONE
`conversations`, `participants`, `messages`, realtime text delivery, replies, reactions,
status, push.

**Done already:** schema + RLS ✅, the Conversation Engine ✅ (see §16), idempotent send ✅,
keyset pagination ✅.
**Remaining:** swap `ChatThread.tsx` onto the engine; realtime migration (**currently blocked —
see §16.4**); push notification payload.
**Done when:** two devices, one conversation, a message sent on a plane in flight mode
arrives exactly once when the plane lands.

### PHASE 2 — Media
Images, video, files, voice, GIF, stickers, camera.
**Dependencies:** `expo-image-manipulator` (**not currently in `package.json` — must be added**),
`expo-camera`, the `chat-media` bucket (✅ created), signed-URL caching.
**Done when:** a 2GB file survives a mid-upload network drop and resumes.

### PHASE 3 — Advanced chat
Edit, forward, save, search, Shared Space, disappearing messages, Moments, themes.
**Dependencies:** `purge_expired_messages()` from Phase 1's PART 2 hardening; a search
strategy that does not break with E2EE later.
**Done when:** "find the PDF Sarah sent last month" returns in under 300 ms.

### PHASE 4 — Communication  💰 first real infrastructure cost
Voice calls, video calls, location, contact sharing.
**Dependencies:** an SFU for group calls (LiveKit / Daily / Agora). 1:1 can run on WebRTC
mesh; **group video cannot** — mesh upload bandwidth grows O(n) per participant and dies at
about 4 people. Budget for this; it is not a code problem.
**Done when:** a 6-person video call holds for 30 minutes on Nigerian 4G.

### PHASE 5 — Communities
Groups, roles, topics, mentions, polls, moderation.
**Dependencies:** `conversation_topics` ✅, `role` ✅, `polls` ✅ already exist.
**Done when:** a 300-member group with 6 topics is usable without a summary.

### PHASE 6 — Security & scale
2FA, passkeys, device management, rate limiting, anti-spam, monitoring.
**Dependencies:** `user_sessions` ✅ exists (from `account_security.sql`). Rate limiting must
land in `messaging_send` before the app is public, not after.
**Done when:** a scripted spam run against the send endpoint is throttled server-side.

---

## 15. HONEST REALISM — what is hard, expensive, or not as you described

I would rather tell you this now than after you have shipped.

**1. This is not a "features" project, it is a correctness project.** The two hardest parts
of the spec are not on your feature list: exactly-once delivery on a flaky network, and read
state that stays coherent across devices. Both are invisible when they work. §38 and §4 are
the real bar, and both are now structurally addressed in code rather than by intention.

**2. Voice and video calls are the first genuinely expensive component.** 1:1 is fine on
mesh WebRTC. Group video needs an SFU and an SFU costs real money per minute. There is no
clever way around this. Do not promise group video calls until an SFU vendor is chosen and
budgeted.

**3. You cannot claim end-to-end encryption, and you should not try.** With Supabase, message
bodies are plaintext in Postgres, readable by anyone with the service-role key. Labelling
it E2EE would be false. Label it "Private" / "Encrypted in transit and at rest". §36 already
says this; this document makes it concrete with the six-item list in §10.2 of what real E2EE
would cost.

**4. Some of your spec is in direct tension with E2EE.** §4 translate, §17 search, §20 link
previews, §34 moderation, and server-generated notification previews all require the server
to read content. You can have those, or you can have E2EE. Not both. Right now you have none
of the E2EE constraints, which is why all five features are cheap — take that trade
deliberately rather than by accident.

**5. Retention is the real risk to "48-hour expiry".** Expiry needs a scheduler. A client-side
timer deletes nothing if the app is closed, and the bytes stay in the bucket — a "deleted"
photo still on a CDN is the kind of thing that becomes a news story. Requires `pg_cron` +
`media_cleanup_queue` (which `expiry_v2.sql` already defines — reuse it).

**6. Search will get slow before anything else does.** Postgres full-text over a growing
message table needs a generated `tsvector` column and a GIN index from day one, not a
`LIKE '%term%'` scan added later.

**7. The `messages_update_member` policy is a live integrity hole** (§0.3 DEFECT 7). It is not
theoretical: any group member can rewrite another member's message text today. Fixing it is
three lines, but only *after* the client stops writing reaction/view-once state onto the
message row — otherwise you break those features. That sequencing is why PART 2 exists.

**8. Your Supabase org is over quota.** The dashboard carried a warning that the organisation
exceeded its quota in the previous billing cycle, with projects to be restricted from
01 Oct 2026. That is roughly a week away. It outranks every item in this document.

---

## 16. IMPLEMENTATION STATUS — what exists in the repo right now

### 16.1 Built and typechecked ✅

`src/messaging/` — 1,533 lines, `npx tsc --noEmit` → **zero errors**.

| File | Lines | Responsibility |
|---|---|---|
| `types.ts` | 285 | domain types, row→domain mapping, `SendError` |
| `api.ts` | 277 | every Supabase call; idempotency; error→action mapping |
| `outbox.ts` | 115 | durable queue, survives app kill |
| `transport.ts` | 128 | `postgres_changes` + private broadcast |
| `engine.ts` | 519 | timeline, optimism, reconciliation, pagination, receipts |
| `registry.ts` | 47 | renderer contract (ends the 2,053-line file) |
| `useConversation.ts` | 116 | the single React bridge |
| `index.ts` | 46 | public surface |

The five behaviours worth checking are implemented, not described:

1. **Idempotent send** — `clientMessageId` generated once and reused on every retry;
   `23505` is translated to "already delivered", not an error.
2. **Reconciliation** — an optimistic bubble is dropped the instant the server row carrying
   the same `client_message_id` arrives, so slow networks never double-render.
3. **Ordered flush** — the outbox flushes sequentially per conversation, and stops at the
   first retryable failure, so messages cannot arrive out of order.
4. **Jittered backoff** — 1s→30s with jitter, because synchronized reconnects flood the API.
5. **Typing debounce** — ≤1 broadcast per 3s, auto-`off` after 4s idle.

### 16.2 Applied to the live database ✅

`supabase/messaging_v2.sql` — applied, verified, **7/7 checks PASS**:
16 tables, 14 kinds, 10 new `messages` columns, idempotency index, `msg_type` FK,
0 rows missing `seq`, 2 private buckets.

### 16.3 Written but deliberately NOT applied ⏸

`supabase/messaging_v2_hardening.sql` — the DEFECT 7 fix. Blocked on the four-item client
checklist in the file. Do not run it early.

### 16.4 Applied, after a real gotcha ✅

`supabase/messaging_v2_realtime.sql` — now applied. Verified: `replident_full = 3`,
`private_policy = 1`, `realtime_rls_enabled = true`, all three tables in the publication.

It failed first with `ERROR: 42501: must be owner of table messages`, and the cause is worth
recording because it will bite again:

**Supabase role ownership differs per schema.** `public.*` is owned by `postgres` (the role
the SQL editor runs as). `realtime.messages` is owned by `supabase_realtime_admin`. The
offending line was:

```sql
-- ❌ fails as `postgres` — requires OWNERSHIP of realtime.messages
alter table realtime.messages enable row level security;
```

Two compounding lessons:

1. RLS is **already enabled** on `realtime.messages` by Supabase, so the statement was
   redundant as well as fatal — it duplicates nothing useful.
2. **The Supabase SQL editor wraps a multi-statement script in one transaction.** That single
   bad line rolled back the entire file, including the three `REPLICA IDENTITY` statements
   and the policy that all work fine. Diagnosing "which line failed" therefore requires
   running statements *individually*, which is exactly how this was isolated.

The line is now removed from the file with an explicit warning not to re-add it. The lesson
generalises: **when a Supabase migration fails with no line number, run its statements one at
a time** — a monolithic script hides the culprit by design.

### 16.5 Adoption path — incremental, never a big-bang rewrite

Do **not** rewrite `ChatThread.tsx` in one commit. It is 2,053 lines of working code and the
engine is unproven against your real data. Sequence:

1. **Read-only first.** Call `useConversation(conversationId)` alongside what the screen
   already does. Log `state.messages`. Prove the engine returns the same history the screen
   renders. Zero user-visible change; this is the whole risk reduction.
2. **Send through the engine.** Point the existing composer at `sendText()`. Keep the old
   render path. Now you have idempotent sends and a durable outbox with no UI change.
3. **Swap the list.** Replace the render loop with `<MessageList/>` + the registry, one
   bubble kind at a time, starting with `text`.
4. **Delete the old path** only once every kind is migrated and `missingKinds(registry)`
   returns empty.

Each step is independently shippable and independently revertible. That is the point.
