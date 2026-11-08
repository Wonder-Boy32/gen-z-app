-- ============================================================
-- GENZ — PRIVACY ENFORCEMENT
-- 20261106_01_privacy_enforcement.sql
-- ============================================================
-- WHAT THIS FIXES
--
-- A live audit (scripts/privacy-audit.mjs) proved three promises the app makes
-- to its users that the database was not keeping:
--
--   1. "Only me" and "Followers" Drops were readable by any signed-in
--      stranger, and a private profile's posts were readable too.
--        Two SELECT policies existed on public.posts. Postgres ORs permissive
--        policies together, and one of them - posts_select_active, added for
--        the admin console - only checked `expires_at > now()`. So it granted
--        every live post to everyone and the visibility-aware policy beside it
--        was decorative.
--
--   2. A user could set `verified = true` on themselves, and could type any
--      number they liked into `lifetime_likes` / `total_likes_received`.
--        The profiles UPDATE policy only checked `id = auth.uid()`, which is
--        the right check for "may I edit my profile" and the wrong one for
--        "may I award myself a badge".
--
--   3. View-once media was not single-use server-side.
--        The client marked a moment as opened by PATCHing the message row
--        itself. messages_guard_update() correctly refuses to let a non-author
--        change a message, so that PATCH failed - and so did consume_view_once(),
--        the function meant to do it properly. Nothing ever set
--        view_once_consumed_at, the five-minute byte sweep never matched a row,
--        and the media_url stayed readable forever.
--
-- SAFETY OF THIS FILE
--   * Every statement is idempotent; it is safe to run twice.
--   * No data is deleted. No column is dropped.
--   * It ends with a verification block that RAISEs if any boundary is still
--     open, so a silent half-apply is not possible.
--
-- ROLLBACK
--   The posts policy is one CREATE POLICY - re-run social.sql or drop_creator.sql
--   to restore the previous definition. The profiles guard is a trigger; drop it
--   with:  drop trigger if exists profiles_guard_protected on public.profiles;
--   The view-once table is additive and unread by anything else.
-- ============================================================


-- ------------------------------------------------------------
-- 1) POSTS — one SELECT policy that actually means what the app says
-- ------------------------------------------------------------
-- Drop every name this policy has carried across migrations. Any permissive
-- SELECT policy left behind would OR back in and re-open the hole, so this is
-- deliberately a clean sweep rather than an edit of one of them.
drop policy if exists "posts_select"        on public.posts;
drop policy if exists "posts_select_active" on public.posts;
drop policy if exists "posts_select_public" on public.posts;

create policy "posts_select" on public.posts
  for select using (
    -- the 7-day rule, enforced at read time as well as by the sweep
    expires_at > now()
    -- an admin takedown hides it from everyone, including its author
    and removed_at is null
    -- a deactivated account's content stops being served
    and not exists (
      select 1 from public.profiles p
      where p.id = posts.user_id and p.deactivated_at is not null
    )
    and (
      -- your own posts, whatever their visibility
      user_id = auth.uid()
      -- someone else's: only if they made it visible
      or (
        visibility in ('everyone', 'followers')
        and (
          -- public profile + public post
          (
            visibility = 'everyone'
            and not exists (
              select 1 from public.profiles pr
              where pr.id = posts.user_id and pr.is_private
            )
          )
          -- any accepted follow, which also covers a private profile's followers
          or exists (
            select 1 from public.follows f
            where f.following_id = posts.user_id
              and f.follower_id = auth.uid()
              and f.status = 'accepted'
          )
        )
      )
    )
  );


-- ------------------------------------------------------------
-- 2) PROFILES — a badge is not something you award yourself
-- ------------------------------------------------------------
-- A trigger rather than column privileges, for one specific reason: the counters
-- below are maintained by SECURITY DEFINER triggers (bump_lifetime_likes), and
-- those run as the table owner. Column-level REVOKEs would break that path, and
-- re-granting around it would be guesswork. This guard keys off `current_user`:
-- inside a definer function it is the owner, so the server's own writes pass
-- through untouched, while a request carrying an end-user JWT is held to the
-- old values.
--
-- `phone_verified` is deliberately NOT guarded here. The client sets it after an
-- in-app OTP today (components/security/AccountSecurity.tsx); guarding it would
-- silently revert that flow without erroring. Moving verification server-side is
-- tracked separately — see the note in the audit.
create or replace function public.profiles_guard_protected()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.id                   := old.id;
    new.created_at           := old.created_at;
    new.verified             := old.verified;
    new.lifetime_likes       := old.lifetime_likes;
    new.total_likes_received := old.total_likes_received;
    new.account_status       := old.account_status;
    new.deactivated_at       := old.deactivated_at;
    new.deletion_requested_at := old.deletion_requested_at;
    new.invite_code          := old.invite_code;
    new.invited_by           := old.invited_by;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_protected on public.profiles;
create trigger profiles_guard_protected
  before update on public.profiles
  for each row execute function public.profiles_guard_protected();


-- ------------------------------------------------------------
-- 3) VIEW-ONCE — single use, enforced by the server
-- ------------------------------------------------------------
-- The bytes have to survive for the few minutes it takes the opener to display
-- them, but the *pointer* must not survive the open. So the URL is moved out of
-- the message row (which the client can read) into a table with RLS on and no
-- policy at all: reachable by SECURITY DEFINER functions and the service role,
-- invisible to every phone.
create table if not exists public.view_once_refs (
  message_id uuid primary key references public.messages(id) on delete cascade,
  ref        text not null,
  created_at timestamptz not null default now()
);
alter table public.view_once_refs enable row level security;
-- no policies on purpose: deny by default for anon + authenticated
revoke all on public.view_once_refs from anon, authenticated;

