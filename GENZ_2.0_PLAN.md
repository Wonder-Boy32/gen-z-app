# GenZ 2.0 — architecture audit and sequenced roadmap

Written after a read-only audit of `src/` and `supabase/`. Every claim carries a
file reference so you can check it.

**The headline: 6 of the 10 requested areas already exist in some form.** The
biggest risk to this update is not missing features — it is rebuilding ones that
are already shipped and working, then wiring up a second version alongside the
first. The audit found **7 existing duplications** already, so adding a parallel
implementation would make that worse, not better.

---

## 1. Verdict per requested area

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Home "what's happening now" | **EXISTS** | `FeedScreen.tsx:1236-1239` renders the literal subtitle. Sections at `:115-121`: 🔥 Blowing Up, 👀 Everyone's Watching, 💬 Most Talked About, ⚡ Just Dropped, 🎯 Rising Creators. Velocity ranking at `:306`. |
| 2 | Drops as timed events | **EXISTS** | `public.drops` (`drops.sql:9-21`): `title, prompt, status scheduled\|live\|voting\|closed, starts_at, ends_at, voting_ends_at`, pg_cron lifecycle `:37-41`. Countdown, participants, join CTA and winners recap all in `DropExperienceScreen.tsx:129-141, 201-217`. |
| 3 | Campus communities | **PARTIAL** | No campus entity exists. "Campus" is derived from the free-text `profiles.region` (`DiscoverScreen.tsx:254-263`). Needs a real table. |
| 4 | Anonymous questions | **PARTIAL** | Full anon DM system exists (`anonymous_messages.sql:27-40`, send/inbox/reply/delete/report/block/post-as-drop). **"Ask me anything" does not exist** — grep for `ask me\|question\|askBox` returns nothing. |
| 5 | Mood / status | **MISSING** | No mood/status field or feature anywhere. Only false positives (a drop prompt, "Pick a vibe"). |
| 6 | People you might vibe with | **EXISTS ×4** | Four different surfaces: `FeedScreen.tsx:392-414` (newest-first), `SearchResults.tsx:108-141` (2-hop affinity, the best one), `PeopleScreen.tsx:33` (mutuals), `NewChatModal.tsx:32`. |
| 7 | Your week on GenZ | **PARTIAL** | Lifetime counters exist (`accountStats.ts:7-14`); 7-day viewers exist (`profile_views.sql:117-135`). **No weekly rollup of your own posts/interactions/new people.** |
| 8 | Product identity | **EXISTS** | The stated identity is already the design: 48h expiry, velocity sections, anonymous layer, region-based discovery. |
| 9 | Navigation | **EXISTS, 5 tabs** | `TabBar.tsx:7-15`: Home · Discover · Create · Chat · Me. Your proposed structure adds a **Drops** tab, which currently has no tab. |
| 10 | Performance / safety | **PARTIAL** | Moderation is comprehensive (`reports`, `blocks`, `muted_users`, `hidden_posts`, admin RPCs). But: feed has **no pagination** (hard cap 90) and **no cache**; `Around You` is region-string based with no location permission at all. |

---

## 2. What is actually missing

Only three things are genuinely new work:

