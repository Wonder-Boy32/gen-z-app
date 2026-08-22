# Gen Z — Project Brief (v1)

> Status: **concept locked, not started**. Name TBD (see Open decisions).
> Stack: Expo (React Native) + Supabase — fits the SERN preference.

## Concept (one line)

A TikTok-style social app where every post is a story that auto-deletes after **48 hours** — a public feed of "what everyone is posting right now," plus private chat.

## Core loop

1. User opens app → fullscreen vertical video feed (For You style), mixed stories from **every user**
2. Scroll, like, comment, share, follow
3. Post your own story (video/photo) → it's live to everyone
4. **48h later it's gone** — posts, likes, and comments all cascade-delete
5. Chat with anyone privately, separate from the feed

## Features

### Feed (public — TikTok features)
- Fullscreen vertical video scrolling (TikTok-style UX)
- Likes, comments + replies, shares, follows
- Feed shows every user's stories, mixed (confirmed by owner)
- Feed logic v1: recency + engagement in the last 48h — no ML
- Story views (who watched)

### Ephemeral mechanic (the differentiator)
- Every post expires 48h after creation (cron/scheduled job deletes post + cascades likes/comments/media)
- Expired content never resurrects
- Marketing angle: "TikTok that forgets" — always fresh, nothing sticks

### Chat (private)
- Realtime DMs (Supabase Realtime)
- Reactions, voice notes, disappearing messages (align with the 48h vibe)
- Streaks (retention driver): chat daily to keep a streak alive

### Auth
- v1: email + password (Facebook-style easy signup — minimal fields)
- Later: one-tap Google/Apple OAuth

### Moderation (mandatory for store approval — public feed)
- Report + block
- Basic content filters
- Admin moderation console (Supabase-backed)

### Growth features (v2+)
- Snapcode-style QR to add friends
- Discover/trending tab
- Push notifications (messages, close-friend posts, streak warnings)

## Data model sketch (Supabase)

- `profiles` — user profile, avatar, username, streak counter
- `posts` — story/video posts, `expires_at = created_at + 48h`
- `likes` — user_id + post_id (cascade on post delete)
- `comments` — post_id, user_id, parent_id (for replies)
- `follows` — follower_id + following_id
- `conversations` / `messages` — private chat (realtime)
- `reports` — moderation queue
- `friend_links` (v2) — QR add

## Roadmap

| Phase | What | Notes |
|---|---|---|
| 0 | Lock idea | ✅ done |
| 1 | Supabase data model + migrations + 48h expiry job | free |
| 2 | Auth (email/password) | free |
| 3 | Video feed (scroll, like, comment, follow) | core build |
| 4 | Chat (realtime DMs, reactions) | core build |
| 5 | Test on Android via Expo Go | free, daily testing |
| 6 | Moderation basics + polish | required for stores |
| 7 | Build APK → Play Store | $25 one-time |

iOS later via EAS cloud build (needs Apple Developer account, $99/yr).

## Open decisions

- **Name**: "Gen Z" is taken on both stores (Gen-Z Social: Chat & Meet on Play, Gen Z Bible on iOS). Variants: GenZ, GenZ+word. Owner deciding.
- Monetization (later): ads, boosts for creators
- Whether feed includes non-followed strangers only via engagement or fully random mix

## Build order on approval

1. Create task board (phases 1–7)
2. Scaffold Expo app + Supabase project
3. Phase 1 data model → then phase by phase, testing on Android via Expo Go
