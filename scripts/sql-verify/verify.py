"""Executes the six 20261023 hardening migrations against a real, throwaway
PostgreSQL and asserts the security properties they claim -- not just that the
SQL parses. Run: python scripts/sql-verify/verify.py

Exit code 0 means every assertion held. Anything else means at least one
policy, grant or guard does not behave as documented.

What this does NOT prove: it runs against stub_schema.sql, a minimal
Supabase-shaped schema, not the deployed one. It proves the migrations are
valid SQL and that the policies/guards deny the right things given real
Postgres RLS semantics. It cannot prove the live project's tables have the
columns assumed here.
"""
import pathlib
import sys
import tempfile

import pgserver
import psycopg

REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
DATA = pathlib.Path(tempfile.mkdtemp(prefix="genz-sqlverify-"))
db = pgserver.get_server(str(DATA), cleanup_mode=None)
uri = db.get_uri()
BASE = uri.rpartition("/")[0]

with psycopg.connect(BASE + "/postgres", autocommit=True) as _c:
    _c.execute("drop database if exists genz_verify")
    _c.execute("create database genz_verify")
DSN = BASE + "/genz_verify"

with psycopg.connect(DSN, autocommit=True) as _c:
    _c.execute((HERE / "stub_schema.sql").read_text(encoding="utf-8"))
print("stub schema applied")

for _f in sorted((REPO / "supabase").glob("2026*.sql")):
    with psycopg.connect(DSN, autocommit=True) as _c:
        _c.execute(_f.read_text(encoding="utf-8"))
    print("applied  " + _f.name)
print()

A = "11111111-1111-1111-1111-111111111111"
B = "22222222-2222-2222-2222-222222222222"
C = "33333333-3333-3333-3333-333333333333"
CONV_AB = "aaaaaaaa-0000-0000-0000-000000000001"
CONV_BC = "bbbbbbbb-0000-0000-0000-000000000002"

results = []

def note(name, passed, detail=""):
    results.append((name, passed, detail))
    print(("PASS  " if passed else "FAIL  ") + name + (("  <- " + detail) if detail and not passed else ""))

def try_as(role, uid, sql, params=()):
    """Run one statement as `role` with uid as auth.uid(). Returns (ok, err)."""
    try:
        with psycopg.connect(DSN) as c:
            c.autocommit = False
            with c.cursor() as cur:
                cur.execute("set local role " + role)
                if uid:
                    cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
                cur.execute(sql, params)
            c.rollback()
        return True, ""
    except Exception as e:
        return False, str(e).strip().splitlines()[0][:160]

def expect_block(name, role, uid, sql, params=()):
    ok, err = try_as(role, uid, sql, params)
    note(name, not ok, "ALLOWED but should be blocked" if ok else "")
    return ok

def expect_allow(name, role, uid, sql, params=()):
    ok, err = try_as(role, uid, sql, params)
    note(name, ok, err if not ok else "")
    return ok

def persist_as(role, uid, sql, params=()):
    """Same as try_as but COMMITS, so later reads see the row."""
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute("set role " + role)
            if uid:
                cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (uid,))
            cur.execute(sql, params)

def visible(role, uid, sql, params=()):
    """Rows actually visible to `role` after RLS filtering."""
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute("set local role " + role)
            if uid:
                cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
            cur.execute(sql, params)
            n = len(cur.fetchall())
        c.rollback()
        return n

def expect_visible(name, role, uid, sql, params, want):
    n = visible(role, uid, sql, params)
    note(name, n == want, f"saw {n} row(s), expected {want}")

def scalar(role, uid, sql):
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            if role:
                cur.execute("set local role " + role)
            if uid:
                cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
            cur.execute(sql)
            r = cur.fetchone()
        c.rollback()
        return r[0] if r else None

# ---------------------------------------------------------------- seed
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("insert into public.profiles (id, username) values (%(A)s,'a'),(%(B)s,'b'),(%(C)s,'c')",
              {"A": A, "B": B, "C": C})
    c.execute("insert into public.conversations (id, is_group) values (%(c1)s,false),(%(c2)s,false)",
              {"c1": CONV_AB, "c2": CONV_BC})
    c.execute("insert into public.conversation_participants (conversation_id,user_id) values "
              "(%(c1)s,%(A)s),(%(c1)s,%(B)s),(%(c2)s,%(B)s),(%(c2)s,%(C)s)",
              {"A": A, "B": B, "C": C, "c1": CONV_AB, "c2": CONV_BC})
