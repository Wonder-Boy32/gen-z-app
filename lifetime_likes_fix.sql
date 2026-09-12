-- ============================================================
-- LIFETIME LIKES FIX
-- Run this ONCE in Supabase Dashboard -> SQL Editor.
-- It adds a per-user "banked likes" counter and a trigger that
-- moves a post's likes into that counter the moment the post is
-- deleted (48h expiry purge, or manual delete). Profile totals
-- then never drop when a video expires.
-- ============================================================

-- 1) Permanent counter on profiles (missing on old DBs -> added)
alter table public.profiles
  add column if not exists lifetime_likes bigint not null default 0;

-- 2) Before a post row is deleted, add its current like count to the
--    author's lifetime total (runs before any FK cascade wipes the likes).
create or replace function public.bank_likes_on_post_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_like_count bigint;
begin
  select count(*) into v_like_count
    from public.likes
   where post_id = old.id;

  if v_like_count > 0 then
    update public.profiles
       set lifetime_likes = lifetime_likes + v_like_count
     where id = old.user_id;
  end if;

  return old;
end;
$$;

drop trigger if exists trg_bank_likes_on_post_delete on public.posts;
create trigger trg_bank_likes_on_post_delete
  before delete on public.posts
  for each row
  execute function public.bank_likes_on_post_delete();

-- 3) Sanity check (optional): confirm the column exists
select column_name, data_type, column_default
  from information_schema.columns
 where table_name = 'profiles'
   and column_name = 'lifetime_likes';
