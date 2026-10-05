// ============================================================
// Gen Z -- push / device notifications
//
// WHY THIS FILE IS SHAPED THIS WAY:
// expo-notifications resolves its native modules when the module is EVALUATED,
// not when you call it. A plain top-level `import` therefore throws
// "Cannot find native module 'ExpoPushTokenManager'" on any binary built before
// package.json gained the dependency -- and that throw happens during bundle
// module loading, so it takes the entire app down with a red box before any
// try/catch inside a function can run.
//
// So the module is loaded lazily, inside a try/catch, the same way
// src/utils/clipboard.ts loads expo-clipboard. On an old binary everything here
// degrades to a no-op and the app boots normally.
//
// Nothing may touch the module at module scope. In particular the Android
// importance values are resolved per call rather than in a top-level constant.
// ============================================================

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type * as ExpoNotifications from 'expo-notifications';
import { supabase } from '../supabase/client';
import { NotifyType } from './notify';

type NotifModule = typeof ExpoNotifications;

export type PushPayload = {
  type: NotifyType;
  title: string;
  body: string;
  actor?: string | null;
  postId?: string | null;
  commentId?: string | null;
  notificationId?: string | null;
};

export type PushStatus = {
  available: boolean;
  token: string | null;
  reason?: string;
};

// ------------------------------------------------------------
// lazy module access
// ------------------------------------------------------------
let cached: NotifModule | null = null;
let probed = false;

/**
 * Load expo-notifications once, safely. Returns null when notifications simply
 * cannot work here: web, Expo Go, or a native build that predates the package.
 */
function notifications(): NotifModule | null {
  if (probed) return cached;
  probed = true;

  if (Platform.OS === 'web') {
    cached = null;
    return cached;
  }
  // Expo Go dropped remote push in SDK 53 and the module is absent on Android
  if (Constants?.executionEnvironment === 'storeClient') {
    cached = null;
    return cached;
  }

  try {
    const m = require('expo-notifications') as NotifModule;
    // how a notification behaves while the app is in the foreground:
    // still show it in the phone's bar, still make a sound
    m.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    cached = m;
  } catch {
    // APK predates expo-notifications -- everything below becomes a no-op
    cached = null;
  }
  return cached;
}

export function pushAvailable(): boolean {
  return notifications() !== null;
}

// ------------------------------------------------------------
// channels -- Android shows one row per channel in system settings,
// so each kind of activity gets its own sound/vibration/light signature
// ------------------------------------------------------------
type Importance = 'DEFAULT' | 'HIGH' | 'MAX';

type ChannelSpec = {
  id: string;
  name: string;
  importance: Importance;
  vibration: number[];
  light: string;
};

const CHANNELS: ChannelSpec[] = [
  {
    id: 'default',
    name: 'General',
    importance: 'HIGH',
    vibration: [0, 200, 120, 200],
    light: '#FF9D1F',
  },
  {
    id: 'likes',
    name: 'Likes and reactions',
    importance: 'DEFAULT',
    vibration: [0, 110],
    light: '#FF3B5C',
  },
  {
    id: 'comments',
    name: 'Comments and replies',
    importance: 'MAX',
    vibration: [0, 180, 110, 180],
    light: '#8B7BFF',
  },
  {
    id: 'follows',
    name: 'New followers',
    importance: 'DEFAULT',
    vibration: [0, 110],
    light: '#34D399',
  },
  {
    id: 'messages',
    name: 'Messages',
    importance: 'MAX',
    vibration: [0, 240, 140, 240],
    light: '#A8E6F2',
  },
];

const CHANNEL_FOR: Record<NotifyType, string> = {
  follow: 'follows',
  like: 'likes',
  comment: 'comments',
  reply: 'comments',
  reaction: 'likes',
  repost: 'follows',
  comment_like: 'likes',
  anon_message: 'messages',
  call: 'messages',
  // "post uploaded" is the user's own housekeeping, not someone else's action,
  // so it belongs on the general channel rather than in likes/comments.
  upload: 'default',
};

export function channelFor(type: NotifyType): string {
  return CHANNEL_FOR[type] ?? 'default';
}

// resolved per call so the enum is never read at module scope
function importanceOf(m: NotifModule, key: Importance) {
  if (key === 'MAX') return m.AndroidImportance.MAX;
  if (key === 'HIGH') return m.AndroidImportance.HIGH;
  return m.AndroidImportance.DEFAULT;
}

async function setupAndroidChannels(m: NotifModule) {
  if (Platform.OS !== 'android') return;
  for (const c of CHANNELS) {
    try {
      await m.setNotificationChannelAsync(c.id, {
        name: c.name,
        importance: importanceOf(m, c.importance),
        vibrationPattern: c.vibration,
        lightColor: c.light,
        enableVibrate: true,
        enableLights: true,
        showBadge: true,
        sound: 'default',
      });
    } catch {
      // one bad channel must not stop the others
    }
  }
}

// ------------------------------------------------------------
// registration
// ------------------------------------------------------------
function projectId(): string | null {
  try {
    const fromExtra = (Constants?.expoConfig as { extra?: { eas?: { projectId?: string } } } | null)?.extra
      ?.eas?.projectId;
    const fromEas = (Constants as { easConfig?: { projectId?: string } } | null)?.easConfig?.projectId;
    return fromExtra ?? fromEas ?? null;
  } catch {
    return null;
  }
}

