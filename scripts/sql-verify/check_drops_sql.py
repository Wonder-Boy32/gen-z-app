"""Prove the drop2.sql autoscheduler defect and its repair, for real.

The failing statement lives inside a dollar-quoted string passed to
cron.schedule(), so applying the migration file only proves the STRING was
stored -- never that the SQL inside it parses. That is exactly how drop2.sql
shipped broken: the job was created with text Postgres had never parsed.

So this executes both statements directly, against a real Postgres:

  BROKEN  order by random() / limit 1 / where not exists (...)  -> must raise
  FIXED   where not exists (...) / order by random() / limit 1  -> must return 1

Exit 0 when the broken form fails and the fixed form returns exactly one row.
"""
import sys
import tempfile

import pgserver
import psycopg

DATA = tempfile.mkdtemp(prefix="genz-drops-")
db = pgserver.get_server(DATA, cleanup_mode=None)
BASE = db.get_uri().rpartition("/")[0]
DSN = BASE + "/postgres"

PROMPTS = """('SHOW US YOUR CURRENT VIEW'),
            ('WHAT ARE YOU DOING RIGHT NOW?'),
            ('DROP YOUR FIT'),
            ('WHAT''S PLAYING RIGHT NOW?'),
            ('YOUR MOOD IN ONE VIDEO'),
            ('SHOW US SOMETHING NOBODY KNOWS ABOUT YOU'),
            ('YOUR FUNNIEST SCREENSHOT'),
            ('RATE YOUR DAY OUT OF 10 IN ONE POST')"""

HEAD = """insert into public.drops (prompt, status, starts_at, ends_at, voting_ends_at)
select p.prompt, 'scheduled',
       now() + interval '24 hours',
       now() + interval '24 hours 30 minutes',
       now() + interval '49 hours'
from (values {prompts}) as p(prompt)"""

BROKEN = HEAD.format(prompts=PROMPTS) + """
order by random()
limit 1
where not exists (
  select 1 from public.drops d where d.status = 'scheduled' and d.starts_at > now()
);"""

FIXED = HEAD.format(prompts=PROMPTS) + """
where not exists (
  select 1 from public.drops d where d.status = 'scheduled' and d.starts_at > now()
)
order by random()
limit 1;"""

with psycopg.connect(DSN, autocommit=True) as c, c.cursor() as cur:
    cur.execute("create table public.drops ("
                "id bigserial primary key, prompt text not null, status text not null, "
                "starts_at timestamptz not null, ends_at timestamptz, voting_ends_at timestamptz)")

    broke = None
    try:
        cur.execute(BROKEN)
    except Exception as e:
        broke = str(e).strip().splitlines()[0]
    print("broken form:", "RAISES -> " + broke if broke else "UNEXPECTEDLY ACCEPTED")

    runs = []
    for i in range(2):
        try:
            cur.execute(FIXED)
            runs.append(cur.rowcount)
        except Exception as e:
            runs.append(-1)
            print("fixed form run %d: RAISES -> %s" % (i + 1, str(e).strip().splitlines()[0]))
            break
        print("fixed form run %d: rows inserted = %d" % (i + 1, runs[-1]))

    cur.execute("select count(*) from public.drops where status = 'scheduled'")
    total = cur.fetchone()[0]
    print("scheduled rows after two runs:", total, "(must be 1 - the guard holds)")

ok = bool(broke) and runs == [1, 0] and total == 1
print("\n" + ("PASS" if ok else "FAIL"))
sys.exit(0 if ok else 1)
