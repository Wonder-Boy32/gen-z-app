-- Minimal Supabase-shaped stub so the six hardening migrations can be
-- executed on a real Postgres. NOT the app schema: only what the migrations
-- touch, with the real column names and the real auth/storage primitives.

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name,'/'),1)-1];
$$;

create or replace function storage.filename(name text) returns text
language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name,'/'),1)];
$$;

-- public schema stubs -------------------------------------------------------
create table public.profiles (
  id uuid primary key,
  username text,
  bio text,
  location text,
  is_private boolean default false,
  avatar_url text,
  anonymous_enabled boolean default true
);

create table public.anonymous_settings (
  user_id uuid primary key references public.profiles(id),
  enabled boolean default true,
  who text default 'everyone',
  allow_voice boolean default true,
  allow_drops boolean default true
);

create table public.follows (
  follower_id uuid, following_id uuid,
  primary key (follower_id, following_id)
);

create table public.blocks (
  blocker_id uuid, blocked_id uuid,
  primary key (blocker_id, blocked_id)
);

create table public.anonymous_blocks (
  recipient_id uuid, sender_id uuid,
  primary key (recipient_id, sender_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean default false,
  created_by uuid,
  created_at timestamptz default now()
);

create table public.conversation_participants (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid,
  primary key (conversation_id, user_id)
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  content text,
  caption text,
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '7 days',
  removed_at timestamptz,
  media_url text
);

create table public.post_hashtags (
  post_id uuid references public.posts(id) on delete cascade,
  tag text,
  primary key (post_id, tag)
);

create table public.hashtags (
  tag text primary key,
  count integer default 0,
  updated_at timestamptz default now()
);

-- mirrors discover.sql: RLS on, select-only policy, so client writes are denied
alter table public.hashtags enable row level security;
create policy "hashtags_select" on public.hashtags for select using (true);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  sender_id uuid,
  content text,
  media_url text,
  media_type text,
  msg_type text,
  view_once boolean default false,
  view_once_consumed_at timestamptz,
  created_at timestamptz default now(),
  expires_at timestamptz
);

create table public.message_views (
  message_id uuid references public.messages(id) on delete cascade,
  user_id uuid,
  primary key (message_id, user_id)
);

create table public.anonymous_messages (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid,
  sender_id uuid,
  content text,
  media_url text,
  voice_url text,
  message_type text default 'text',
  created_at timestamptz default now(),
  expires_at timestamptz
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  actor_id uuid,
  type text,
  created_at timestamptz default now()
);

create table public.media_cleanup_queue (
  id bigserial primary key,
  bucket text,
  object_path text,
  attempts int default 0,
  last_error text,
  created_at timestamptz default now(),
  unique (bucket, object_path)
);

create table public.admin_users (
  user_id uuid primary key,
  role text not null default 'moderator',
  status text not null default 'active',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table public.security_events (
  id bigserial primary key,
  user_id uuid,
  event_type text,
  detail text,
  created_at timestamptz default now()
);

-- helpers the admin migration calls into
create or replace function public.admin_require(p text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select a.user_id into v from public.admin_users a
   where a.user_id = auth.uid() and a.status = 'active';
  if v is null then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function public.admin_audit(
  p1 text default null, p2 text default null, p3 text default null,
  p4 text default null, p5 text default null, p6 jsonb default null
) returns void language sql as $$ select null::void; $$;

create or replace function public.admin_has_permission(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users a
                 where a.user_id = auth.uid() and a.status = 'active'
                   and (a.role = 'super_admin' or a.role = 'admin'));
$$;

grant usage on schema public, storage, auth to anon, authenticated, service_role;
-- Supabase grants these to both roles and lets RLS do the work
grant select, insert, update, delete on all tables in schema storage to authenticated, anon;
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- the pre-existing public bucket this migration hardens
insert into storage.buckets (id, name, public) values ('media','media',true);

-- --- Phase 2: RLS must be ON for tables whose policies we assert against.
-- conversations only: verify.py seeds messages as a privileged role, so turning
-- RLS on there breaks its own fixture instead of testing a policy.
alter table public.conversations enable row level security;

-- RLS UPDATE needs SELECT to find the rows it will write. schema.sql:264-267
-- defines conversations_select for participants; without it here, a participant
-- sees zero conversations and every UPDATE legitimately matches nothing.
drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations for select
  using (exists (select 1 from public.conversation_participants cp where cp.conversation_id = id and cp.user_id = auth.uid()));
