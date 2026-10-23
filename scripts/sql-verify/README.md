# SQL migration verifier

Runs the six `supabase/20261023_0*.sql` hardening migrations against a real
throwaway PostgreSQL instance and asserts what they claim, rather than only
checking that they parse.

```bash
python -m pip install pgserver "psycopg[binary]"
python scripts/sql-verify/verify.py
```

Exit code 0 = all assertions held.

## What it checks

Storage ownership and enumeration: a conversation member may write only inside
their own folder, a non-member may write nothing, an object cannot be renamed
or re-bucketed into another user's prefix, and the public `media` bucket can no
longer be listed directly by any role.

Anonymous media: only a permitted recipient's folder accepts a write, the
sender cannot read back what they uploaded, and no third party can read the
recipient's folder.

Hashtags: insert, caption edit, duplicate tag in one caption, expiry and delete
all leave counters correct, and a client `UPDATE` cannot move a counter.

Expiry, view-once and admin roles: the client's requested expiry is clamped,
a message can be consumed exactly once by a non-sender participant, and an
admin cannot self-promote to `super_admin`.

Anonymous send: an unauthenticated caller is refused at the grant layer, a
blocked pair gets `anon_blocked`, and the refusal uses the code the UI maps.

## What it does not prove

It runs against `stub_schema.sql`, a minimal Supabase-shaped schema (auth,
storage, the handful of tables these migrations touch). It proves the
migrations are valid SQL and that policies, grants and guards deny the right
things under real PostgreSQL RLS semantics. It cannot prove the deployed
project has the same columns, nor anything about the data already in it.