1. **Mood / status** (#5) — small, self-contained, no duplication risk. **Built in this change.**
2. **Ask me anything** (#4) — a new public Q&A surface on top of the existing anon privacy layer.
3. **Campus communities** (#3) — a real campus entity, membership, and feeds. The largest single piece by far.

Two more are *consolidation*, not construction:

4. **"People you might vibe with"** (#6) — pick one ranking (the 2-hop affinity in
   `SearchResults.tsx:108-141` is the strongest) and delete or delegate the other three.
5. **Home section naming** (#1) — "Trending Now" / "Most Viewed" / "Just Posted" are
   concepts that exist under different labels. Renaming is a copy change, not a rebuild.

---

## 3. Fix these before adding anything

Pre-existing defects found during the audit. Adding 2.0 features on top of these
makes them harder to unpick later.

| Issue | Detail |
|---|---|
| ~~Broken counter~~ **RETRACTED** | **This entry was wrong.** Verified against the live database: `profiles` has **both** `lifetime_likes` (bigint) **and** `total_likes_received` (integer), and both are correctly maintained — they just measure different things. `bump_lifetime_likes()` (`lifetime_likes.sql:24`, despite its name) writes `total_likes_received` and is triggered on `likes` inserts/deletes: a running like total. `bank_likes_on_post_delete()` (`lifetime_likes_fix.sql:16-37`) writes `lifetime_likes` and is triggered when a **post** is deleted, so it counts likes that survived the 48h expiry. Live data shows `sum(total_likes_received)=6` vs `sum(lifetime_likes)=4` — the gap is simply likes sitting on posts that have not expired yet. **No bug.** The only real smell is the misleading function name. |
| **3 location columns** | `profiles.region` (`feed_advanced.sql:74`), `profiles.location` (`profile3.sql:9`), `profiles.location_region` (`admin_center.sql:26`). Different features read different ones. |
| **2 mute tables** | `muted_users` (`feed_advanced.sql:27-36`) and `muted_accounts` (`profile3.sql:37-49`). The feed only reads the first. |
| **2 trending engines** | `FeedScreen.tsx:707-713` (velocity top-5) vs `DiscoverScreen.tsx:235-242` (engagement sort). |
| **4 report tables** | `reports`, `anonymous_reports`, `chat_reports`, `support_reports`. |
| **Duplicated admin SQL** | `admin_center.sql` re-implemented in `_admin_part2.sql`, `_admin_part3.sql`, `admin_hotfix.sql`. |
| **No feed pagination** | Hard cap 90 (`FeedScreen.tsx:462`) with client rank cap 50 (`:140`), no cursor, no cache. At real scale this needs fixing before more is loaded into the feed. |

**Recommendation:** treat these as Phase 0. They are the reason features "work"
in testing and then behave oddly in production.

---

## 4. Sequenced roadmap

**Phase 0 — Foundations (no new UI)**
Resolve `lifetime_likes`, collapse the location columns to one, collapse the muting
tables to one, unify the two trending engines behind `rankRows`. Add feed pagination.
*Why first:* every later feature reads these, so fixing them after 2.0 means touching
every new screen too.

**Phase 1 — Identity polish (small, high impact)**
Rename home sections to your vocabulary (Trending Now / Most Viewed / Just Posted).
Add the **Drops tab** to the nav, reusing `DropExperienceScreen` as-is. Ship mood/status.
De-duplicate the four suggestion surfaces into one "People You Might Vibe With".
*Why second:* all high-visibility, low-risk, and reuses what exists.

**Phase 2 — New subsystems**
"Ask me anything" board (answer / delete / report / share as a card), built on the
existing anon privacy + moderation layer so safety is inherited, not rebuilt.
"Week on GenZ" recap (aggregate `accountStats` + `my_profile_view_stats` + a new
weekly rollup).

**Phase 3 — Campus communities (the big one)**
New `campuses` table, membership with manual selection (no location permission, as
you specified), campus feed scoped to members, campus drops, campus announcements
moderated through the existing admin console. This is the piece that makes GenZ
genuinely different for students — and it is the piece most likely to be built badly
if rushed, so it goes last and on top of a clean foundation.

---

## 5. What was implemented in this change

**Mood / status** (#5) — the one wholly missing item, and the smallest piece that
best expresses the stated identity (Temporary · Expressive · Less formal · Fun).

- New `public.profile_status` table. Owner-only writes; nobody can set or clear
  another user's mood.
- **Expiry enforced server-side.** A check constraint caps a status at 48 hours, so a
  crafted client cannot park a mood for months — it matches the app's existing 48h DNA.
- A `profile_status_live` view means expired moods never render, and a purge function
  keeps the table from accumulating dead rows.

Deliberately **not** built this turn: items 1, 2, 6, 9, because they already exist —
and campus, AMA and the recap because each is a subsystem that deserves its own pass
rather than a rushed slice alongside nine others.

---

## 6. Decisions I need from you

1. **Phase 0 or Phase 1 first?** My strong recommendation is Phase 0 — particularly
   the `lifetime_likes` bug, which may be showing wrong numbers to users today.
2. **The four suggestion surfaces** — merge into one, or keep them per-context?
3. **Campus scope** — every university, or a curated launch set (e.g. 10–20 Nigerian
   universities) with the rest added on request? A curated set is far easier to moderate.
