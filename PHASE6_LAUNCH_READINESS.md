# Phase 6 — Testing & Launch Readiness

**Date:** 2026-11-01 · **Branch:** `dev/phase2-stability` · **Project:** GenZ (`fwouxamnmfdzwxpefoyb`, PRODUCTION)

Everything below was executed, not inferred. Where a check could not be run
from this machine, it is listed as not run rather than assumed to pass.

---

## 1. Automated checks — all green

| Check | Command | Result |
|---|---|---|
| TypeScript (app) | `npx tsc --noEmit` | exit 0, no diagnostics |
| Expo config & deps | `npx expo-doctor` | 21/21 checks passed |
| TypeScript + build (admin) | `cd admin && npm run build` | clean; `dist/assets/index-BkqJXyPo.js` 948.62 kB (269.14 kB gzip) |
| Migrations tracked | `git ls-files supabase/*.sql` | 79 on disk, 79 tracked — a fresh clone can rebuild |

The 948 kB admin bundle trips Vite's 500 kB chunk warning. It is a size note,
not a failure; code-splitting is worth doing before the console is shared widely.

## 2. RLS proven against live accounts — 7/7

`npm run test:rls` creates three real accounts (A, B, C) with real JWTs,
asserts each boundary, then deletes every account and row it made. Real JWTs
matter here because the service key bypasses RLS and would prove nothing.

```
PASS T1  A cannot write B's profile           PATCH returned 0 rows, name unchanged
PASS T2  participant CAN update conversation  status 200, 1 row affected
PASS T3  non-participant CANNOT               status 200, 0 rows affected, name unchanged
PASS T4  mutes owner-only, not forgeable      own 201, forged 403, 0 foreign rows visible
PASS T5  chat-media member-only               upload 200, member 200, outsider 400
PASS T6  Drop cannot exceed 7 days            requested 30 days, stored 7.000 days
PASS T7  messages invisible to outsider       C saw 0, A saw 1
```

T2 and T3 together are the important pair. T3 alone would pass on a table with
no UPDATE policy at all — which is exactly the bug that was there. Only T2
proves the policy works, and only T3 proves it is not too broad.

**First run was 6/7.** T7 failed because the fixture sent `body` as a plain
string, while `messages.body` is JSONB and `messages_body_valid_chk` requires
`{ "text": ... }` for a `kind = 'text'` message. The constraint was correct and
the test was wrong. Fixed, re-run, clean.

Production was verified back to baseline afterwards: 8 users, 8 profiles,
0 posts, 0 mutes, 0 test accounts.

## 3. The defect this phase found

While auditing storage before Phase 6, the public `media` bucket held 56
objects against **0 post rows**. 46 of them were unreferenced post media, still
downloadable by anyone holding the URL, with `media_cleanup_queue` holding **0
rows** — so the retry mechanism knew nothing about them.

Expired Drops had outlived their seven days. The seven-day promise was true in
the database and false on the CDN.

**Cause** — `genz_storage_delete()` fires the Storage API DELETE through
`pg_net`, polls `net._http_response` for 5 seconds, and on silence returned:

```sql
ok := true; status := 0; err := 'in_flight';  -- not a failure
```

`genz_purge_expired()` reads `ok = true` as "bytes deleted", drops the row, and
never queues the path. Silence was indistinguishable from success, so the one
mechanism designed to catch a failed delete was never told about it.

**Fix** (`20261101_08`, applied and proved by reading `prosrc` back):
silence is now `ok = false`, which makes the caller queue the path. Retries are
self-healing — a second attempt on an already-deleted object returns 404, which
is accepted as success, so the queue drains either way.

**Cleanup** — 46 objects plus one orphaned legacy `chat/` image, all removed.
`npm run cleanup:media` was written for this because
`genz_cleanup_orphan_media()` polls per object and exceeded the SQL editor's
statement timeout twice at 32 orphans. The script takes its deletion set from
the server's own report, re-checks it against a locally derived reference set,
never touches `avatars/`, and requires `--apply --yes`. Result: 0 auto, 0
review remaining.

`migrate-private-media.mjs --dry-run` now reports all 13 message references
already private and present — that migration has no work left to do.

## 4. Not verified — needs a device I do not have

These are the checks that cannot pass or fail from a shell, and I am not going
to claim them:

- **White / light theme legibility** across every screen. `npm run check:theme`
  passes for the sub-10% white-alpha class, but no light-mode render has been
  looked at on a device. `check:theme --inventory` still lists ~23 near-black
  literals that the checker does not enforce.
- **Tab dock, StoryViewer, peek modal** on a real screen with real insets.
- **Video download bake** — watermark and jingle on a downloaded file, plus the
  `ffmpeg-expo` swap. `verify-download-bake.js` exercises the logic, not the
  output pixels.
- **Keyboard behaviour** in chat and the create flow under Gboard with different
  insets.
- **Push delivery** on a physical device (token registration through to a
  notification arriving).

## 5. Blockers that are yours to close

| Item | Why it is yours |
|---|---|
| Rotate the Giphy key | Needs your Giphy account. Note: `EXPO_PUBLIC_GIPHY_API_KEY` is compiled into the client bundle, so rotation only takes effect after a rebuild — and the durable fix is restricting the key by Android package name / web origin in the Giphy dashboard, since any client-side key is extractable by design. |
| Revoke the GitHub PAT pasted in an earlier session | Only you can revoke it. |
| Real Android device pass | Section 4 above. |
| APK / Play Store prep | Needs the release keystore and Play Console access. |

## 6. Reproduce any of this

```bash
npx tsc --noEmit
npx expo-doctor
cd admin && npm run build

node --env-file=.env --env-file=scripts/.secrets.env scripts/rls-test.mjs
node --env-file=.env --env-file=scripts/.secrets.env scripts/cleanup-orphan-media.mjs
node --env-file=.env --env-file=scripts/.secrets.env scripts/migrate-private-media.mjs --verify
```

The service-role key lives in `scripts/.secrets.env` (git-ignored). It was moved
out of `.env.local` because Expo auto-loads that file into the dev process, so
the key sat in the bundler's environment for no reason.