-- The guard that protects messages must stand aside for exactly one call: the
-- consumption transaction below. A transaction-local GUC means the exception
-- cannot leak onto a pooled connection.
create or replace function public.messages_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid     uuid    := auth.uid();
  v_purging boolean := coalesce(current_setting('app.msg_purge', true), 'off') = 'on';
  v_vonce   boolean := coalesce(current_setting('app.view_once', true), 'off') = 'on';
  v_open    text[]  := array['pinned_at', 'pinned_by'];
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

  if not v_purging and not v_vonce and v_uid is not null and v_uid <> old.sender_id then
    if (to_jsonb(new) - v_open) is distinct from (to_jsonb(old) - v_open) then
      raise exception 'only the author may change this message';
    end if;
  end if;

  if new.content is distinct from old.content
     or new.body is distinct from old.body then
    new.edited_at := now();
  end if;

  return new;
end $$;

create or replace function public.consume_view_once(p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_row    public.messages;
  v_ref    text;
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  select * into v_row from public.messages where id = p_message;
  if not found then
    raise exception 'not_found';
  end if;

  if not coalesce(v_row.view_once, false) then
    raise exception 'not_view_once';
  end if;

  -- The sender sees their own moment without consuming it.
  if v_row.sender_id = v_uid then
    raise exception 'sender_cannot_consume';
  end if;

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = v_row.conversation_id
      and cp.user_id = v_uid
  ) then
    raise exception 'forbidden';
  end if;

  -- Serialize concurrent opens: two taps must not both succeed.
  perform 1 from public.messages where id = p_message for update;

  select * into v_row from public.messages where id = p_message;
  if v_row.view_once_consumed_at is not null then
    raise exception 'already_viewed';
  end if;

  -- The one and only thing that may still read the bytes after this point.
  v_ref := v_row.media_url;
  if v_ref is not null then
    insert into public.view_once_refs (message_id, ref)
    values (p_message, v_ref)
    on conflict (message_id) do update set ref = excluded.ref;
  end if;

  -- Tell messages_guard_update() this write is the consumption, not an edit.
  perform set_config('app.view_once', 'on', true);

  update public.messages
     set view_once_consumed_at = now(),
         view_once_consumed_by = v_uid,
         -- the pointer leaves the client-readable row immediately, so a second
         -- read cannot replay it; the sweep below deletes the bytes
         media_url = null
   where id = p_message;

  insert into public.message_views (message_id, user_id)
  values (p_message, v_uid)
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'media_ref', v_ref,
    'kind', v_row.msg_type
  );
end $$;

revoke all on function public.consume_view_once(uuid) from public, anon;
grant execute on function public.consume_view_once(uuid) to authenticated;

-- The sweep now reads the pointer from the protected table, because media_url
-- is already gone by the time it runs. Legacy rows (consumed before this
-- migration) still have media_url and are handled by the coalesce.
create or replace function public.genz_sweep_consumed_view_once(p_limit int default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_bucket text;
  v_path   text;
  v_del    record;
  v_rows   int := 0;
  v_files  int := 0;
  v_fail   int := 0;
begin
  for v_row in
    select m.id,
           m.view_once_consumed_at,
           coalesce(r.ref, m.media_url) as ref
      from public.messages m
      left join public.view_once_refs r on r.message_id = m.id
     where m.view_once_consumed_at is not null
       and m.view_once_consumed_at < now() - interval '5 minutes'
       and coalesce(r.ref, m.media_url) is not null
     order by m.view_once_consumed_at
     limit p_limit
  loop
    select s.bucket, s.path into v_bucket, v_path
      from public.storage_ref_parts(v_row.ref) s;

    if v_bucket is not null then
      select * into v_del from public.genz_storage_delete(v_bucket, v_path);
      if v_del.ok then
        v_files := v_files + 1;
      else
        v_fail := v_fail + 1;
        insert into public.media_cleanup_queue (bucket, object_path, attempts, last_error)
        values (v_bucket, v_path, 1, v_del.err)
        on conflict (bucket, object_path) do update
          set attempts = media_cleanup_queue.attempts + 1,
              last_error = excluded.last_error,
              updated_at = now();
      end if;
    end if;

    update public.messages set media_url = null where id = v_row.id;
    delete from public.view_once_refs where message_id = v_row.id;
    v_rows := v_rows + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'rows', v_rows, 'files_deleted', v_files, 'file_failures', v_fail
  );
end $$;

revoke all on function public.genz_sweep_consumed_view_once(int) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4) VERIFY — fail loudly rather than half-applying
-- ------------------------------------------------------------
do $$
declare
  v_policies int;
begin
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'posts'
     and cmd        = 'SELECT';

  if v_policies <> 1 then
    raise exception
      'posts has % SELECT policies; privacy enforcement requires exactly 1', v_policies;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'profiles_guard_protected'
       and tgrelid = 'public.profiles'::regclass
  ) then
    raise exception 'profiles_guard_protected is missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'view_once_refs'
       and c.relrowsecurity
  ) then
    raise exception 'view_once_refs is missing or has RLS disabled';
  end if;

  raise notice 'privacy enforcement applied: 1 posts policy, profile guard on, view-once durable';
end $$;