print("seeded\n")

INS = "insert into storage.objects (bucket_id, name, owner) values (%s,%s,%s)"

# ------------------------------------------------- P1 chat-media ownership
expect_allow("chat-media: member writes inside own folder",
             "authenticated", A, INS, ("chat-media", CONV_AB + "/" + A + "/pic.jpg", A))
expect_block("chat-media: member cannot write into another member's folder",
             "authenticated", A, INS, ("chat-media", CONV_AB + "/" + B + "/pic.jpg", A))
expect_block("chat-media: non-member cannot write into a conversation at all",
             "authenticated", A, INS, ("chat-media", CONV_BC + "/" + A + "/pic.jpg", A))
expect_block("chat-media: anon role cannot write",
             "anon", None, INS, ("chat-media", CONV_AB + "/" + A + "/pic.jpg", A))
expect_visible("chat-media: unauthenticated sees no chat media at all",
               "anon", None, "select 1 from storage.objects where bucket_id='chat-media'", (), 0)

# B is in both conversations; plant a DUrable row in CONV_BC so A's zero-row
# read is evidence of RLS filtering rather than an empty table.
persist_as("authenticated", B, INS, ("chat-media", CONV_BC + "/" + B + "/secret.jpg", B))
note("chat-media: planted row exists (so the zero read below is policy)",
     scalar(None, None, "select count(*) from storage.objects where bucket_id='chat-media' and name like '%s/%%'" % CONV_BC) == 1)

# rename into someone else's prefix: USING passes (own row), WITH CHECK must stop it
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("set role authenticated")
    c.execute("select set_config('request.jwt.claim.sub', %s, false)", (A,))
    c.execute(INS.replace("(%s,%s,%s)", "('chat-media','%s/%s/planted.jpg','%s')" % (CONV_AB, A, A)))
    c.execute("reset role")
expect_block("chat-media: cannot RENAME own object into another user's folder",
             "authenticated", A,
             "update storage.objects set name = %s where bucket_id='chat-media' and name=%s",
             (CONV_AB + "/" + B + "/stolen.jpg", CONV_AB + "/" + A + "/planted.jpg"))
expect_block("chat-media: cannot REBUCKET own object into another conversation",
             "authenticated", A,
             "update storage.objects set bucket_id=%s, name=%s where bucket_id='chat-media' and name=%s",
             ("anon-media", B + "/x.jpg", CONV_AB + "/" + A + "/planted.jpg"))
expect_visible("chat-media: can read a conversation you belong to",
               "authenticated", B,
               "select 1 from storage.objects where bucket_id='chat-media' and name like %s",
               (CONV_AB + "/%",), 1)
expect_visible("chat-media: cannot read a conversation you are not in",
               "authenticated", A,
               "select 1 from storage.objects where bucket_id='chat-media' and name like %s",
               (CONV_BC + "/%",), 0)

# ------------------------------------------------- anon-media recipient scope
expect_allow("anon-media: sender may write into the recipient's folder",
             "authenticated", A, INS, ("anon-media", B + "/note.jpg", A))
# writing into C's folder is legitimate: A is allowed to send to C.
# The cases that must fail are non-recipients.
expect_block("anon-media: cannot write into a recipient that does not exist",
             "authenticated", A, INS, ("anon-media", "99999999-9999-9999-9999-999999999999/x.jpg", A))
expect_block("anon-media: cannot write into a path that is not a uuid folder",
             "authenticated", A, INS, ("anon-media", "not-a-uuid/x.jpg", A))
persist_as("authenticated", A, INS, ("anon-media", B + "/note-keep.jpg", A))
expect_visible("anon-media: sender may not read back their own upload",
               "authenticated", A,
               "select 1 from storage.objects where bucket_id='anon-media' and name like %s",
               (B + "/%",), 0)
expect_visible("anon-media: recipient may read their folder",
               "authenticated", B,
               "select 1 from storage.objects where bucket_id='anon-media' and name like %s",
               (B + "/%",), 1)
expect_visible("anon-media: third party cannot read the recipient's folder",
               "authenticated", C,
               "select 1 from storage.objects where bucket_id='anon-media' and name like %s",
               (B + "/%",), 0)

# --------------------------------------- media bucket: writes still work
expect_allow("media: avatar path in own prefix still writable",
             "authenticated", A, INS, ("media", "avatars/" + A + "/avatar-1.jpg", A))
