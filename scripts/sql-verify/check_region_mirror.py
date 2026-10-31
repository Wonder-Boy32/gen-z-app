"""Prove the location_region mirror actually mirrors.

20261101_06_profile_region_mirror.sql claims:
  1. existing rows with a region but no location_region get backfilled
  2. a NEW profile written with only a region also gets a location_region
  3. an UPDATE that changes region updates location_region too
  4. an update that does not touch region leaves location_region alone
     (so a manual admin correction is not wiped)

Point 4 is the one a trigger written in a hurry gets wrong: a BEFORE UPDATE
trigger fires on every update, and blindly copying region would silently
overwrite corrections forever.
"""
import pathlib
import sys
import tempfile

import pgserver
import psycopg

REPO = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = REPO / "supabase" / "20261101_06_profile_region_mirror.sql"

DATA = tempfile.mkdtemp(prefix="genz-region-")
db = pgserver.get_server(DATA, cleanup_mode=None)
DSN = db.get_uri().rpartition("/")[0] + "/postgres"

A = "11111111-1111-1111-1111-111111111111"
B = "22222222-2222-2222-2222-222222222222"
C = "33333333-3333-3333-3333-333333333333"

SETUP = f"""
-- Supabase always has these; a bare Postgres does not, and the migration
-- revokes from them by name.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create table public.profiles (
  id uuid primary key,
  username text,
  location text,
  region text,
  location_region text
);
insert into public.profiles (id, username, region, location_region) values
  ('{A}', 'a', 'Lagos', null),          -- needs backfill
  ('{B}', 'b', null, 'Kano');           -- manual value, must survive
"""

sql = MIGRATION.read_text(encoding="utf-8")
results = []


def note(label, ok, detail=""):
    results.append(ok)
    print("%-52s %s  %s" % (label, "PASS" if ok else "FAIL", detail))


with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute(SETUP)
    cur.execute(sql)

    cur.execute("select location_region from public.profiles where id = %s", (A,))
    note("existing row backfilled from region", cur.fetchone()[0] == "Lagos")

    cur.execute("select location_region from public.profiles where id = %s", (B,))
    note("row with no region keeps its manual value", cur.fetchone()[0] == "Kano")

    cur.execute("insert into public.profiles (id, username, region) values (%s,'c','Abuja')", (C,))
    cur.execute("select location_region from public.profiles where id = %s", (C,))
    note("INSERT with only a region is mirrored", cur.fetchone()[0] == "Abuja")

    cur.execute("update public.profiles set region = 'Ibadan' where id = %s", (A,))
    cur.execute("select location_region from public.profiles where id = %s", (A,))
    note("UPDATE of region is mirrored", cur.fetchone()[0] == "Ibadan")

    cur.execute("update public.profiles set location = 'somewhere' where id = %s", (B,))
    cur.execute("select location_region from public.profiles where id = %s", (B,))
    note("unrelated UPDATE leaves location_region alone", cur.fetchone()[0] == "Kano")

    cur.execute("update public.profiles set region = null where id = %s", (C,))
    cur.execute("select location_region from public.profiles where id = %s", (C,))
    note("clearing region does not erase location_region", cur.fetchone()[0] == "Abuja")

print("\n" + ("PASS" if all(results) else "FAIL"))
sys.exit(0 if all(results) else 1)