function deviceLabel(): string {
  try {
    const name = (Constants as { deviceName?: string } | null)?.deviceName;
    return name && name.length ? name : Platform.OS === 'ios' ? 'iPhone' : 'Android device';
  } catch {
    return Platform.OS === 'ios' ? 'iPhone' : 'Android device';
  }
}

async function saveToken(token: string) {
  try {
    await supabase.rpc('register_push_token', {
      p_token: token,
      p_platform: Platform.OS,
      p_device: deviceLabel(),
      p_app_version: String((Constants?.expoConfig as { version?: string } | null)?.version ?? ''),
    });
  } catch {
    // the SQL may not be run yet -- never let this break app start
  }
}

/**
 * Ask for permission, wire up channels and register this device.
 * Safe to call on every app start and on every login.
 */
export async function initPush(): Promise<PushStatus> {
  const m = notifications();
  if (!m) {
    return {
      available: false,
      token: null,
      reason: Constants?.executionEnvironment === 'storeClient' ? 'expo-go' : 'native-module-missing',
    };
  }
  try {
    await setupAndroidChannels(m);

    let status = (await m.getPermissionsAsync()).status;
    if (status !== 'granted') {
      status = (await m.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { available: false, token: null, reason: 'denied' };

    const id = projectId();
    if (!id) return { available: false, token: null, reason: 'no-project-id' };

    const res = await m.getExpoPushTokenAsync({ projectId: id });
    const token = res?.data ?? null;
    if (token) await saveToken(token);
    return { available: true, token, reason: token ? undefined : 'no-token' };
  } catch {
    return { available: false, token: null, reason: 'error' };
  }
}

/** Drop this device's token so the next account on this phone gets nothing. */
export async function unregisterPush() {
  const m = notifications();
  if (!m) return;
  try {
    const id = projectId();
    if (!id) return;
    const res = await m.getExpoPushTokenAsync({ projectId: id });
    const token = res?.data;
    if (!token) return;
    await supabase.rpc('unregister_push_token', { p_token: token });
  } catch {
    // best effort
  }
}

// ------------------------------------------------------------
// presenting a notification
// ------------------------------------------------------------
function deepLink(p: PushPayload): string {
  if (p.postId) return `genz://post/${p.postId}`;
  if (p.type === 'follow' && p.actor) return `genz://profile/${p.actor}`;
  return 'genz://activity';
}

/**
 * Show a notification in the phone's bar while the app is open. This is what
 * makes an in-app arrival behave exactly like a real push.
 */
export async function showLocalNotification(p: PushPayload) {
  const m = notifications();
  if (!m) return;
  try {
    await m.scheduleNotificationAsync({
      content: {
        title: p.title,
        body: p.body,
        sound: 'default',
        data: {
          type: p.type,
          actor: p.actor ?? null,
          postId: p.postId ?? null,
          commentId: p.commentId ?? null,
          notificationId: p.notificationId ?? null,
          link: deepLink(p),
        },
        ...(Platform.OS === 'android' ? { channelId: channelFor(p.type) } : null),
      },
      trigger: null,
    });
  } catch {
    // presenting is best-effort
  }
}

// ------------------------------------------------------------
// taps
// ------------------------------------------------------------
type TapHandler = (p: PushPayload) => void;
const tapHandlers = new Set<TapHandler>();
let tapSub: { remove: () => void } | null = null;

/** Subscribe to notification taps. Returns an unsubscribe function. */
export function onNotificationTap(fn: TapHandler): () => void {
  tapHandlers.add(fn);

  const m = notifications();
  if (!m) return () => tapHandlers.delete(fn);

  try {
    if (!tapSub) {
      tapSub = m.addNotificationResponseReceivedListener((response) => {
        const data = (response?.notification?.request?.content?.data ?? {}) as Partial<PushPayload>;
        void clearBadge();
        const payload: PushPayload = {
          type: (data.type ?? 'like') as NotifyType,
          title: '',
          body: '',
          actor: data.actor ?? null,
          postId: data.postId ?? null,
          commentId: data.commentId ?? null,
          notificationId: data.notificationId ?? null,
        };
        tapHandlers.forEach((h) => {
          try {
            h(payload);
          } catch {
            // a broken handler must not stop the others
          }
        });
      });
    }
  } catch {
    // no native module -- taps simply do nothing
  }

  return () => {
    tapHandlers.delete(fn);
  };
}

// ------------------------------------------------------------
// app icon badge
// ------------------------------------------------------------
export async function setBadge(count: number) {
  const m = notifications();
  if (!m) return;
  try {
    await m.setBadgeCountAsync(Math.max(0, count));
  } catch {
    // unsupported on some launchers
  }
}

export async function clearBadge() {
  await setBadge(0);
}

/** Dismiss every notification this app posted (used when Activity is opened). */
export async function dismissAll() {
  const m = notifications();
  if (!m) return;
  try {
    await m.dismissAllNotificationsAsync();
  } catch {
    // ignore
  }
}
