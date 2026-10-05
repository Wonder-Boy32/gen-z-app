# Discover → "For You" — CORRECTED proposal

**Status:** supersedes the first draft of this file, which was wrong.
**Decision: option B — shipped.** The `For You` chip is now `✨ Creators`, a
people-discovery surface ranked by the shared scorer.
**Verdict: do NOT build a new ranked For You on Discover.** The app already has a
better one on Home, and adding a second would be the actual defect.

### Implemented (option B)
- `src/utils/ranking.ts` — new. `Pulse`, `velocityOf`, `engagementOf`, `EMPTY_PULSE`,
  `loadPulse()`. The single definition of "hot".
- `FeedScreen.tsx` — now imports the scorer instead of keeping two private copies of
  the formula (it had `velocityOf` in `rankRows` AND written out inline in the pulse
  builder). Same numbers, one source.
- `DiscoverScreen.tsx` — chip renamed `For You` → `✨ Creators`, `DiscCat` value
  `'foryou'` → `'creators'`, default chip is `'creators'`. Three shelves, each
  hidden when empty: **Rising right now** (sum of `velocityOf` per creator),
  **Posting from {region}** (campus authors), **New on Gen Z** (newest profiles).
  Falls back to a sentence pointing at search, so the chip is never blank.

---

## 1. What the first draft got wrong

Draft 1 proposed putting urgency rails and a velocity-ranked For You on Discover.
Two false premises:

**Wrong premise A — "nothing does urgency yet."**
`FeedScreen` already ships an **Expiring** mode (L537-547): `expires_at >= now`
AND `expires_at <= now + 6h`, ordered `expires_at ASC`, limit 80 — the same 6-hour
window and the same least-time-first ordering I proposed. It even has sub-sections
in `EXP_SECTIONS` (L126-130): 🔥 Under 6 hours, 🚨 Under 1 hour, 💨 Almost gone,
plus a count badge on the rail.

**Wrong premise B — "there is no engagement history, so velocity must be inferred."**
There is a real rolling 30-minute window. `FeedScreen` L724-764 loads
`post_view_counts.viewed_at`, `like_counts.created_at` and `comment_counts.created_at`
for `now - 30m`, counts them per post, and derives `Pulse`:

```ts
export type Pulse = { views30; likes30; comments30; rising; trending };

velocityOf = views30 * 0.7 + likes30 * 2.2 + comments30 * 3.2
engagementOf = log1p(likes) * 1.1 + log1p(comments) * 1.6 + views * 0.03
```

Home's For You already ranks with decay + real velocity + dampened engagement +
a negative-feedback penalty (L364-371):

```ts
freshness = 2 * Math.exp(-ageH / 14);
score = freshness + velocityOf(pulse) + engagementOf(r) - dampen;   // dampen = 2.5 for not-interested tags
```

That is strictly better than the `(likes + 2*comments + 0.3*views) / (ageH+2)^1.5`
formula in draft 1, because it uses *deltas over 30 minutes* instead of inferring
velocity from lifetime totals. Draft 1 is withdrawn.

---

## 2. The real problem: two "For You"s and two definitions of "hot"

`FeedScreen` `MODES` (L136-141) already gives Home five modes:
**Following · For You · Live · Expiring · Around You**, with
`Live` sub-sections (🔥 Blowing Up, 👀 Everyone's Watching, 💬 Most Talked About,
⚡ Just Dropped, 🎯 Rising Creators) and `EXP_SECTIONS` for expiry.

Against that, Discover's four chips are near-total overlap:

| Discover chip | Ranked by | Already exists on Home as |
|---|---|---|
| For You (renders nothing) | — | For You (velocity + decay) |
| 🔥 Trending | raw `likes+comments+views` | Live → 🔥 Blowing Up (velocity) |
| ⚡ Just Dropped | `created_at` | Live → ⚡ Just Dropped |
| 🎓 Campus | `profile.region` | Around You → 📍 Region |

**And the two engines disagree.** Discover's shelves use *raw cumulative sums*
(L257-264); Home uses *30-minute velocity*. So Discover's "Trending" and Home's
"Blowing Up" will routinely show different posts for the same word. Two definitions
of "hot" in one app is worse than one mediocre one.

This is almost certainly why the screen feels confusing: it is a second, weaker
copy of a surface the user already has.

---

## 3. Recommendation

**Split the jobs. Home owns ranked content. Discover owns finding.**

1. **Home keeps For You / Expiring / Live / Around You.** Unchanged — it is the
   more advanced engine and it is already built.
2. **Discover becomes search-first.** No competing content-rank surface.
3. **Replace Discover's `For You` chip** with the one thing Home genuinely does not
   do: **people-level discovery.** Home ranks *posts*; it only surfaces accounts as
   a fallback when you follow nobody (`loadSuggestions`, L524). A permanent
   "who should I watch" surface is a real gap, not a duplicate.
4. **Reuse Home's scorer. Do not write a second one.** Export `velocityOf` /
   `rankRows` from `FeedScreen` and consume them. One definition of "hot", one place
   to tune it. A creator's score should be the sum of `velocityOf(pulse)` across
   their posts — the same maths Home already uses for its Rising Creators section
   (L349-358).
5. **Fix the blank page.** For You currently renders nothing because `show()` is
   exclusive and no `show('foryou')` block exists. Whichever direction is chosen,
   the default chip must never open an empty screen.

---

## 4. If a Discover "For You" is kept, its only defensible scope

A cross-surface digest of things Home cannot show in one place:
- top **rising creators** (creator-level velocity — computed, not stored)
- **people near your campus** who posted in the last 6h
- **one** hand-picked hero post, chosen with Home's own `rankRows`

Cap it at three blocks. Use `velocityOf` so it agrees with Home by construction.

---

## 5. Open decision for the owner

Pick one, then implementation is small and stays inside `DiscoverScreen.tsx`:

- **A. Drop the For You chip** — Discover = search + Trending + Just Dropped +
  Campus. Smallest change, removes the confusion, keeps one ranking engine.
- **B. Rename and repurpose it as people discovery** (recommended) — keeps four
  chips, fills a genuine gap, stays consistent with Home by sharing its scorer.
- **C. Keep a content For You but scope it to creators + campus only.**

Do not pick "a full second ranked feed" — that is option zero, and it is the bug.
