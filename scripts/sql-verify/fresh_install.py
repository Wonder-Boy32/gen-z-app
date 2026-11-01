"""Replay supabase/ into an empty PostgreSQL and report what breaks.

THE PROBLEM THIS ANSWERS
  76 .sql files, 65 of them hand-run, with no recorded order. Nobody can say
  today whether a fresh install reproduces the schema production is running.
  This rebuilds it from scratch, in the order declared in
  supabase/migrations.manifest.txt, and fails loudly.

HOW IT JUDGES
  Three outcomes per file, and the distinction is the whole point:

    OK     applied cleanly
    ENV    failed only because a Supabase-only capability is absent here
           (pg_cron / pg_net / vault / the Storage API / the real extensions).
           A real project has these, so this is not a defect.
    FAIL   everything else — a missing table, a wrong order, a broken
           statement. Every FAIL is a defect, including in this file's own
           ordering.

  Exit 0 requires zero FAIL. The manifest is input to be corrected, not a
  given: when the harness reports a dependency the order got wrong, the order
  is what changes.

Run: npm run verify:fresh
"""
import pathlib
import re
import sys
import tempfile

import pgserver
import psycopg

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
SUPABASE = REPO / "supabase"
MANIFEST = SUPABASE / "migrations.manifest.txt"

# An error is environmental when it is about the platform, not the schema.
ENV_PATTERNS = [
    r'extension "pg_cron" is not available',
    r'extension "pg_net" is not available',
    r'extension "[a-z_]+" is not available',
    r'could not open extension control file',
    r'permission denied to create extension',
    r'function net\.http_\w+\(.*\) does not exist',
    r'schema "supabase_migrations" does not exist',
]


def classify(err: str) -> str:
    for pat in ENV_PATTERNS:
        if re.search(pat, err, re.I):
            return "ENV"
    return "FAIL"


def apply(dsn: str, sql: str):
    """Execute a whole file. Returns (status, message)."""
    try:
        with psycopg.connect(dsn, autocommit=True) as c:
            c.execute(sql)
        return "OK", ""
    except Exception as e:
        msg = str(e).strip().splitlines()[0][:150]
        return classify(msg), msg


EXT_STMT = re.compile(
    r"^\s*create\s+extension\s+(?:if\s+not\s+exists\s+)?[\"']?[a-z0-9_]+[\"']?[^;]*;",
    re.I | re.M,
)


def strip_extension_statements(sql: str):
    """Remove only `create extension ...;` statements. Returns (sql, count)."""
    count = len(EXT_STMT.findall(sql))
    return EXT_STMT.sub("-- [harness] create extension removed (platform layer)", sql), count


def main() -> int:
    if not MANIFEST.exists():
        print(f"manifest missing: {MANIFEST}")
        return 2

    entries, skipped = [], []
    for raw in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!skip "):
            skipped.append(line.split(None, 1)[1].strip())
            continue
        entries.append(line)

    on_disk = {p.name for p in SUPABASE.glob("*.sql")}
    listed = set(entries) | set(skipped)
    missing = [e for e in entries if e not in on_disk]
    undeclared = sorted(on_disk - listed)

    data = tempfile.mkdtemp(prefix="genz-fresh-")
    db = pgserver.get_server(data, cleanup_mode=None)
    dsn = db.get_uri().rpartition("/")[0] + "/postgres"

    print("baseline: supabase_primitives.sql (roles, auth, storage, cron, net, vault)")
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute((HERE / "supabase_primitives.sql").read_text(encoding="utf-8"))

    results = []
    stripped_total = 0
    for name in entries:
        path = SUPABASE / name
        if not path.exists():
            results.append((name, "FAIL", "file listed in manifest does not exist"))
            continue

        # utf-8-sig: two files in this tree begin with a BOM, which Postgres
        # reports as `syntax error at or near "﻿"`. Handling it here keeps the
        # harness honest; the files themselves are fixed separately.
        sql = path.read_text(encoding="utf-8-sig")
        stripped = 0
        status, msg = apply(dsn, sql)

        # One retry, and only for the platform layer: a bare Postgres cannot
        # install pgcrypto/pg_cron/pg_net, and because the whole file is one
        # implicit transaction, a single unavailable extension rolls back every
        # table in it (that is exactly how schema.sql produced an empty
        # database). Strip just those statements and replay the rest.
        if status == "ENV" and "extension" in msg:
            reduced, stripped = strip_extension_statements(sql)
            if stripped:
                status, msg = apply(dsn, reduced)
                stripped_total += stripped

        detail = msg
        if stripped and status == "OK":
            detail = f"{stripped} extension statement(s) skipped (platform layer)"
        results.append((name, status, detail))

    if stripped_total:
        print(f"\nnote: {stripped_total} `create extension` statement(s) skipped across the run — "
              "absent from a bare Postgres, present on Supabase")

    ok = sum(1 for _, s, _ in results if s == "OK")
    env = [r for r in results if r[1] == "ENV"]
    fail = [r for r in results if r[1] == "FAIL"]

    print("\n%-52s %s" % ("file", "result"))
    print("-" * 78)
    for name, status, msg in results:
        if status != "OK":
            print("%-52s %-5s %s" % (name[:52], status, msg))

    print("\n" + "=" * 78)
    print(f"{ok} ok · {len(env)} env-only · {len(fail)} failed · {len(skipped)} skipped")
    if skipped:
        print("skipped: " + ", ".join(skipped))
    if undeclared:
        print("\nNOT IN THE MANIFEST (decide: add to the order, or mark !skip):")
        for u in undeclared:
            print("  " + u)
    if missing:
        print("\nLISTED BUT ABSENT:")
        for m in missing:
            print("  " + m)

    if fail:
        print("\nFIRST DEFECTS")
        for name, _, msg in fail[:12]:
            print(f"  {name}\n    {msg}")
    print("\n" + ("PASS" if not fail and not undeclared and not missing else "FAIL"))
    return 0 if (not fail and not undeclared and not missing) else 1


if __name__ == "__main__":
    sys.exit(main())