expect_block("media: cannot write an avatar into another user's prefix",
             "authenticated", A, INS, ("media", "avatars/" + B + "/avatar-1.jpg", A))
expect_allow("media: own drop path still writable",
             "authenticated", A, INS, ("media", A + "/drop-1.mp4", A))
expect_block("media: legacy chat/<conv>/ path is refused (documented break)",
             "authenticated", A, INS, ("media", "chat/" + CONV_AB + "/old.jpg", A))
expect_allow("media: new wallpaper prefix writable",
             "authenticated", A, INS, ("media", "chat-wallpapers/" + A + "/wall.jpg", A))
expect_block("media: path with no uuid owner refused",
             "authenticated", A, INS, ("media", "junk/whatever.jpg", A))

# now that rows exist in the public bucket, prove direct enumeration is closed
expect_visible("media: authenticated cannot LIST the public bucket (enumeration closed)",
               "authenticated", A, "select 1 from storage.objects where bucket_id='media'", (), 0)
expect_visible("media: anon cannot LIST the public bucket",
               "anon", None, "select 1 from storage.objects where bucket_id='media'", (), 0)
persist_as("authenticated", A, INS, ("media", "avatars/" + A + "/avatar-keep.jpg", A))
_n = scalar(None, None, "select count(*) from storage.objects where bucket_id='media'")
note(f"media: {_n} row(s) really are present, so the zero above is policy not emptiness",
     _n >= 1, "no media rows planted")

# ------------------------------------------------------- P3 hashtag sync
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("set role authenticated")
    c.execute("select set_config('request.jwt.claim.sub', %s, false)", (A,))
    c.execute("insert into public.posts (id,user_id,content) values "
              "('dddddddd-0000-0000-0000-000000000001',%s,'#one #two #three')", (A,))
    c.execute("reset role")
counts = scalar(None, None, "select string_agg(tag||'='||count, ',' order by tag) from public.hashtags")
note("hashtags: insert counts each tag once", counts == "one=1,three=1,two=1", str(counts))

with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("set role authenticated")
    c.execute("select set_config('request.jwt.claim.sub', %s, false)", (A,))
    c.execute("update public.posts set content='#one' where id='dddddddd-0000-0000-0000-000000000001'")
    c.execute("reset role")
counts = scalar(None, None, "select string_agg(tag||'='||count, ',' order by tag) from public.hashtags where count > 0")
note("hashtags: caption edit decrements removed tags to zero", counts == "one=1", str(counts))
note("hashtags: stale tag rows are not left with a stale positive count",
     scalar(None, None, "select count(*) from public.hashtags where tag in ('two','three') and count > 0") == 0)

with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("update public.posts set content='#one again #one' where id='dddddddd-0000-0000-0000-000000000001'")
counts = scalar(None, None, "select count from public.hashtags where tag='one'")
note("hashtags: duplicate tag in one caption counts once", counts == 1, str(counts))

with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("update public.posts set expires_at = now() - interval '1 hour' "
              "where id='dddddddd-0000-0000-0000-000000000001'")
live = scalar(None, None, "select public._tag_live_count('one')")
note("hashtags: expired post no longer counts as live", live == 0, str(live))
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("delete from public.posts where id='dddddddd-0000-0000-0000-000000000001'")
note("hashtags: delete removes the post's tag contribution",
     scalar(None, None, "select count(*) from public.hashtags where count > 0") == 0)
# RLS filters a client UPDATE to zero rows rather than raising, so the
# assertion has to be on the stored value, not on an exception.
try_as("authenticated", A, "update public.hashtags set count = 9999 where tag='one'")
note("hashtags: client UPDATE cannot move a counter (silently affects 0 rows)",
     scalar(None, None, "select count(*) from public.hashtags where count = 9999") == 0)

# ------------------------------------------------------- P6 message clamp
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("set role authenticated")
    c.execute("select set_config('request.jwt.claim.sub', %s, false)", (A,))
    c.execute("insert into public.messages (conversation_id,sender_id,content,expires_at) "
              "values (%s,%s,'x', now() + interval '30 days')", (CONV_AB, A))
    c.execute("reset role")
drift = scalar(None, None, "select extract(epoch from (expires_at - created_at))/3600 "
                           "from public.messages order by created_at desc limit 1")
note("expiry: client-requested 30 days is clamped to 24h", drift is not None and abs(drift - 24) < 1, str(drift))

