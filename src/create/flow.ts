// ============================================================
// src/create/flow.ts
// ============================================================
// The whole create flow, as data.
//
// This file exists because the flow used to be impossible to read. Entry was a
// tab, the tab mounted a 4,000-line component that was itself a four-step
// wizard, and "back" was decided inside that wizard by looking at a `step`
// value while the tab host separately decided what the tab meant. Two owners of
// one question, so they disagreed — that is how "I'm in the caption and I can't
// go back" happened.
//
// Now there are three pages and one table. If you want to know where the user
// is or where "back" takes them, read the eleven lines below. Nothing else in
// this folder decides it.
//
//   +  ──▶  camera ──▶ compose
//             │  ▲        │
//             ▼  └────────┘
//           text
//
// The camera is the entry and the root. The launcher sheet sits over it. Every
// other page leads back to it, which is why "back" never needs to know history.

import type { IconName } from '../components/ui/Icon';

/** The pages. Three, because there are three things you can actually do. */
export type CreatePage = 'camera' | 'text' | 'compose';

/** What the launcher offers. `live` is not a page — it leaves the flow. */
export type LauncherChoice = 'post' | 'live' | 'drop' | 'resume';

/**
 * BACK, IN FULL.
 *
 * `null` means "there is nothing behind this page, so leaving the flow" — the
 * camera is the root by design. Every arrow, the Android back button and the ✕
 * all read this one table, so they cannot drift apart.
 */
export const BACK_FROM: Record<CreatePage, CreatePage | null> = {
  camera: null,
  text: 'camera',
  compose: 'camera',
};

export type LauncherItem = {
  choice: LauncherChoice;
  title: string;
  sub: string;
  icon: IconName;
};

/**
 * The draft row, shown above the three only when a draft exists.
 *
 * It has to live here: taking the hub away also took away the only visible way
 * back into saved work, and a draft you cannot find is a draft you have lost.
 */
export const RESUME: LauncherItem = {
  choice: 'resume',
  title: 'Continue your draft',
  sub: 'Pick up where you left off',
  icon: 'play-circle-outline',
};

/**
 * The three rows in the sheet. Ordered by what people actually came to the +
 * button to do: post something, see something, or write something. "Live" is
 * deliberately second and deliberately not called "Feed" — the row's job is to
 * give someone who opened the camera by reflex a way out without feeling like
 * they pressed the wrong thing.
 */
export const LAUNCHER: LauncherItem[] = [
  {
    choice: 'post',
    title: 'Post on GenZ',
    sub: 'Record or upload a photo or video',
    icon: 'videocam-outline',
  },
  {
    choice: 'live',
    title: "See what's happening now",
    sub: 'Back to the live feed',
    icon: 'flame-outline',
  },
  {
    choice: 'drop',
    title: 'Create a Drop',
    sub: 'Turn a thought into an image',
    icon: 'text-outline',
  },
];
