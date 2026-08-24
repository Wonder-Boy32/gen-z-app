-- ============================================================
-- FIX: sync_hashtags() ran an UPDATE without a WHERE clause.
--
-- Supabase installs the pg-safeupdate extension, which REJECTS any
-- UPDATE/DELETE that lacks a WHERE clause with:
--   21000 "UPDATE requires a WHERE clause"
-- Every post INSERT fired this trigger, so EVERY drop publish failed
-- with that error even though the insert itself was fine.
--
-- This replaces the function with a filtered version that only
-- recomputes counts for the affected tags.
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ============================================================
create or replace function public.sync_hashtags()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  delete from public.post_hashtags where post_id = new.id;
  for t in
    select lower(m[1])
    from regexp_matches(
      coalesce(new.caption, '') || ' ' || coalesce(new.content, ''),
      '#([a-zA-Z0-9_]+)', 'g'
    ) m
  loop
    insert into public.post_hashtags (post_id, tag) values (new.id, t) on conflict do nothing;
  end loop;
  update public.hashtags h
    set count = (select count(*) from public.post_hashtags ph where ph.tag = h.tag),
        updated_at = now()
    where h.tag in (select tag from public.post_hashtags where post_id = coalesce(new.id, old.id));
  return new;
end;
$$;
