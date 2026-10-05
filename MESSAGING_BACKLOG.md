# MESSAGING PARADISE — REMAINING WORK

Companion to `MESSAGING_COVERAGE_AUDIT.md`. That file says what is missing; this one says
what each missing item *costs* and in what order it can actually be built.

**"All" is not one turn.** It is roughly 30 features, and three groups of them are blocked on
things that are not code: new native modules, a server-side search index, and paid real-time
media infrastructure. Pretending otherwise would just produce 30 half-features.

---

## PASS 1 — DONE (this session)

| Feature | How | Notes |
|---|---|---|
| **Themes + wallpaper + accent** | Wired `ChatSettingsSheet` (861 lines, existed unused) | Now actually reachable — was the biggest visible gap |
| **Conversation search** | Same sheet — it already had a `'search'` sub-view | Searches loaded history; see PASS 2 for full-history |
| **Mute / unmute** | Same sheet → `conversation_participants.muted` | |
| **Disappearing messages timer** | Same sheet → `conversations.disappear_seconds` | Column existed, unused |
| **Nickname per chat** | Same sheet | |
| **Block / report** | Same sheet → `onBlocked` → leaves thread | |
| **GIF send** | Wired `GifPicker` (existed unused) → `gif` kind | Needs `EXPO_PUBLIC_GIPHY_API_KEY` |
| **Edit message** | New menu item → engine `edit()` | Engine already supported it; was unreachable |
| **Tap quote → jump to original** | New `MessageListHandle.scrollToMessage` | Honest failure when outside loaded page |
| **Media send modes** | Normal / View once / 24 hours, with a persistent banner | §10. `expires_at` + `view_once` now written |
| **Contact + File + Poll tiles** | Visible in the sheet | Still stubs — they say so rather than pretend |

`tsc --noEmit`: zero errors. **Not runtime-tested** — no device here.

---

## PASS 2 — Client-only, no new dependencies

Nothing here needs an npm install or a server change. Cheapest remaining work.

| # | Feature | § | What it needs |
|---|---|---|---|
| 1 | Forward a message | 4 | A conversation-picker modal reusing `NewChatModal`; engine `send` with `forwardedFrom` |
| 2 | Pin / unpin | 4 | Columns exist (`pinned_at`, `pinned_by`); needs a menu item + a pinned strip in the header |
| 3 | Save to My Saves | 18 | `saved_messages` table exists; menu item + a Saves screen |
| 4 | Mark unread | 4 | `last_read_seq` set back one; needs a confirm |
| 5 | Multi-select + share | 4 | Selection mode in `MessageList`, bulk copy/forward/delete |
| 6 | Reaction animation + double-tap ❤️ | 5 | Animated scale on the chip; double-tap detector on the bubble |
| 7 | Message effects (❤️ 🎉 🔥 ✨) | 14 | Overlay layer + a setting to disable |
| 8 | Group management | 27 | Roles/admins/invite links, mute, member list. `role` column exists |
| 9 | Group topics | 28 | `conversation_topics` exists; topic chips + filtered timeline |
| 10 | Polls: create + vote + live results | 29 | `polls` + `poll_votes` exist; `poll_results` RPC needed for anonymous |
| 11 | Message request gate | 32 | `conversation_requests` exists. Needs RLS enforcement + a Requests screen |
| 12 | Privacy centre | 35 | `messaging_privacy` exists; a settings screen + reads in presence/receipt paths |
| 13 | Report flow | 34 | `chat_reports` exists; a reason picker |
| 14 | Notification privacy modes | 41 | Preview/hide/sender-only; must be enforced **server-side** or it leaks to the lock screen |
| 15 | Wire push to the engine | 40 | Push infra exists (deployed 09-12) but is not connected to message inserts |
| 16 | Shared Space screen | 16 | 8 sections; `attachments_shared_space_idx` exists |
| 17 | Multi-device drafts | 37 | `message_drafts` exists; save on blur, restore on open |
| 18 | Exact seen/delivered | 4 | `last_read_seq` + `last_delivered_seq` replace the timestamp derivation |
| 19 | Voice: speed 1×/1.5×/2×, draggable scrub | 7 | `player.playbackRate`; PanResponder on the progress bar |
| 20 | Presence: recording / sending file | 25,26 | Emit the 3 unused `TypingSignal` kinds |

