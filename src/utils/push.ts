// ============================================================
// Gen Z -- push / device notifications
//
// Everything here is defensive on purpose. expo-notifications was added to
// package.json now, which means a JS update can land on an APK that was built
// BEFORE the package existed. In that case the native module is missing and
// every call throws -- so each entry point is guarded and simply reports
// "notifications unavailable" instead of taking the app down.
// ============================================================

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { supabase } from '../supabase/client';
import { NotifyType } from './notify';

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
// channels -- Android shows one row per channel in system settings,
// so each kind of activity gets its own sound/vibration/light signature
// ------------------------------------------------------------
type ChannelSpec = {
  name: string;
  importance: Notifications.AndroidImportance;
  vibration: number[];
  light: string;
};

const CHANNELS: Record<string, ChannelSpec> = {
  default: {
    name: 'General',
    importance: Notifications.AndroidImportance.HIGH,
    vibration: [0, 200, 120, 200],
    light: '#FF9D1F',
  },
  likes: {
    name: 'Likes and reactions',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibration: [0, 110],
    light: '#FF3B5C',
  },
  comments: {
    name: 'Comments and replies',
    importance: Notifications.AndroidImportance.MAX,
    vibration: [0, 180, 110, 180],
    light: '#8B7BFF',
  },
  follows: {
    name: 'New followers',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibration: [0, 110],
    light: '#34D399',
  },
  messages: {
    name: 'Messages',
    importance: Notifications.AndroidImportance.MAX,
    vibration: [0, 240, 140, 240],
    light: '#A8E6F2',
  },
};

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
};

export function channelFor(type: NotifyType): string {
  return CHANNEL_FOR[type] ?? 'default';
}

// ------------------------------------------------------------
// native capability probe (runs once)
// ------------------------------------------------------------
let probed: boolean | null = null;

function nativeReady(): boolean {
  if (probed !== null) return probed;
  if (Platform.OS === 'web') {
    probed = false;
    return probed;
  }
  // Expo Go dropped remote push in SDK 53 and the module is absent on Android,
  // so never touch it there.
  if (Constants?.executionEnvironment === 'storeClient') {
    probed = false;
    return probed;
  }
  try {
    // how a notification behaves while the app is in the foreground:
    // still show it in the phone's notification bar, still make a sound
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    probed = true;
  } catch {
    // APK predates expo-notifications -- everything below degrades to no-ops
    probed = false;
  }
  return probed;
}

// configure the handler as early as possible so a foreground arrival is
// presented properly even before initPush() runs
try {
  nativeReady();
} catch {
  // ignore
}

export function pushAvailable(): boolean {
  return nativeReady();
}

async function setupAndroidChannels() {
  if (Platform.OS !== 'android') return;
  for (const id of Object.keys(CHANNELS)) {
    const spec = CHANNELS[id];
    try {
      await Notifications.setNotificationChannelAsync(id, {
        name: spec.name,
        importance: spec.importance,
        vibrationPattern: spec.vibration,
        lightColor: spec.light,
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
    const fromExtra = (Constants?.expoConfig as { extra?: { eas?: { projectId?: string } } } | null)?.extra?.eas
      ?.projectId;
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
  if (!nativeReady()) {
    return {
      available: false,
      token: null,
      reason: Constants?.executionEnvironment === 'storeClient' ? 'expo-go' : 'native-module-missing',
    };
  }
  try {
    await setupAndroidChannels();

    let status = (await Notifications.getPermissionsAsync()).status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { available: false, token: null, reason: 'denied' };

    const id = projectId();
    if (!id) return { available: false, token: null, reason: 'no-project-id' };

    const res = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const token = res?.data ?? null;
    if (token) await saveToken(token);
    return { available: true, token, reason: token ? undefined : 'no-token' };
  } catch {
    return { available: false, token: null, reason: 'error' };
  }
}

/** Drop this device's token so the next account on this phone gets nothing. */
export async function unregisterPush() {
  try {
    const id = projectId();
    if (!nativeReady() || !id) return;
    const res = await Notifications.getExpoPushTokenAsync({ projectId: id });
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
  if (!nativeReady()) return;
  try {
    await Notifications.scheduleNotificationAsync({
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
  if (!nativeReady()) return () => tapHandlers.delete(fn);

  try {
    if (!tapSub) {
      tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
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
  if (!nativeReady()) return;
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {
    // unsupported on some launchers
  }
}

export async function clearBadge() {
  await setBadge(0);
}

/** Dismiss every notification this app posted (used when Activity is opened). */
export async function dismissAll() {
  if (!nativeReady()) return;
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {
    // ignore
  }
}
