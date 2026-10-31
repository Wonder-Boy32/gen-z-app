"""Prove the mutes consolidation moves rows and cannot lose them.

20261101_05_mutes_single_source.sql claims three things:
  1. every row in muted_accounts survives into muted_users
  2. the table is dropped only once it is empty
  3. the migration is re-runnable

Each is checked here against a real Postgres, with a pair that exists in both
tables and a pair that exists only in the table being retired — the second is
the case a naive `drop table` silently destroys.
"""
import pathlib
import sys
import tempfile

import pgserver
import psycopg

REPO = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = REPO / "supabase" / "20261101_05_mutes_single_source.sql"

DATA = tempfile.mkdtemp(prefix="genz-mutes-")
db = pgserver.get_server(DATA, cleanup_mode=None)
DSN = db.get_uri().rpartition("/")[0] + "/postgres"

A = "11111111-1111-1111-1111-111111111111"
B = "22222222-2222-2222-2222-222222222222"
C = "33333333-3333-3333-3333-333333333333"

SETUP = f"""
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.profiles (id uuid primary key, username text);
insert into public.profiles (id, username) values ('{A}','a'),('{B}','b'),('{C}','c');

create table public.muted_users (
  user_id uuid not null references public.profiles(id) on delete cascade,
  muted_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id)
);

create table public.muted_accounts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  muted_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id)
);

-- A muted B in BOTH tables (the split-brain pair, same fact twice)
insert into public.muted_users (user_id, muted_id) values ('{A}','{B}');
insert into public.muted_accounts (user_id, muted_id) values ('{A}','{B}');
-- A muted C only in the table being retired (the row a drop would destroy)
insert into public.muted_accounts (user_id, muted_id) values ('{A}','{C}');
"""

sql = MIGRATION.read_text(encoding="utf-8")
results = []


def note(label, ok, detail=""):
    results.append(ok)
    print("%-46s %s  %s" % (label, "PASS" if ok else "FAIL", detail))


with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute(SETUP)
    cur.execute(sql)

    cur.execute("select count(*) from public.muted_users where user_id = %s", (A,))
    n = cur.fetchone()[0]
    note("both rows present in muted_users", n == 2, f"rows={n} (expected 2)")

    cur.execute("select muted_id from public.muted_users where user_id = %s", (A,))
    got = {str(r[0]) for r in cur.fetchall()}
    note("the settings-only mute survived", C in got, "C present" if C in got else "C LOST")
    note("the duplicate did not double up", len(got) == 2, f"distinct={len(got)}")

    cur.execute("select to_regclass('public.muted_accounts') is null")
    note("muted_accounts dropped once empty", cur.fetchone()[0] is True)

    # re-run: must be a no-op, not an error
    try:
        cur.execute(sql)
        note("migration is re-runnable", True, "second run raised nothing")
    except Exception as e:
        note("migration is re-runnable", False, str(e).strip().splitlines()[0][:90])

    cur.execute("select count(*) from public.muted_users where user_id = %s", (A,))
    note("re-run did not change the data", cur.fetchone()[0] == 2)

print("\n" + ("PASS" if all(results) else "FAIL"))
sys.exit(0 if all(results) else 1)
