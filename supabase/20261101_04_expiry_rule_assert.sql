-- ============================================================
-- GEN Z — ONE RULE, ONE PLACE: assert the 7-day Drop window
--
-- THE HAZARD
--   public.enforce_48h_expiry() is the BEFORE INSERT/UPDATE trigger that
--   decides how long a Drop lives. It is defined in TWO files:
--
--     expiry_v2.sql     -> new.expires_at := created_at + interval '48 hours'
--     seven_day_expiry.sql -> new.expires_at := created_at + interval '7 days'
--
--   Whichever runs LAST wins. The name still says 48h because renaming it
--   would drop the function a live trigger points at. So the real rule lives
--   only in a function body, and re-running the older file silently reverts
--   every Drop to two days. Nothing errors. Posts just start disappearing
--   three days early.
--
-- WHAT THIS DOES
--   1. Re-asserts the column default at 7 days (idempotent, no data touched).
--   2. Reads the deployed function body and RAISES if it is not a 7-day
--      window. A wrong rule becomes a loud failure at migration time instead
--      of a quiet product bug weeks later.
--
-- SAFETY
--   Non-destructive. It never updates posts, never drops a trigger, never
--   recreates the function. On a database without public.posts (such as the
--   verification stub) it notices and skips.
-- ============================================================

do $$
declare
  v_src     text;
  v_code    text;
  v_default text;
begin
  if to_regclass('public.posts') is null then
    raise notice 'skipped: public.posts does not exist here';
    return;
  end if;

  -- 1) the column default, belt and braces for a bypassed trigger
  execute 'alter table public.posts alter column expires_at set default (now() + interval ''7 days'')';
  select pg_get_expr(adbin, adrelid) into v_default
    from pg_attrdef
   where adrelid = 'public.posts'::regclass
     and adnum = (select attnum from pg_attribute
                   where attrelid = 'public.posts'::regclass and attname = 'expires_at');

  -- 2) the trigger body is the actual rule
  select prosrc into v_src
    from pg_proc
   where proname = 'enforce_48h_expiry'
     and pronamespace = 'public'::regnamespace;

  if v_src is null then
    raise notice 'enforce_48h_expiry() not found — no expiry trigger on this database';
    return;
  end if;

  -- Compare CODE, not prose. seven_day_expiry.sql keeps the historical name and
  -- explains the change in a comment that says "Was '48 hours'" — matching on
  -- the raw body flagged that comment as drift and failed a correct database.
  -- Stripping -- comments first is what makes the assertion about behaviour.
  v_code := regexp_replace(v_src, '--[^\n]*', '', 'g');

  if v_code ilike '%interval ''7 days''%' and v_code not ilike '%interval ''48 hours''%' then
    raise notice 'expiry rule OK: 7 days (default: %)', v_default;
  else
    raise exception
      'EXPIRY DRIFT: enforce_48h_expiry() is not a 7-day window. Apply supabase/seven_day_expiry.sql (it redefines this function to 7 days and rewrites existing rows). Default seen: %', v_default;
  end if;
end $$;
