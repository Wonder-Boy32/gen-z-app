-- ============================================================
-- Supabase primitives for the fresh-install harness.
--
-- A real Supabase project ships these before any app SQL runs: the Postgres
-- roles, the auth and storage schemas, and the pg_cron / pg_net / vault
-- extension objects. A bare Postgres has none of them, so replaying
-- supabase/*.sql against one fails for reasons that are not defects.
--
-- This file stands in for that platform layer, so a failure in the harness
-- means something real: a missing table, a wrong order, a broken statement.
--
-- NOT for production. Never apply this to the live project.
-- ============================================================

-- ---------------------------------------------------------------- roles
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------- auth
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '');
$$;

-- auth.users: migrations reference it for lookups. Column set trimmed to what
-- app SQL actually reads.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  banned_until timestamptz
);

alter table auth.users enable row level security;

-- ---------------------------------------------------------------- storage
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
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
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
$$;

create or replace function storage.filename(name text) returns text
language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
$$;

-- The Storage API deletes bytes, not rows. Migrations call this through
-- genz_storage_delete via pg_net; here the extension is absent, so provide a
-- callable stand-in that reports success.
create or replace function storage.delete_object(bucket text, path text) returns boolean
language sql as $$ select true; $$;

-- ---------------------------------------------------------------- vault
create schema if not exists vault;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  secret text,
  description text,
  created_at timestamptz default now()
);

-- Supabase exposes decrypted_secrets as a view over the encrypted column.
-- Empty by default: genz_storage_delete() then reports 'vault secrets missing',
-- which is the honest behaviour, not a harness failure.
create or replace view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret, description, created_at
    from vault.secrets;

-- ---------------------------------------------------------------- pg_net
create schema if not exists net;

create table if not exists net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body bytea,
  timeout_milliseconds int
);

create table if not exists net._http_response (
  id bigint primary key,
  status_code int,
  content text,
  headers jsonb,
  timed_out boolean,
  created timestamptz default now()
);

create or replace function net.http_delete(
  url text, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq'); $$;

create or replace function net.http_post(
  url text, body jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000)
returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq'); $$;

create or replace function net.http_get(
  url text, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq'); $$;

-- ---------------------------------------------------------------- pg_cron
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text default 'localhost',
  nodeport int default 5432,
  database text default current_database(),
  username text default current_user,
  active boolean default true,
  jobname text
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  returning jobid into v_id;
  return v_id;
end $$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $$
declare v_n int;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function cron.unschedule(job_id bigint)
returns boolean language plpgsql as $$
declare v_n int;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- ---------------------------------------------------------------- realtime
create schema if not exists realtime;

-- Supabase Realtime's broadcast table. Chat realtime migrations enable RLS on
-- it and add topic-scoped policies; the columns below are the ones those
-- policies read.
create table if not exists realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null default 'broadcast',
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamptz default now()
);
-- Supabase creates this publication when the project is provisioned; every
-- `alter publication supabase_realtime add table ...` in the app SQL assumes
-- it exists. Without it the whole file aborts.
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Bookkeeping schema the Supabase CLI owns.
create schema if not exists supabase_migrations;

-- ---------------------------------------------------------------- extensions
-- Deliberately no `create extension pgcrypto`: the bundled pgserver has no
-- extension control files, and gen_random_uuid() has been core since PG13, so
-- app SQL that relies on it still works here. pg_cron / pg_net stay absent on
-- purpose — that is what the ENV classification in fresh_install.py is for.

-- Supabase Realtime exposes the current broadcast topic as a function; the
-- chat migrations use it in RLS predicates on realtime.messages.
create or replace function realtime.topic() returns text
language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '');
$$;
