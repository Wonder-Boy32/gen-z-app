-- ============================================================
-- GENZ — LIFETIME LIKES RECEIVED
-- A permanent per-profile counter of EVERY like the user has
-- ever received. Posts still expire after 48h, but the likes
-- they earned stay counted on the profile FOREVER.
--
-- Rules:
--   * like inserted            -> owner's counter +1
--   * like deleted by unliking -> owner's counter -1 (post still exists)
--   * post expires/deletes     -> its likes cascade-delete, but the
--                                 counter is NOT touched (post row is
--                                 already gone when the like rows go)
--
-- Run in the Supabase SQL editor. Safe to run more than once.
-- ============================================================

alter table public.profiles
  add column if not exists total_likes_received integer not null default 0;

-- ------------------------------------------------------------
-- Trigger: keeps total_likes_received in sync with likes.
-- Independent from the existing posts.likes_count triggers.
-- ------------------------------------------------------------
create or replace function public.bump_lifetime_likes()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' then
    select user_id into v_owner from public.posts where id = new.post_id;
    if v_owner is not null then
      update public.profiles
        set total_likes_received = total_likes_received + 1
        where id = v_owner;
    end if;
    return new;

  elsif tg_op = 'DELETE' then
    -- Subtract ONLY on a real unlike (post still exists). When the 48h
    -- purge deletes a post, its likes cascade-delete AFTER the post row
    -- is gone -> the guard below fails -> the like stays counted forever.
    if exists (select 1 from public.posts where id = old.post_id) then
      select user_id into v_owner from public.posts where id = old.post_id;
      if v_owner is not null then
        update public.profiles
          set total_likes_received = greatest(total_likes_received - 1, 0)
          where id = v_owner;
      end if;
    end if;
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists genz_lifetime_likes on public.likes;
create trigger genz_lifetime_likes
  after insert or delete on public.likes
  for each row execute function public.bump_lifetime_likes();

-- ------------------------------------------------------------
-- Backfill: expired posts are already gone (likes cascade-deleted),
-- so every like still in the table is on a LIVE post. The counter
-- starts at what the user has today and grows forever from now.
-- ------------------------------------------------------------
update public.profiles p
set total_likes_received = (
  select count(*)
  from public.likes l
  join public.posts po on po.id = l.post_id
  where po.user_id = p.id
);