# --------------------------------------------------------- P6 view once
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("insert into public.messages (id,conversation_id,sender_id,content,view_once) "
              "values ('eeeeeeee-0000-0000-0000-000000000001',%s,%s,'secret',true)", (CONV_AB, A))
ok, err = try_as("authenticated", A, "select public.consume_view_once('eeeeeeee-0000-0000-0000-000000000001')")
note("view-once: sender cannot consume their own view-once message", not ok, "allowed")
ok, err = try_as("authenticated", C, "select public.consume_view_once('eeeeeeee-0000-0000-0000-000000000001')")
note("view-once: non-member cannot consume", not ok, "allowed")
persist_as("authenticated", B, "select public.consume_view_once('eeeeeeee-0000-0000-0000-000000000001')")
note("view-once: recipient can consume once",
     scalar(None, None, "select view_once_consumed_at is not null from public.messages "
                        "where id='eeeeeeee-0000-0000-0000-000000000001'") is True)
ok, err = try_as("authenticated", B, "select public.consume_view_once('eeeeeeee-0000-0000-0000-000000000001')")
note("view-once: second consumption is refused", not ok, "allowed twice")
note("view-once: consumption recorded server-side",
     scalar(None, None, "select view_once_consumed_at is not null from public.messages "
                        "where id='eeeeeeee-0000-0000-0000-000000000001'") is True)
note("view-once: consumer is recorded",
     scalar(None, None, "select count(*) from public.message_views where message_id='eeeeeeee-0000-0000-0000-000000000001'") == 1)

# --------------------------------------------------- P7 admin escalation
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("insert into public.admin_users (user_id, role, status) values (%s,'admin','active'),(%s,'super_admin','active')", (A, B))
ok, err = try_as("authenticated", A, "select public.admin_admin_set_role(%s,'super_admin')", (A,))
note("admin: a plain admin cannot self-promote to super_admin", not ok, "allowed")
ok, err = try_as("authenticated", A, "select public.admin_admin_set_role(%s,'moderator')", (C,))
note("admin: an admin can still grant ordinary roles", ok, err)
ok, err = try_as("authenticated", B, "select public.admin_admin_set_role(%s,'super_admin')", (C,))
note("admin: super_admin can grant super_admin", ok, err)
# There are now two active super_admins (B and C). B disables C, leaving one.
ok, err = try_as("authenticated", B, "select public.admin_admin_remove(%s)", (C,))
note("admin: a super_admin can disable another super_admin", ok, err)
# The remaining super_admin cannot disable themselves, which is what keeps
# at least one active super_admin alive. The counter guard inside the function
# (cannot_disable_last_super_admin) is unreachable through this RPC: it needs
# caller and target both super_admin and no other active super to exist.
ok, err = try_as("authenticated", B, "select public.admin_admin_remove(%s)", (B,))
note("admin: the remaining super_admin cannot remove themselves", not ok, "removed")
note("admin: at least one active super_admin always survives",
     scalar(None, None, "select count(*) from public.admin_users "
                        "where role='super_admin' and status='active'") >= 1)

# ------------------------------------------------ P6 anonymous send anon-grant
ok, err = try_as("anon", None,
                 "select public.send_anonymous_message(%s,'hi','text',null,null,interval '24 hours')", (C,))
note("anon-send: unauthenticated caller is refused", not ok, "allowed")
ok, err = try_as("authenticated", A,
                 "select public.send_anonymous_message(%s,'hi','text',null,null,interval '24 hours')", (C,))
note("anon-send: signed-in sender allowed on a clean recipient", ok, err)
with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("insert into public.blocks (blocker_id, blocked_id) values (%s,%s)", (C, A))
ok, err = try_as("authenticated", A,
                 "select public.send_anonymous_message(%s,'hi','text',null,null,interval '24 hours')", (C,))
note("anon-send: blocked pair is refused", not ok, "allowed")
note("anon-send: refusal raises a code the UI maps",
     "anon_blocked" in err or "blocked" in err.lower(), err)

# ------------------------------------------------ Phase 2 policy assertions
# A guard, because this harness has already lied twice in the same way: it
# asserted against a table where the stub enabled RLS but defined no SELECT
# policy. Postgres requires an UPDATE to select the row it will lock, so the
# write matched zero rows and reported success. The policy under test looked
# broken when in fact the fixture made every row invisible.
#
# Any watched table with RLS on and no SELECT/ALL policy is a fixture bug, not
# a finding. Fail here, before the assertions, so the cause is never ambiguous.
_WATCHED = {"conversations", "messages", "posts", "profiles", "hashtags", "objects"}


