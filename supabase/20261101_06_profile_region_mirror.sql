-- ============================================================
-- GEN Z — profiles.location_region is a column nobody writes
--
-- THE FINDING
--   profiles carries three location-ish columns:
--
--     location         free text the user types ("Lagos, Nigeria")
--                      -> shown on the profile. LIVE (1 of 8 rows).
--     region           free text the user types in the same Edit Profile
--                      sheet -> drives "Around You" in the feed and the
--                      region field on Discover. LIVE (2 of 8 rows).
--     location_region  added by admin_center.sql. NOTHING IN THE APP OR THE
--                      ADMIN CONSOLE EVER WRITES IT. 0 of 8 rows.
--
--   The admin console reads it in three places, so all three have been
--   silently dead:
--     · admin_user_list / admin_user_detail -> the "no region" text on
--       every row of Users
--     · notification audience targeting for 'country' and 'region'
--         (pr.location_region = v_n.audience_value) -> matched nobody
--     · the "regions" block of the geography analytics, which filters
--       on location_region is not null -> always an empty array
--
-- THE FIX, AND WHY IT IS A MIRROR RATHER THAN A RENAME
--   `region` is the value users actually enter, so it stays the single
--   source of truth. Rewriting the four admin functions to read `region`
--   would mean re-emitting ~1000 lines of admin_center.sql in a migration,
--   which is a far bigger risk than the problem. Instead location_region
--   becomes a derived mirror: the trigger keeps it equal to region, and
--   every existing admin query keeps working unchanged.
--
--   The cost is one redundant column kept honest by a trigger. That is a
--   deliberate trade, and the trigger is the only thing allowed to write it.
--
-- SAFETY
--   Additive. It backfills only rows where the value is actually different,
--   and it never touches `location` or `region`.
-- ============================================================

create or replace function public.sync_profile_location_region()
returns trigger language plpgsql set search_path = public as $$
begin
  -- region wins whenever it is set; otherwise leave whatever was there so a
  -- manual admin correction is not wiped by an unrelated profile save.
  if new.region is not null then
    new.location_region := new.region;
  end if;
  return new;
end $$;

revoke all on function public.sync_profile_location_region() from public, anon, authenticated;


-- ------------------------------------------------------------
-- Everything below needs BOTH columns to exist. A database where
-- feed_advanced.sql or admin_center.sql was never applied has neither, and
-- `update of region` in a trigger would be a hard error, not a no-op. So the
-- statements are dynamic and the guard is in one place.
-- ------------------------------------------------------------
do $$
declare
  v_has boolean;
  v_n   int := 0;
  v_bad int;
begin
  if to_regclass('public.profiles') is null then
    raise notice 'skip: profiles not present here';
    return;
  end if;

  select count(*) = 2 into v_has
    from pg_attribute
   where attrelid = 'public.profiles'::regclass
     and attname in ('region', 'location_region')
     and not attisdropped;

  if not v_has then
    raise notice 'skip: profiles has no region/location_region column here';
    return;
  end if;

  execute 'drop trigger if exists profiles_sync_region on public.profiles';
  execute 'create trigger profiles_sync_region before insert or update of region '
          'on public.profiles for each row '
          'execute function public.sync_profile_location_region()';

  execute 'update public.profiles
              set location_region = region
            where region is not null
              and location_region is distinct from region';
  get diagnostics v_n = row_count;
  raise notice 'location_region mirrored from region on % profile row(s)', v_n;

  execute 'select count(*) from public.profiles
            where region is not null
              and location_region is distinct from region' into v_bad;
  if v_bad = 0 then
    raise notice 'proof ok: no profile has a location_region that disagrees with region';
  else
    raise exception 'proof failed: % profile(s) still disagree after the backfill', v_bad;
  end if;
end $$;
