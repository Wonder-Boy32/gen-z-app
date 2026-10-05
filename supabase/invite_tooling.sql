-- ============================================================
-- GEN Z - invite tooling.
--
-- RUN IN THE SUPABASE SQL EDITOR (project: GenZ, main/PRODUCTION).
-- Idempotent - safe to re-run.
--
-- WHY
--
-- The feed is currently EMPTY (0 live posts, 0 live locations). That is not a
-- code problem, so no amount of code fixes it - it needs real people in one
-- place. This is the machinery for getting them there and, just as importantly,
-- for SEEING whether it is working: who invited whom, and how many actually
-- arrived.
--
-- DESIGN NOTES
--
-- * Counts are computed LIVE from invite_redemptions rather than kept in a
--   cached counter on profiles. The hashtags table taught that lesson the hard
--   way: a denormalised count with no recompute on delete drifts upward forever
--   and silently lies. A join table with a unique constraint per invitee cannot
--   drift.
--
-- * Codes are generated SERVER-SIDE and are 6 characters from a 31-letter
--   alphabet with 0/O/1/I/L removed, so a code read aloud or typed from a photo
--   cannot be mistyped into a different valid code.
--
-- * Redemption goes through a SECURITY DEFINER function. Clients never write to
--   invite_redemptions directly and cannot enumerate other people's codes.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Columns on profiles.
-- ------------------------------------------------------------
alter table public.profiles add column if not exists invite_code text;
alter table public.profiles add column if not exists invited_by uuid;

-- Case-insensitive uniqueness: codes are shown uppercase, but a user typing
-- "wonder42" must resolve. Partial, so existing NULLs do not collide.
create unique index if not exists profiles_invite_code_key
  on public.profiles (upper(invite_code))
  where invite_code is not null;

do $$ begin
  alter table public.profiles
    add constraint profiles_invited_by_fkey
    foreign key (invited_by) references public.profiles(id) on delete set null;
exception
  when duplicate_object then null;  -- already added by a previous run
  when others then null;            -- or the column set is already consistent
end $$;


-- ------------------------------------------------------------
-- 2. Redemptions: one row per person who arrived via an invite.
--
--    `invited_id` is UNIQUE, which is what makes "you can only be invited once"
--    a database guarantee rather than an application hope.
-- ------------------------------------------------------------
create table if not exists public.invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  invited_id uuid not null unique references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists invite_redemptions_inviter_idx
  on public.invite_redemptions (inviter_id, created_at desc);

alter table public.invite_redemptions enable row level security;

-- An inviter may see who they brought in. Nobody else may.
-- No INSERT policy on purpose: rows are only ever created by redeem_invite(),
-- which is SECURITY DEFINER. That keeps self-referral and duplicate redemption
-- impossible from the client.
drop policy if exists "inviter reads own redemptions" on public.invite_redemptions;
create policy "inviter reads own redemptions" on public.invite_redemptions
  for select using (inviter_id = auth.uid());


-- ------------------------------------------------------------
-- 3. Code generation.
-- ------------------------------------------------------------
create or replace function public._make_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  -- No 0/O/1/I/L: a code read aloud or copied from a photo must not be typable
  -- into a DIFFERENT valid code.
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  out text := '';
  i int;
begin
  for i in 1..6 loop
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return out;
end $$;

revoke all on function public._make_invite_code() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4. ensure_invite_code() - idempotent, safe to call on every app open.
--    Returns the caller's code, creating one on first call.
-- ------------------------------------------------------------
create or replace function public.ensure_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  existing text;
  attempt text;
  guard int := 0;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select invite_code into existing from public.profiles where id = uid;
  if existing is not null then return existing; end if;

  loop
    guard := guard + 1;
    attempt := public._make_invite_code();
    begin
      -- WHERE is required: pg-safeupdate rejects an UPDATE without one.
      update public.profiles set invite_code = attempt
        where id = uid and invite_code is null;
    exception when unique_violation then
      -- Someone else holds that code. Try another; give up rather than spin.
      if guard >= 12 then raise; end if;
    end;

    select invite_code into existing from public.profiles where id = uid;
    if existing is not null then return existing; end if;
    if guard >= 12 then raise exception 'could not allocate an invite code'; end if;
  end loop;
end $$;


-- ------------------------------------------------------------
-- 5. redeem_invite() - called once, by the person who was invited.
--
--    Returns a jsonb verdict rather than raising, because every failure here is
--    an ordinary user situation (typo, already used, own code) that the UI
--    should explain -- not an exception to swallow into a generic error.
-- ------------------------------------------------------------
create or replace function public.redeem_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  inviter uuid;
  inviter_name text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  -- Already credited to someone. Not an error worth alarming the user about.
  if exists (select 1 from public.invite_redemptions where invited_id = uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed');
  end if;

  select p.id, p.username into inviter, inviter_name
    from public.profiles p
   where upper(p.invite_code) = v_code
   limit 1;

  if inviter is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_code');
  end if;
  -- Redeeming your own code would inflate your count without adding a user.
  if inviter = uid then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;

  insert into public.invite_redemptions (code, inviter_id, invited_id)
  values (v_code, inviter, uid)
  on conflict (invited_id) do nothing;

  -- WHERE keeps this legal under pg-safeupdate, and the IS NULL guard means a
  -- second invite can never overwrite the first one recorded.
  update public.profiles set invited_by = inviter
    where id = uid and invited_by is null;

  return jsonb_build_object('ok', true, 'inviter', inviter_name);
end $$;


-- ------------------------------------------------------------
-- 6. my_invite_stats() - one call for the invite screen.
-- ------------------------------------------------------------
create or replace function public.my_invite_stats()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'code', (select invite_code from public.profiles where id = auth.uid()),
    'joined', (select count(*) from public.invite_redemptions where inviter_id = auth.uid())
  );
$$;


-- ------------------------------------------------------------
-- 7. PROOF - every row must look right or stop and tell me.
--    · invite_code_column : text
--    · invited_by_column  : uuid
--    · redemptions_table  : invite_redemptions
--    · codes_allocated    : 0 for now - nobody has opened the invite screen yet
--    · code_length_ok     : true (a generated sample is 6 chars)
-- ------------------------------------------------------------
select 'invite_code_column' as check,
       (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'profiles' and column_name = 'invite_code') as value
union all select 'invited_by_column',
       (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'profiles' and column_name = 'invited_by')
union all select 'redemptions_table',
       (select table_name from information_schema.tables
         where table_schema = 'public' and table_name = 'invite_redemptions')
union all select 'codes_allocated',
       (select count(*)::text from public.profiles where invite_code is not null)
union all select 'code_length_ok',
       (case when length(public._make_invite_code()) = 6 then 'true' else 'FALSE' end);
