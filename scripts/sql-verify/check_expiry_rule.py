"""Prove the expiry assertion catches drift instead of assuming it does.

20261101_04_expiry_rule_assert.sql is meant to raise when the deployed
enforce_48h_expiry() is a 48-hour rule. An assertion that has never been seen
to fail is decoration, so this runs it against a real Postgres three times:

  48h body       -> must RAISE, and the message must name the drift
  7d body        -> must pass, and the column default must read 7 days
  no posts table -> must pass without raising (it skips)

Exit 0 only if all three behave as described.
"""
import pathlib
import sys
import tempfile

import pgserver
import psycopg

REPO = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = REPO / "supabase" / "20261101_04_expiry_rule_assert.sql"

DATA = tempfile.mkdtemp(prefix="genz-expiry-")
db = pgserver.get_server(DATA, cleanup_mode=None)
DSN = db.get_uri().rpartition("/")[0] + "/postgres"

CREATE_POSTS = """
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
"""

BODY_48 = """
create or replace function public.enforce_48h_expiry()
returns trigger language plpgsql as $f$
begin
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  new.expires_at := new.created_at + interval '48 hours';
  return new;
end $f$;
"""

BODY_7D = BODY_48.replace("interval '48 hours'", "interval '7 days'")

DEFAULT_EXPR = """
select pg_get_expr(adbin, adrelid)
  from pg_attrdef
 where adrelid = 'public.posts'::regclass
   and adnum = (select attnum from pg_attribute
                 where attrelid = 'public.posts'::regclass
                   and attname = 'expires_at')
"""

sql = MIGRATION.read_text(encoding="utf-8")
results = []


def default_expr():
    try:
        with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
            cur.execute(DEFAULT_EXPR)
            row = cur.fetchone()
            return row[0] if row else None
    except Exception:
        return None


def run(label, expect):
    """expect: 'raise' | 'pass'"""
    raised = None
    try:
        with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
            cur.execute(sql)
    except Exception as e:
        raised = str(e).strip().splitlines()[0][:150]

    if raised:
        got, detail = "raise", raised
    else:
        d = default_expr() or ""
        # with no posts table there is no default to inspect; that path only
        # has to not raise, which is already true here
        got = "pass" if ("7 days" in d or "no posts table" in label) else "raise"
        detail = "default=" + (d or "n/a")

    ok = got == expect and (expect != "raise" or "EXPIRY DRIFT" in (raised or ""))
    results.append(ok)
    print("%-14s expect=%-5s got=%-5s %s  %s"
          % (label, expect, got, "OK " if ok else "BAD", detail))


with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute(CREATE_POSTS)
    cur.execute(BODY_48)
run("48h body", "raise")

with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute(BODY_7D)
run("7d body", "pass")

with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute("drop table public.posts")
run("no posts table", "pass")

print("\n" + ("PASS" if all(results) else "FAIL"))
sys.exit(0 if all(results) else 1)