def rls_without_select():
    sql = """
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'storage')
           and c.relkind = 'r'
           and c.relrowsecurity
           and not exists (
                 select 1 from pg_policies p
                  where p.schemaname = n.nspname
                    and p.tablename = c.relname
                    and p.cmd in ('SELECT', 'ALL'))
         order by 1
    """
    with psycopg.connect(DSN) as c:
        with c.cursor() as cur:
            cur.execute(sql)
            rows = [r[0] for r in cur.fetchall()]
        c.rollback()
    return [t for t in rows if t in _WATCHED]


_blind = rls_without_select()
note("fixture: every watched table has a SELECT policy when RLS is on",
     not _blind,
     "blind tables (rows invisible, writes silently no-op): " + ", ".join(_blind))

# try_as only answers "did it raise?". These need row counts: an RLS-filtered
# UPDATE succeeds and changes nothing, which is precisely the bug that made
# conversation edits silently no-op.
def count_as(role, uid, sql, params=()):
    try:
        with psycopg.connect(DSN) as c:
            c.autocommit = False
            with c.cursor() as cur:
                cur.execute("set local role " + role)
                if uid:
                    cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (uid,))
                cur.execute(sql, params)
                n = cur.rowcount if cur.description is None else len(cur.fetchall())
            c.rollback()
        return n, ""
    except Exception as e:
        return -1, str(e).strip().splitlines()[0][:160]

n, err = count_as("authenticated", A, "update public.conversations set id = id where id = %s", (CONV_AB,))
note("conversations: a participant can update the conversation", n == 1, f"rows={n} {err}")

n, err = count_as("authenticated", C, "update public.conversations set id = id where id = %s", (CONV_AB,))
note("conversations: a non-participant cannot update it", n == 0, f"rows={n} {err}")

with psycopg.connect(DSN, autocommit=True) as c:
    c.execute("insert into storage.objects (bucket_id,name,owner) values ('chat-media', %s, %s) on conflict do nothing",
              (CONV_AB + "/" + C + "/x.jpg", C))

n, err = count_as("authenticated", A, "update storage.objects set owner = owner where name = %s", (CONV_AB + "/" + C + "/x.jpg",))
note("chat-media: a member cannot rewrite another member's object", n == 0, f"rows={n} {err}")

n, err = count_as("authenticated", C, "update storage.objects set owner = owner where name = %s", (CONV_AB + "/" + C + "/x.jpg",))
note("chat-media: a non-member cannot update it even as owner", n == 0, f"rows={n} {err}")
print("\n--- refusal reasons (a block only counts if it fires for this reason) ---")
_diag = [
  ("chat-media foreign folder", "authenticated", A,
   "insert into storage.objects (bucket_id,name,owner) values ('chat-media','" + CONV_AB + "/" + B + "/x.jpg','" + A + "')"),
  ("anon-media non-recipient", "authenticated", A,
   "insert into storage.objects (bucket_id,name,owner) values ('anon-media','99999999-9999-9999-9999-999999999999/x.jpg','%s')" % A),
  ("media foreign avatar folder", "authenticated", A,
   "insert into storage.objects (bucket_id,name,owner) values ('media','avatars/%s/x.jpg','%s')" % (B, A)),
  ("admin self-promote", "authenticated", A, "select public.admin_admin_set_role('%s','super_admin')" % A),
  ("last super_admin removal", "authenticated", B, "select public.admin_admin_remove('%s')" % B),
  ("anon-send while blocked", "authenticated", A,
   "select public.send_anonymous_message('%s','hi','text',null,null,interval '24 hours')" % C),
  ("unauthenticated send", "anon", None,
   "select public.send_anonymous_message('%s','hi','text',null,null,interval '24 hours')" % C),
  ("client moves hashtag counter", "authenticated", A,
   "update public.hashtags set count = 9999 where tag='one'"),
]
for _n, _r, _u, _q in _diag:
    _ok, _err = try_as(_r, _u, _q)
    print(("  " + _n).ljust(34) + " => " + ("ALLOWED" if _ok else _err[:110]))

print("\n" + "=" * 60)
p = sum(1 for _, ok_, _ in results if ok_)
print(f"{p}/{len(results)} assertions passed")
for n, ok_, d in results:
    if not ok_:
        print("  FAILED: " + n + "  " + d)
sys.exit(0 if p == len(results) else 1)