## PASS 3 — Needs new npm packages

Each of these is a real dependency decision, not just code.

| # | Feature | § | Package |
|---|---|---|---|
| 21 | Camera capture (photo/video, flash, timer, flip) | 9 | `expo-camera` |
| 22 | Media editor: crop, rotate, resize, filters | 9 | `expo-image-manipulator` |
| 23 | Media editor: draw, text, stickers, blur | 9 | `react-native-svg` (+ `expo-image-manipulator`) |
| 24 | Thumbnails + blurhash → list performance | 42 | `expo-image-manipulator` |
| 25 | Live location, current location | 21 | `expo-location` |
| 26 | File sharing (PDF, zip, docs) | 19 | `expo-document-picker` |
| 27 | Resumable uploads + real progress | 19,39 | `tus-js-client` (verify Supabase Storage supports tus on your plan first) |
| 28 | Biometric app lock | 36 | `expo-local-authentication` |
| 29 | Voice transcription | 7 | A speech-to-text service (paid) — not an on-device Expo module |
| 30 | Stickers (packs, favourites, create from photo) | 12 | Asset pipeline + `expo-image-manipulator` for creation |

## PASS 4 — Needs SQL + server work

| # | Feature | § | What it needs |
|---|---|---|---|
| 31 | Full-history search | 17 | Generated `tsvector` column + GIN index + a search RPC with filters (people/dates/media) |
| 32 | `messaging_send` RPC | 43 | Atomic message + attachments so media metadata lands in one transaction |
| 33 | Attachments pipeline | 43 | Migrate off `media_url` public URLs → `message_attachments` + signed URLs + private buckets (buckets and table already exist) |
| 34 | Link previews | 20 | Server-side fetch + cache (`link_previews` exists). Must be an edge function — a client fetch leaks the user's IP to every linked site |
| 35 | Expiry sweeper | 38 | `pg_cron` + the existing `media_cleanup_queue`. A client timer deletes nothing when the app is closed |
| 36 | Rate limiting / anti-spam | 34 | Server-side counter before the app is public |
| 37 | `messaging_unread_counts()` | 42 | One indexed aggregate instead of N count queries |
| 38 | **PART 2 hardening** | 36 | `messaging_v2_hardening.sql` — fixes the group-member-can-edit-anyone's-message hole. Blocked on the client no longer writing reaction/view-once state onto the message row |

## PASS 5 — Needs paid infrastructure

| # | Feature | § | Blocker |
|---|---|---|---|
| 39 | 1:1 voice calls | 23 | Signalling is doable on Supabase Realtime; `CallScreen` + `calls` table already exist. Medium effort, no vendor |
| 40 | 1:1 video calls | 24 | Same signalling + WebRTC mesh. Feasible |
| 41 | **Group voice / video** | 23,24 | **Needs an SFU** (LiveKit / Daily / Agora). Mesh upload is O(n) per participant and dies at ~4 people. This has a per-minute cost — it is the first genuinely expensive line item |
| 42 | 2FA / passkeys | 36 | TOTP is available; passkeys need a WebAuthn server and a domain |
| 43 | True E2EE | 36 | Months, plus an audit, and it would break search, previews, translation and server moderation. See architecture §10.2 |

---

## Ordered recommendation

**Pass 2 in full** — 20 features, all reachable, no new dependencies, no new infrastructure.
That is the single largest jump toward your §59 test: a user could then search, pin, save,
forward, poll, see requests, and manage privacy.

Then **Pass 4 items 31, 32, 33** — search and the attachment pipeline — because Pass 3's
camera and editor are useless without somewhere proper to put the files.

Then **Pass 3**, then **Pass 5**.

## Two hard truths

1. **The quota problem is upstream of all of this.** Your Supabase organisation was flagged
   as over quota with projects restricted from **01 Oct 2026**. Every migration and every
   byte of media lands there. Fix billing before Pass 3.
2. **§59 will still fail after Pass 2.** "An entire relationship without another app" requires
   calls (Pass 5) and file sharing (Pass 3). Pass 2 gets you to roughly 70%; it does not get
   you to done.
