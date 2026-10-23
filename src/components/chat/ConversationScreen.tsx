// ============================================================
// ConversationScreen — the conversation surface.
//
// Wired to the Conversation Engine. Additive: a drop-in for
// screens/ChatThread.tsx behind the same props, so the old screen
// stays intact and is one import-line away.
//
// This screen owns presentation + conversation META (participants,
// theme, presence, settings). It owns no message logic — that is
// the engine's job.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VideoView, useVideoPlayer } from 'expo-video';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { supabase } from '../../supabase/client';
import { colors, radius, spacing, type } from '../../theme';
import Icon from '../ui/Icon';
import Avatar from '../Avatar';
import VerifiedBadge from '../ui/VerifiedBadge';
import GifPicker from '../GifPicker';
import SharedSpaceScreen from './SharedSpaceScreen';
import ForwardPicker from './ForwardPicker';
import ReportSheet from './ReportSheet';
import CallScreen from './CallScreen';
import type { CallRow } from './CallHistoryRow';
import { useCalls, CALLING_ENABLED } from './useCalls';
import PollComposer, { type PollDraft } from './PollComposer';
// TYPE-ONLY imports: erased at compile time, so they cannot trigger a runtime
// require of a native module that may be missing from this build.
import type { LocationPayload } from './LocationPicker';
import type { CapturedAsset } from '../../screens/CameraScreen';
// Safe import — uses only expo-image-picker, which is already in this build.
import GroupInfoScreen from '../../screens/GroupInfoScreen';
// Camera / editor / location / file-picker are resolved LAZILY below, because
// a module-scope import of a missing native module kills the whole app.
import {
  cameraModule,
  documentPicker,
  imageManipulator,
  locationModule,
  optionalComponentById,
} from '../../utils/optionalNative';
import ChatSettingsSheet, {
  type ChatSettingsData,
  type SearchableMessage,
} from './ChatSettingsSheet';
import { TOP_INSET } from '../../utils/useInsets';
import { uploadPrivateMedia } from '../../utils/upload';
import {
  WALLPAPERS,
  customWallpaperUri,
  isCustomWallpaper,
  resolveChatPalette,
  type WallpaperDef,
} from '../../utils/chatTheme';
import {
  consumeViewOnce,
  recordView,
  fetchMyViews,
  useConversation,
  type Message,
  type MessageBody,
  type SendOptions,
} from '../../messaging';
import MessageList, { type BubblePalette, type MessageListHandle } from './MessageList';
import Composer from './Composer';
import { REACTION_BAR, ensureReadable } from './chatVisuals';
import { friendlyError } from '../../utils/friendlyError';
import { screenTextError } from '../../utils/contentFilter';

export interface ConversationScreenProps {
  conversationId: string;
  onBack: () => void;
}

interface ParticipantRow {
  user_id: string;
  last_read_at: string | null;
  muted: boolean | null;
  muted_until: string | null;
  sound_enabled: boolean | null;
  nickname: string | null;
  chat_color: string | null;
  wallpaper: string | null;
  profile: {
    username: string | null;
    avatar_url: string | null;
    verified?: boolean;
    last_seen_at: string | null;
  } | null;
}

interface ConvRow {
  type: string;
  name: string | null;
  avatar_url: string | null;
  disappear_seconds: number | null;
}

/** §10 media send modes. "Keep" needs Shared Space, so it is not offered yet. */
type SendMode = 'normal' | 'viewOnce' | 'temp24h';

const SEND_MODES: { key: SendMode; label: string; hint: string; icon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { key: 'normal', label: 'Normal', hint: 'Stays in the conversation', icon: 'chatbubble-outline' },
  { key: 'viewOnce', label: 'View once', hint: 'Opens a single time', icon: 'eye-outline' },
  { key: 'temp24h', label: '24 hours', hint: 'Disappears after a day', icon: 'time-outline' },
];

const TEMP_MS = 24 * 60 * 60 * 1000;

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function contentOf(m: Message): string | null {
  return m.body.type === 'text' ? m.body.text : null;
}

export default function ConversationScreen({ conversationId, onBack }: ConversationScreenProps) {
  const {
    state,
    typing,
    sendText,
    send,
    retry,
    react,
    edit,
    remove,
    pin,
    pinned,
    markUnread,
    forward,
    createPoll,
    emitPresence,
    onCallSignal,
    sendCall,
    loadOlder,
    setTyping,
  } = useConversation(conversationId);

  const [participants, setParticipants] = useState<ParticipantRow[]>([]);
  const [conv, setConv] = useState<ConvRow | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [meId, setMeId] = useState<string | null>(null);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [forwardFor, setForwardFor] = useState<Message | null>(null);
  const [reportFor, setReportFor] = useState<Message | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  /** Media waiting in the editor before it is uploaded and sent. */
  const [pendingAsset, setPendingAsset] = useState<{
    uri: string;
    type: 'photo' | 'video';
  } | null>(null);
  const [viewer, setViewer] = useState<Message | null>(null);
  // View-once ids this user has already opened. Seeded from `message_views`
  // and updated the instant a moment is opened.
  const [viewedOnce, setViewedOnce] = useState<Set<string>>(new Set());
  const [editFor, setEditFor] = useState<Message | null>(null);
  const [editText, setEditText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>('normal');

  const listRef = useRef<MessageListHandle>(null);

  /**
   * Optional-native components, resolved once. A null here means the module is
   * absent from this build, so the matching tile is disabled with an honest
   * message instead of the app failing to boot.
   */
  const CameraScreenLazy = useMemo(
    () =>
      optionalComponentById<{
        onClose: () => void;
        onCapture: (a: CapturedAsset) => void;
        intent?: 'message' | 'moment';
      }>('camera', cameraModule),
    []
  );
  const MediaEditorLazy = useMemo(
    () =>
      optionalComponentById<{
        uri: string;
        mediaType: 'photo' | 'video';
        onCancel: () => void;
        onDone: (uri: string, caption: string | null) => void;
      }>('editor', imageManipulator),
    []
  );
  const LocationPickerLazy = useMemo(
    () =>
      optionalComponentById<{
        visible: boolean;
        onClose: () => void;
        onSend: (p: LocationPayload) => void;
      }>('location', locationModule),
    []
  );

  const cameraAvailable = cameraModule.available;
  // Gate on the COMPONENT, not only the native probe.
  //
  // `optionalComponentById` returns null when MediaEditorScreen fails to load
  // even though the native module resolved, and the two were checked
  // separately. When they disagreed: the Modal opened because
  // `visible={!!pendingAsset}`, but its body rendered nothing because
  // `MediaEditorLazy` was null — a blank full-screen modal — and the auto-send
  // fallback below was skipped because the probe reported "available". The
  // picked asset was trapped there and silently never sent, which is why no
  // media message ever reached the database.
  //
  // Requiring the component to exist makes both gates agree: if the editor
  // cannot render, the modal never opens and the asset is sent directly.
  const editorAvailable = imageManipulator.available && !!MediaEditorLazy;
  const locationAvailable = locationModule.available;
  const fileAvailable = documentPicker.available;

  // ---- identity + conversation meta -------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id ?? null;
      if (cancelled || !uid) return;

      setMeId(uid);

      const [convRes, partRes] = await Promise.all([
        supabase
          .from('conversations')
          .select('type, name, avatar_url, disappear_seconds')
          .eq('id', conversationId)
          .maybeSingle(),
        supabase
          .from('conversation_participants')
          .select(
            'user_id, last_read_at, muted, muted_until, sound_enabled, nickname, chat_color, wallpaper, ' +
              'profile:profiles(username, avatar_url, verified, last_seen_at)'
          )
          .eq('conversation_id', conversationId),
      ]);

      if (cancelled) return;
      setConv((convRes.data ?? null) as ConvRow | null);
      setParticipants((partRes.data ?? []) as unknown as ParticipantRow[]);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // participants' read state must stay live while the thread is open
  useEffect(() => {
    const channel = supabase
      .channel(`meta:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversation_participants',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new;
          if (!row || typeof row.user_id !== 'string') return;
          setParticipants((prev) =>
            prev.map((p) =>
              p.user_id === row.user_id
                ? {
                    ...p,
                    last_read_at: (row.last_read_at as string | null) ?? p.last_read_at,
                    muted: (row.muted as boolean | null) ?? p.muted,
                    muted_until: (row.muted_until as string | null) ?? p.muted_until,
                    nickname: (row.nickname as string | null) ?? p.nickname,
                    chat_color: (row.chat_color as string | null) ?? p.chat_color,
                    wallpaper: (row.wallpaper as string | null) ?? p.wallpaper,
                  }
                : p
            )
          );
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const others = useMemo(
    () => participants.filter((p) => p.user_id !== meId),
    [participants, meId]
  );
  const isGroup = conv?.type === 'group' || others.length > 1;

  const other = others[0];
  const myParticipant = useMemo(
    () => participants.find((p) => p.user_id === meId) ?? null,
    [participants, meId]
  );

  const title = conv?.name ?? other?.nickname ?? other?.profile?.username ?? 'Conversation';

  // ---- calls ------------------------------------------------------
  //
  // Offered for 1:1 only. The `calls` table is one caller to one callee, so in
  // a group this would ring an arbitrary member — worse than not offering it.
  //
  // Signalling rides the engine's existing private channel (see useCalls for
  // why a dedicated channel would not authorise).
  const peerId = !isGroup ? other?.user_id ?? null : null;
  const callPeerAvatar = conv?.avatar_url ?? other?.profile?.avatar_url ?? null;

  const { call, canCall, startCall, acceptCall, declineCall, endCall, handleSignal } = useCalls({
    conversationId,
    meId,
    peerId,
    enabled: !!conversationId,
    send: sendCall,
  });

  // onCallSignal returns its own unsubscribe, so the effect can hand it
  // straight back as cleanup.
  useEffect(() => onCallSignal(handleSignal), [onCallSignal, handleSignal]);

  // ---- call history ------------------------------------------------
  const loadCalls = useCallback(async () => {
    const { data } = await supabase
      .from('calls')
      .select('id, kind, status, caller_id, callee_id, started_at, ended_at, duration')
      .eq('conversation_id', conversationId)
      .order('started_at', { ascending: true })
      .limit(200);
    setCalls((data ?? []) as CallRow[]);
  }, [conversationId]);

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  // The `calls` table is deliberately NOT in the realtime publication (adding
  // it would mean REPLICA IDENTITY FULL on a table that is written on every
  // ring), so nothing pushes a new row to us. Refetching when a call finishes
  // is enough: that is the only moment this screen's own history can change.
  const hadCallRef = useRef(false);
  useEffect(() => {
    if (call) {
      hadCallRef.current = true;
      return;
    }
    if (hadCallRef.current) {
      hadCallRef.current = false;
      void loadCalls();
    }
  }, [call, loadCalls]);

  const peerReadAt = useMemo(() => {
    const stamps = others
      .map((p) => (p.last_read_at ? new Date(p.last_read_at).getTime() : 0))
      .filter((n) => n > 0);
    return stamps.length ? Math.max(...stamps) : 0;
  }, [others]);

  /** Seen is derived, never guessed (see architecture doc §4.3). */
  const seenFor = useCallback(
    (message: Message) => {
      if (!peerReadAt) return false;
      return peerReadAt >= new Date(message.createdAt).getTime();
    },
    [peerReadAt]
  );

  const nameFor = useCallback(
    (senderId: string) => {
      const p = participants.find((x) => x.user_id === senderId);
      return p?.nickname ?? p?.profile?.username ?? undefined;
    },
    [participants]
  );

  const typingNames = useMemo(
    () => typing.map((t) => nameFor(t.userId) ?? 'Someone'),
    [typing, nameFor]
  );

  // ---- theme ------------------------------------------------------
  // Prefer the viewer's own row (this is how *I* see this chat), falling back
  // to the other participant so existing conversations keep their appearance.
  const themeSource = myParticipant ?? other ?? null;

  const palette = useMemo(
    () => resolveChatPalette(themeSource?.chat_color ?? null),
    [themeSource?.chat_color]
  );

  const bubblePalette: BubblePalette = useMemo(
    () => ({
      myBg: palette.myBg,
      myText: ensureReadable(palette.myText, palette.myBg),
      myTime: palette.myTime,
      theirBg: palette.theirBg,
      theirText: colors.text,
    }),
    [palette]
  );

  const wallpaperKey = themeSource?.wallpaper ?? 'glow';
  const wallpaper: WallpaperDef | null =
    wallpaperKey && !isCustomWallpaper(wallpaperKey)
      ? (WALLPAPERS.find((w) => w.key === wallpaperKey) ?? WALLPAPERS[0])
      : null;

  // ---- settings (drives ChatSettingsSheet) ------------------------
  const settings: ChatSettingsData | null = useMemo(() => {
    if (!myParticipant) return null;
    return {
      muted: !!myParticipant.muted,
      mutedUntil: myParticipant.muted_until ?? null,
      nickname: myParticipant.nickname ?? null,
      chatColor: myParticipant.chat_color ?? 'orange',
      wallpaper: myParticipant.wallpaper ?? 'glow',
      disappearSeconds: conv?.disappear_seconds ?? null,
      soundEnabled: myParticipant.sound_enabled ?? true,
    };
  }, [myParticipant, conv?.disappear_seconds]);

  /**
   * The sheet is presentational; persistence lives here. Participant-scoped
   * settings go on my row, conversation-scoped settings on the conversation.
   */
  const handleSettingsChange = useCallback(
    (patch: Partial<ChatSettingsData>) => {
      setParticipants((prev) =>
        prev.map((p) =>
          p.user_id === meId
            ? {
                ...p,
                muted: patch.muted ?? p.muted,
                muted_until: patch.mutedUntil !== undefined ? patch.mutedUntil : p.muted_until,
                nickname: patch.nickname !== undefined ? patch.nickname : p.nickname,
                chat_color: patch.chatColor ?? p.chat_color,
                wallpaper: patch.wallpaper ?? p.wallpaper,
                sound_enabled: patch.soundEnabled ?? p.sound_enabled,
              }
            : p
        )
      );

      if (patch.disappearSeconds !== undefined) {
        setConv((prev) => (prev ? { ...prev, disappear_seconds: patch.disappearSeconds ?? null } : prev));
      }

      void (async () => {
        if (!meId) return;

        const row: Record<string, unknown> = {};
        if (patch.muted !== undefined) row.muted = patch.muted;
        if (patch.mutedUntil !== undefined) row.muted_until = patch.mutedUntil;
        if (patch.nickname !== undefined) row.nickname = patch.nickname;
        if (patch.chatColor !== undefined) row.chat_color = patch.chatColor;
        if (patch.wallpaper !== undefined) row.wallpaper = patch.wallpaper;
        if (patch.soundEnabled !== undefined) row.sound_enabled = patch.soundEnabled;

        if (Object.keys(row).length > 0) {
          const { error: err } = await supabase
            .from('conversation_participants')
            .update(row)
            .eq('conversation_id', conversationId)
            .eq('user_id', meId);
          if (err) {
            setError('Could not save that setting');
            if (__DEV__) console.warn('[conversation] settings save failed:', err.message);
          }
        }

        if (patch.disappearSeconds !== undefined) {
          const { error: err } = await supabase
            .from('conversations')
            .update({ disappear_seconds: patch.disappearSeconds })
            .eq('id', conversationId);
          if (err && __DEV__) console.warn('[conversation] disappear save failed:', err.message);
        }
      })();
    },
    [conversationId, meId]
  );

  // ---- search / jump ---------------------------------------------
  const searchable: SearchableMessage[] = useMemo(
    () =>
      state.messages.map((m) => ({
        id: m.id,
        content: contentOf(m),
        msg_type: m.kind,
        created_at: m.createdAt,
        sender_id: m.senderId,
        deleted_at: m.deletedAt,
      })),
    [state.messages]
  );

  // ---- view-once consumption -------------------------------------
  //
  // WHY THIS EXISTS: opening a view-once moment recorded nothing. The record
  // belongs in `message_views` (messaging_v2.sql STEP 8) rather than the legacy
  // `messages.viewed_by` column — that is the whole point of the split, so a
  // recipient never needs UPDATE power over the sender's row. The schema was
  // created, but the client was never moved onto it, so `viewedBy` stayed empty
  // and the same media could be reopened forever.
  //
  // Seeded from the server so the "already viewed" state survives a reload;
  // MomentBody already renders that state, it just never had data.
  useEffect(() => {
    if (!meId) return;
    const ids = state.messages
      .filter((m) => m.viewOnce && m.senderId !== meId)
      .map((m) => m.id);
    if (ids.length === 0) return;
    let cancelled = false;
    void fetchMyViews(meId, ids).then((seen) => {
      if (cancelled || seen.length === 0) return;
      setViewedOnce((prev) => {
        const next = new Set(prev);
        for (const id of seen) next.add(id);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [meId, state.messages]);

  // Opening a moment consumes it. Your OWN moment is not consumed by you —
  // otherwise the sender would lose their own media on first look.
  const markViewedLocally = useCallback((id: string) => {
    setViewedOnce((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const openMedia = useCallback(
    (m: Message) => {
      // Your own moment is never consumed by you, otherwise the sender
      // would lose their media on the first look.
      if (!m.viewOnce || !meId || m.senderId === meId) {
        setViewer(m);
        return;
      }

      // A view-once moment is opened THROUGH the server. It authorizes,
      // refuses a second viewing, records the view and hands back a
      // signed URL in one call. Hiding the bubble locally was never
      // consumption — the file stayed in a public bucket and could be
      // fetched again by anyone holding the URL.
      void (async () => {
        try {
          const url = await consumeViewOnce(m.id);
          markViewedLocally(m.id);
          if (!url) {
            setError('That moment has expired.');
            return;
          }
          setViewer({ ...m, legacyMediaUrl: url });
        } catch (e: any) {
          const msg = String(e?.message ?? '').toLowerCase();
          markViewedLocally(m.id);
          setError(
            msg.includes('already_viewed')
              ? 'You have already opened this once.'
              : 'That moment is no longer available.'
          );
        }
      })();
    },
    [meId, markViewedLocally]
  );

  // Fold a recorded view into the row's legacy `viewedBy`, which is the field
  // MomentBody already renders from. Doing it here keeps the fix in one place
  // instead of threading a new prop through MessageList and MessageBubble.
  // Untouched messages keep their identity, so list memoisation still holds.
  const renderedMessages = useMemo(() => {
    if (viewedOnce.size === 0 || !meId) return state.messages;
    return state.messages.map((m) =>
      m.viewOnce && m.senderId !== meId && viewedOnce.has(m.id) && m.viewedBy.length === 0
        ? { ...m, viewedBy: [meId] }
        : m
    );
  }, [state.messages, viewedOnce, meId]);

  const handleJump = useCallback((messageId: string) => {
    setSettingsOpen(false);
    // The parent may sit outside the loaded page, which is a real state in a
    // paginated thread — say so instead of silently doing nothing.
    requestAnimationFrame(() => {
      const ok = listRef.current?.scrollToMessage(messageId) ?? false;
      if (!ok) setError('That message is outside the loaded history — scroll up to load more');
    });
  }, []);

  // ---- sending ----------------------------------------------------
  const modeOptions = useCallback((): SendOptions => {
    if (sendMode === 'viewOnce') return { viewOnce: true };
    if (sendMode === 'temp24h') return { expiresAt: new Date(Date.now() + TEMP_MS).toISOString() };
    return {};
  }, [sendMode]);

  const handleSendText = useCallback(
    (text: string) => {
      // Screen before sending, and keep the draft: a blocked message must not
      // clear the composer, or the user loses what they wrote with no way to
      // fix it. Clearing replyTo is also skipped for the same reason.
      const blocked = screenTextError(text);
      if (blocked) {
        setError(blocked);
        return;
      }
      const target = replyTo;
      setReplyTo(null);
      void sendText(text, { replyTo: target?.id ?? null });
    },
    [replyTo, sendText]
  );

  const handleSendVoice = useCallback(
    async (uri: string, durationMs: number) => {
      setUploading(true);
      // §26 — tell the other side we are sending, not just typing.
      emitPresence('uploading', true);
      setError(null);
      try {
        if (!meId) throw new Error('Not signed in');
        // Private bucket: participants only. Reference, not URL.
        const url = await uploadPrivateMedia(
          'chat-media',
          `${conversationId}/${meId}/voice-${Date.now()}.m4a`,
          uri,
          'audio/mp4'
        );
        await send(
          'voice',
          { type: 'voice', durationMs: Math.round(durationMs) },
          { mediaUrl: url, ...modeOptions() }
        );
        setSendMode('normal');
      } catch (err) {
        setError('Voice message failed to upload');
        if (__DEV__) console.warn('[conversation] voice upload failed:', err);
      } finally {
        setUploading(false);
        emitPresence('uploading', false);
      }
    },
    [conversationId, send, modeOptions]
  );

  /** Pick from the library, then hand off to the editor (§9). */
  const pickMedia = useCallback(async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library permission is needed');
      return;
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.9,
    });
    if (res.canceled || !res.assets[0]) return;

    const asset = res.assets[0];
    const isVideo = asset.mimeType?.startsWith('video') ?? false;
    setPendingAsset({ uri: asset.uri, type: isVideo ? 'video' : 'photo' });
  }, []);

  /**
   * Upload + send whatever came out of the camera or the editor. One path for
   * both, so a captured photo and a picked photo cannot drift apart.
   */
  const uploadAndSend = useCallback(
    async (uri: string, kind: 'photo' | 'video', caption: string | null) => {
      setUploading(true);
      emitPresence('uploading', true);
      setError(null);
      try {
        const isVideo = kind === 'video';
        const ext = isVideo ? 'mp4' : 'jpg';
        if (!meId) throw new Error('Not signed in');
        // chat-media, not media. The path carries the conversation and
        // the sender so the storage policy can authorize on both.
        const url = await uploadPrivateMedia(
          'chat-media',
          `${conversationId}/${meId}/${Date.now()}.${ext}`,
          uri,
          isVideo ? 'video/mp4' : 'image/jpeg'
        );

        const body: MessageBody = isVideo
          ? { type: 'video', ...(caption ? { caption } : {}) }
          : { type: 'image', ...(caption ? { caption } : {}) };

        await send(isVideo ? 'video' : 'image', body, { mediaUrl: url, ...modeOptions() });
        setSendMode('normal');
      } catch (err: any) {
        // Surface the real reason. The previous fixed string made every
        // distinct failure — unreadable file, storage rejection, stalled
        // upload — look identical, so the cause was invisible in the UI.
        setError(friendlyError(err, 'Upload failed — tap to retry'));
        if (__DEV__) console.warn('[conversation] media upload failed:', err);
      } finally {
        setUploading(false);
        emitPresence('uploading', false);
      }
    },
    [conversationId, send, modeOptions, emitPresence]
  );

  const handleCaptured = useCallback((asset: CapturedAsset) => {
    setPendingAsset({ uri: asset.uri, type: asset.type });
  }, []);

  /**
   * If this build has no editor module, never strand an asset in a modal that
   * cannot render — send it directly. Degrade the feature, not the message.
   */
  useEffect(() => {
    if (pendingAsset && !editorAvailable) {
      const { uri, type } = pendingAsset;
      setPendingAsset(null);
      void uploadAndSend(uri, type, null);
    }
  }, [pendingAsset, editorAvailable, uploadAndSend]);

  const handleLocation = useCallback(
    async (payload: LocationPayload) => {
      try {
        await send('location', {
          type: 'location',
          lat: payload.lat,
          lng: payload.lng,
          ...(payload.label ? { label: payload.label } : {}),
          ...(payload.liveUntil ? { liveUntil: payload.liveUntil } : {}),
        });
      } catch {
        setError('Could not share that location');
      }
    },
    [send]
  );

  /** §19 — documents, archives, audio. */
  const pickFile = useCallback(async () => {
    setAttachOpen(false);

    // Resolved lazily. `expo-document-picker` was the module missing from the
    // build that crashed the app, so it is never imported at module scope.
    const mod = documentPicker.get() as {
      getDocumentAsync: (opts: {
        type: string;
        copyToCacheDirectory: boolean;
        multiple: boolean;
      }) => Promise<{
        canceled: boolean;
        assets?: { uri: string; name?: string; size?: number; mimeType?: string }[];
      }>;
    } | null;

    if (!mod) {
      setError(documentPicker.reason() ?? 'File sharing is unavailable in this build');
      return;
    }

    try {
      const res = await mod.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      const picked = res.assets?.[0];
      if (res.canceled || !picked) return;

      const file = picked;
      setUploading(true);
      emitPresence('uploading', true);
      try {
        const name = file.name ?? 'file';
        const ext = name.includes('.') ? name.split('.').pop() : 'bin';
        if (!meId) throw new Error('Not signed in');
        const url = await uploadPrivateMedia(
          'chat-media',
          `${conversationId}/${meId}/${Date.now()}.${ext}`,
          file.uri,
          file.mimeType ?? 'application/octet-stream'
        );
        await send(
          'file',
          {
            type: 'file',
            fileName: name,
            byteSize: file.size ?? 0,
            mime: file.mimeType ?? 'application/octet-stream',
          },
          { mediaUrl: url, ...modeOptions() }
        );
        setSendMode('normal');
      } finally {
        setUploading(false);
        emitPresence('uploading', false);
      }
    } catch (err) {
      setError('Could not send that file');
      if (__DEV__) console.warn('[conversation] file send failed:', err);
    }
  }, [conversationId, send, modeOptions, emitPresence]);

  const sendGif = useCallback(
    async (url: string) => {
      setGifOpen(false);
      try {
        await send(
          'gif',
          { type: 'gif', provider: 'giphy', id: url, previewPath: url },
          { mediaUrl: url, ...modeOptions() }
        );
        setSendMode('normal');
      } catch {
        setError('GIF failed to send');
      }
    },
    [send, modeOptions]
  );

  /** §18 — save into the personal vault reachable from the chat list ⋮ menu. */
  const saveMessage = useCallback(
    async (messageId: string) => {
      if (!meId) return;
      const { error: err } = await supabase
        .from('saved_messages')
        .insert({ user_id: meId, message_id: messageId });
      // 23505 = already saved. That is a no-op, not a failure.
      if (err && err.code !== '23505') {
        setError('Could not save that message');
        if (__DEV__) console.warn('[conversation] save failed:', err.message);
      }
    },
    [meId]
  );

  const saveEdit = useCallback(async () => {
    const target = editFor;
    const next = editText.trim();
    setEditFor(null);
    if (!target || !next) return;
    try {
      await edit(target.id, { type: 'text', text: next });
    } catch {
      setError('Could not edit that message');
    }
  }, [editFor, editText, edit]);

  const presence = other
    ? isOnline(other.profile?.last_seen_at ?? null)
      ? 'Online'
      : other.profile?.last_seen_at
        ? `Last seen ${relative(other.profile.last_seen_at)}`
        : 'Offline'
    : '';

  const subtitle = typingNames.length > 0 ? `${typingNames[0]} is typing…` : presence;

  const activeMode = SEND_MODES.find((m) => m.key === sendMode) ?? SEND_MODES[0];

  return (
    <KeyboardAvoidingView
      style={styles.root}
      // Android MUST be 'height', not undefined.
      //
      // In RN 0.86 KeyboardAvoidingView has no defaultProps, so
      // `behavior={undefined}` falls through to the component's `default:`
      // branch and renders a plain View. It still subscribes to
      // keyboardDidShow and then throws the measurement away — so it looks
      // wired up and does nothing, and the keyboard covers the composer.
      //
      // This matches screens/ChatThread.tsx, which has always used 'height' on
      // Android. See the fuller note in utils/useSheetPad.ts.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <WallpaperLayer wallpaper={wallpaper} rawKey={wallpaperKey} />

      {/* header */}
      <View style={[styles.header, { paddingTop: TOP_INSET + 6 }]}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.headerBtn} accessibilityLabel="Go back">
          <Icon name="chevron-back" size={24} color={colors.text} />
        </Pressable>

        <Pressable
          style={styles.headerMain}
          onPress={() => {
            if (isGroup) setGroupInfoOpen(true);
          }}
          accessibilityRole={isGroup ? 'button' : undefined}
          accessibilityLabel={isGroup ? 'Group info and members' : undefined}
        >
          <Avatar
            url={conv?.avatar_url ?? other?.profile?.avatar_url ?? null}
            size={38}
            name={title}
          />
          <View style={styles.headerText}>
            <View style={styles.headerNameRow}>
              <Text style={styles.headerName} numberOfLines={1}>
                {title}
              </Text>
              {other?.profile?.verified && <VerifiedBadge size={13} />}
            </View>
            {!!subtitle && (
              <Text
                style={[styles.headerSub, typingNames.length > 0 && styles.headerSubTyping]}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            )}
          </View>
        </Pressable>

        {/* Voice + video call. Restored: the Messaging Paradise migration moved
            the thread from ChatThread to this screen and left these behind. */}
        {canCall && (
          <>
            <Pressable
              onPress={() => startCall('video')}
              hitSlop={10}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel="Start video call"
            >
              <Icon name="videocam-outline" size={21} color={colors.text} />
            </Pressable>

            <Pressable
              onPress={() => startCall('audio')}
              hitSlop={10}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel="Start voice call"
            >
              <Icon name="call-outline" size={20} color={colors.text} />
            </Pressable>
          </>
        )}

        {/* Shared Space — everything exchanged, without scrolling for it */}
        <Pressable
          onPress={() => setSharedOpen(true)}
          hitSlop={10}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Open Shared Space"
        >
          <Icon name="images-outline" size={20} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={() => setSettingsOpen(true)}
          hitSlop={10}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Conversation options, search and settings"
        >
          <Icon name="ellipsis-vertical" size={20} color={colors.text} />
        </Pressable>
      </View>

      {uploading && (
        <View style={styles.uploadBar}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.uploadText}>
            Uploading…{sendMode !== 'normal' ? ` · ${activeMode.label}` : ''}
          </Text>
        </View>
      )}

      {!!error && (
        <Pressable style={styles.errorBar} onPress={() => setError(null)}>
          <Icon name="alert-circle" size={14} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      )}

      {/* pins live outside the paginated window, so they get their own strip */}
      {pinned.length > 0 && (
        <Pressable
          style={styles.pinnedBar}
          onPress={() => {
            const top = pinned[0];
            if (top) handleJump(top.id);
          }}
          accessibilityRole="button"
          accessibilityLabel="Jump to pinned message"
        >
          <Icon name="pin" size={13} color={colors.accent} />
          <Text style={styles.pinnedText} numberOfLines={1}>
            {pinned[0]?.body.type === 'text' ? pinned[0].body.text : 'Pinned message'}
          </Text>
          {pinned.length > 1 && <Text style={styles.pinnedCount}>{pinned.length}</Text>}
        </Pressable>
      )}

      {/* the timeline */}
      {state.loading && !state.hydrated ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : state.messages.length === 0 && calls.length === 0 ? (
        <EmptyThread
          title={title}
          avatarUrl={other?.profile?.avatar_url ?? null}
          onQuickSend={handleSendText}
        />
      ) : (
        <MessageList
          ref={listRef}
            messages={renderedMessages}
           // History is part of the call feature, so it goes dark with it.
           // Leaving call pills in the thread while the buttons are hidden would
           // read as a bug rather than as a feature that is not launched yet.
           calls={CALLING_ENABLED ? calls : []}
           meId={meId}
          isGroup={isGroup}
          typingNames={typingNames}
          loadingOlder={state.loadingOlder}
          hasMore={state.hasMore}
          palette={bubblePalette}
          nameFor={nameFor}
          seenFor={seenFor}
          onLoadOlder={() => void loadOlder()}
          onRetry={(clientMessageId) => void retry(clientMessageId)}
          onReact={(m, emoji) => void react(m.id, emoji)}
          onLongPress={setMenuFor}
          onOpenMedia={openMedia}
          onOpenSender={() => undefined}
        />
      )}

      {/* send-mode banner: the selected mode must be obvious before sending (§10) */}
      {sendMode !== 'normal' && (
        <Pressable style={styles.modeBanner} onPress={() => setSendMode('normal')}>
          <Icon name={activeMode.icon} size={14} color={colors.accent} />
          <Text style={styles.modeBannerText}>
            {activeMode.label} — {activeMode.hint}. Tap to turn off.
          </Text>
        </Pressable>
      )}

      <Composer
        onSendText={handleSendText}
        onSendVoice={(uri, ms) => void handleSendVoice(uri, ms)}
        onTyping={setTyping}
        onAttach={() => setAttachOpen(true)}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        palette={{ myBg: palette.myBg, myText: palette.myText }}
        onRecordingChange={(on) => emitPresence('recording', on)}
      />

      {/* ---- long-press menu ---- */}
      <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuFor(null)}>
          <View style={styles.menuCard}>
            <View style={styles.reactionBar}>
              {REACTION_BAR.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={styles.reactionBtn}
                  onPress={() => {
                    if (menuFor) void react(menuFor.id, emoji);
                    setMenuFor(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`React ${emoji}`}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>

            <MenuRow
              icon="arrow-undo-outline"
              label="Reply"
              onPress={() => {
                setReplyTo(menuFor);
                setMenuFor(null);
              }}
            />

            {menuFor && menuFor.body.type === 'text' && (
              <MenuRow
                icon="copy-outline"
                label="Copy text"
                onPress={() => {
                  if (menuFor.body.type === 'text') void Clipboard.setStringAsync(menuFor.body.text);
                  setMenuFor(null);
                }}
              />
            )}

            <MenuRow
              icon="bookmark-outline"
              label="Save to My Saves"
              onPress={() => {
                if (menuFor) void saveMessage(menuFor.id);
                setMenuFor(null);
              }}
            />

            <MenuRow
              icon="copy-outline"
              label="Select / Forward"
              onPress={() => {
                setMenuFor(null);
                setError('Multi-select and forwarding land in Pass 2');
              }}
            />

            {menuFor && meId && menuFor.senderId === meId && menuFor.body.type === 'text' && (
              <MenuRow
                icon="create-outline"
                label="Edit"
                onPress={() => {
                  if (menuFor.body.type === 'text') {
                    setEditText(menuFor.body.text);
                    setEditFor(menuFor);
                  }
                  setMenuFor(null);
                }}
              />
            )}

            {menuFor && !!menuFor.replyTo && (
              <MenuRow
                icon="locate-outline"
                label="Go to original"
                onPress={() => {
                  const target = menuFor.replyTo;
                  setMenuFor(null);
                  if (target) handleJump(target);
                }}
              />
            )}

            <MenuRow
              icon={menuFor?.pinnedAt ? 'pin' : 'pin-outline'}
              label={menuFor?.pinnedAt ? 'Unpin' : 'Pin'}
              onPress={() => {
                if (menuFor) void pin(menuFor.id, !menuFor.pinnedAt);
                setMenuFor(null);
              }}
            />

            <MenuRow
              icon="arrow-redo-outline"
              label="Forward"
              onPress={() => {
                setForwardFor(menuFor);
                setMenuFor(null);
              }}
            />

            <MenuRow
              icon="mail-unread-outline"
              label="Mark as unread"
              onPress={() => {
                setMenuFor(null);
                void markUnread();
                onBack();
              }}
            />

            <MenuRow
              icon="flag-outline"
              label="Report"
              danger
              onPress={() => {
                setReportFor(menuFor);
                setMenuFor(null);
              }}
            />

            {menuFor && meId && menuFor.senderId === meId && (
              <MenuRow
                icon="trash-outline"
                label="Delete for everyone"
                danger
                onPress={() => {
                  void remove(menuFor.id, true);
                  setMenuFor(null);
                }}
              />
            )}

            <MenuRow
              icon="eye-off-outline"
              label="Delete for me"
              danger
              onPress={() => {
                if (menuFor) void remove(menuFor.id, false);
                setMenuFor(null);
              }}
            />
          </View>
        </Pressable>
      </Modal>

      {/* ---- attach sheet, with send modes ---- */}
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setAttachOpen(false)}>
          <View style={styles.attachSheet}>
            <Text style={styles.attachTitle}>Send</Text>

            <View style={styles.modeRow}>
              {SEND_MODES.map((m) => {
                const on = sendMode === m.key;
                return (
                  <Pressable
                    key={m.key}
                    onPress={() => setSendMode(m.key)}
                    style={[styles.modeChip, on && styles.modeChipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`${m.label}. ${m.hint}`}
                  >
                    <Icon name={m.icon} size={15} color={on ? colors.bg : colors.textMuted} />
                    <Text style={[styles.modeChipText, on && styles.modeChipTextOn]}>{m.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.attachGrid}>
              <AttachTile icon="images-outline" label="Photo or video" onPress={() => void pickMedia()} />
              <AttachTile
                icon="film-outline"
                label="GIF"
                onPress={() => {
                  setAttachOpen(false);
                  setGifOpen(true);
                }}
              />
              <AttachTile
                icon="camera-outline"
                label={cameraAvailable ? 'Camera' : 'Camera n/a'}
                unavailable={!cameraAvailable}
                onPress={() => {
                  setAttachOpen(false);
                  if (!cameraAvailable) {
                    setError(cameraModule.reason() ?? 'Camera is unavailable in this build');
                    return;
                  }
                  setCameraOpen(true);
                }}
              />
              <AttachTile
                icon="location-outline"
                label={locationAvailable ? 'Location' : 'Location n/a'}
                unavailable={!locationAvailable}
                onPress={() => {
                  setAttachOpen(false);
                  if (!locationAvailable) {
                    setError(locationModule.reason() ?? 'Location is unavailable in this build');
                    return;
                  }
                  setLocationOpen(true);
                }}
              />
              <AttachTile icon="person-outline" label="Contact" onPress={() => {
                setAttachOpen(false);
                setError('Contact cards land in the next pass');
              }} />
              <AttachTile
                icon="stats-chart-outline"
                label="Poll"
                onPress={() => {
                  setAttachOpen(false);
                  setPollOpen(true);
                }}
              />
              <AttachTile
                icon="document-outline"
                label={fileAvailable ? 'File' : 'File n/a'}
                unavailable={!fileAvailable}
                onPress={() => void pickFile()}
              />
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* ---- edit ---- */}
      <Modal visible={!!editFor} transparent animationType="fade" onRequestClose={() => setEditFor(null)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setEditFor(null)}>
          <View style={styles.editCard}>
            <Text style={styles.attachTitle}>Edit message</Text>
            <TextInput
              value={editText}
              onChangeText={setEditText}
              style={styles.editInput}
              multiline
              autoFocus
              placeholder="Message…"
              placeholderTextColor={colors.textFaint}
            />
            <View style={styles.editActions}>
              <Pressable style={styles.editBtn} onPress={() => setEditFor(null)}>
                <Text style={styles.editBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.editBtn, styles.editBtnPrimary]} onPress={() => void saveEdit()}>
                <Text style={[styles.editBtnText, { color: colors.bg }]}>Save</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* ---- GIF picker ---- */}
      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onPick={(url) => void sendGif(url)} />

      {/* ---- settings + search ---- */}
      <ChatSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        convId={conversationId}
        isGroup={isGroup}
        other={
          other
            ? {
                id: other.user_id,
                username: other.nickname ?? other.profile?.username ?? 'User',
                avatar_url: other.profile?.avatar_url ?? null,
              }
            : null
        }
        settings={settings}
        onChange={handleSettingsChange}
        messages={searchable}
        onJump={handleJump}
        onBlocked={onBack}
      />

      {/* ---- camera (§9) ---- */}
      <Modal
        visible={cameraOpen}
        animationType="slide"
        onRequestClose={() => setCameraOpen(false)}
      >
        {CameraScreenLazy && (
          <CameraScreenLazy
            onClose={() => setCameraOpen(false)}
            onCapture={handleCaptured}
            intent={sendMode === 'viewOnce' ? 'moment' : 'message'}
          />
        )}
      </Modal>

      {/* ---- media editor (§9) — camera and library share this path ---- */}
      <Modal
        visible={!!pendingAsset && editorAvailable}
        animationType="slide"
        onRequestClose={() => setPendingAsset(null)}
      >
        {pendingAsset && MediaEditorLazy && (
          <MediaEditorLazy
            uri={pendingAsset.uri}
            mediaType={pendingAsset.type}
            onCancel={() => setPendingAsset(null)}
            onDone={(editedUri, caption) => {
              const kind = pendingAsset.type;
              setPendingAsset(null);
              void uploadAndSend(editedUri, kind, caption);
            }}
          />
        )}
      </Modal>

      {/* ---- location (§21) ---- */}
      {LocationPickerLazy && (
        <LocationPickerLazy
          visible={locationOpen}
          onClose={() => setLocationOpen(false)}
          onSend={(payload) => void handleLocation(payload)}
        />
      )}

      {/* ---- group info (§27) ---- */}
      <Modal
        visible={groupInfoOpen}
        animationType="slide"
        onRequestClose={() => setGroupInfoOpen(false)}
      >
        <GroupInfoScreen
          conversationId={conversationId}
          onBack={() => setGroupInfoOpen(false)}
        />
      </Modal>

      {/* ---- poll composer ---- */}
      <PollComposer
        visible={pollOpen}
        onClose={() => setPollOpen(false)}
        onCreate={(draft: PollDraft) => void createPoll(draft)}
      />

      {/* ---- forward ---- */}
      <ForwardPicker
        visible={!!forwardFor}
        onClose={() => setForwardFor(null)}
        onPick={(targetId) => {
          const src = forwardFor;
          setForwardFor(null);
          if (src) void forward(src, targetId);
        }}
      />

      {/* ---- report ---- */}
      <ReportSheet
        visible={!!reportFor}
        onClose={() => setReportFor(null)}
        conversationId={conversationId}
        messageId={reportFor?.id ?? null}
        reportedUserId={reportFor?.senderId ?? null}
        // The whole message, so the report can carry evidence. ReportSheet reads
        // it defensively — see its buildEvidence() — because the envelope has
        // fourteen variants and filing the report must never depend on one field.
        snapshot={reportFor}
      />

      {/* ---- Shared Space ---- */}
      <Modal
        visible={sharedOpen}
        animationType="slide"
        onRequestClose={() => setSharedOpen(false)}
      >
        <SharedSpaceScreen
          conversationId={conversationId}
          onBack={() => setSharedOpen(false)}
        />
      </Modal>

      {/* ---- media viewer ---- */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={styles.viewerBackdrop} onPress={() => setViewer(null)}>
          {viewer?.legacyMediaUrl ? (
            // A video needs a PLAYER. This branch previously rendered every
            // message as an <Image>, so opening a video — including a view-once
            // video — produced a still-image element with nothing inside it:
            // blank, with no indication that anything was wrong.
            viewer.body.type === 'video' ? (
              <ViewerVideo uri={viewer.legacyMediaUrl} />
            ) : (
              <ViewerImage uri={viewer.legacyMediaUrl} />
            )
          ) : (
            <Text style={styles.viewerEmpty}>Nothing to show</Text>
          )}
        </Pressable>
      </Modal>

      {/* ---- voice / video call ---- */}
      <CallScreen
        state={call}
        name={title}
        avatarUrl={callPeerAvatar}
        soundOn
        onAccept={acceptCall}
        onDecline={declineCall}
        onEnd={endCall}
      />
    </KeyboardAvoidingView>
  );
}

// ------------------------------------------------------------
// Pieces
// ------------------------------------------------------------

function WallpaperLayer({ wallpaper, rawKey }: { wallpaper: WallpaperDef | null; rawKey: string }) {
  if (isCustomWallpaper(rawKey)) {
    return (
      <Image
        source={{ uri: customWallpaperUri(rawKey) }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        blurRadius={1}
      />
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {wallpaper?.base !== 'transparent' && (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: wallpaper?.base ?? 'transparent' }]}
        />
      )}
      {(wallpaper?.glows ?? []).map((g, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            width: g.w,
            height: g.h,
            top: g.top,
            left: g.left,
            right: g.right,
            borderRadius: g.w / 2,
            backgroundColor: g.color,
          }}
        />
      ))}
    </View>
  );
}

function EmptyThread({
  title,
  avatarUrl,
  onQuickSend,
}: {
  title: string;
  avatarUrl: string | null;
  onQuickSend: (text: string) => void;
}) {
  return (
    <View style={styles.empty}>
      <Avatar url={avatarUrl} size={76} name={title} />
      <Text style={styles.emptyName}>{title}</Text>
      <Text style={styles.emptyHint}>Start a conversation</Text>
      <View style={styles.emptyChips}>
        {['👋 Say hello', "What's up?", 'Long time!'].map((chip) => (
          <Pressable key={chip} style={styles.emptyChip} onPress={() => onQuickSend(chip)}>
            <Text style={styles.emptyChipText}>{chip}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable style={styles.menuRow} onPress={onPress} accessibilityRole="button">
      <Icon name={icon} size={18} color={danger ? colors.danger : colors.text} />
      <Text style={[styles.menuLabel, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

function AttachTile({
  icon,
  label,
  onPress,
  unavailable,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  /** true when the native module is missing from this build */
  unavailable?: boolean;
}) {
  return (
    <Pressable
      style={[styles.attachTile, unavailable && styles.attachTileOff]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={unavailable ? `${label} — needs an app rebuild` : label}
      accessibilityState={{ disabled: !!unavailable }}
    >
      <View style={[styles.attachIconWrap, unavailable && styles.attachIconWrapOff]}>
        <Icon name={icon} size={22} color={unavailable ? colors.textFaint : colors.accent} />
      </View>
      <Text style={[styles.attachLabel, unavailable && { color: colors.textFaint }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Full-screen video for the media viewer.
 *
 * WHY THIS EXISTS: the viewer rendered every message as an <Image>, so opening
 * a video — a view-once video especially — drew a still-image element with
 * nothing in it. Video needs an actual player; there is no way to make an
 * <Image> play a clip.
 *
 * Native controls are ON here, unlike the feed's DropVideoView: this is an
 * explicit "open and watch" surface, so scrubbing and volume should be
 * available without hand-building a control bar. Playback also starts on its
 * own, since the user tapped specifically to open this clip.
 */
/**
 * Full-screen still for the media viewer.
 *
 * WHY THIS EXISTS: this used to be a bare <Image>, and an <Image> draws NOTHING
 * AT ALL when its fetch fails. So an unreachable media URL — for example a
 * private-bucket object that was never signed — produced a completely blank
 * full-screen view with no explanation. That is indistinguishable from a broken
 * screen, and it is exactly the reported symptom.
 *
 * Note the asymmetry this replaces: a NULL url already rendered "Nothing to
 * show", so only the harder case — a url that is present but unusable — went
 * silent. Tracking the failure makes it legible.
 */
function ViewerImage({ uri }: { uri: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <Text style={styles.viewerEmpty}>Couldn't load this media</Text>;
  }

  return (
    <Image
      source={{ uri }}
      style={styles.viewerImage}
      resizeMode="contain"
      onError={() => setFailed(true)}
    />
  );
}

function ViewerVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.play();
  });

  return (
    <VideoView
      player={player}
      style={styles.viewerImage}
      contentFit="contain"
      nativeControls
    />
  );
}

function relative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.glass,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerText: { flex: 1 },
  headerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerName: { fontSize: type.heading.fontSize, fontWeight: '700', color: colors.text },
  headerSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  headerSubTyping: { color: colors.accent, fontStyle: 'italic' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  uploadBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.accentSoft,
  },
  uploadText: { fontSize: 12, color: colors.accent, fontWeight: '600' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,92,124,0.12)',
  },
  errorText: { fontSize: 12, color: colors.danger, flex: 1 },
  pinnedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pinnedText: { fontSize: 12, color: colors.textMuted, flex: 1 },
  pinnedCount: { fontSize: 10, color: colors.textFaint, fontWeight: '700' },
  modeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modeBannerText: { fontSize: 11.5, color: colors.textMuted, flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  emptyName: { fontSize: type.title.fontSize, fontWeight: '700', color: colors.text },
  emptyHint: { fontSize: 14, color: colors.textMuted },
  emptyChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  emptyChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  emptyChipText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  menuBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  menuCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: 2,
  },
  reactionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
    marginBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  reactionBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  reactionEmoji: { fontSize: 26 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  menuLabel: { fontSize: 15, color: colors.text, fontWeight: '600' },
  attachSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  attachTitle: {
    fontSize: type.heading.fontSize,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  modeChipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  modeChipText: { fontSize: 12.5, color: colors.textMuted, fontWeight: '600' },
  modeChipTextOn: { color: colors.bg },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  attachTile: { width: '22%', alignItems: 'center', gap: 6 },
  attachTileOff: { opacity: 0.6 },
  attachIconWrap: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIconWrapOff: { backgroundColor: colors.surfaceAlt },
  attachLabel: { fontSize: 11, color: colors.textMuted, textAlign: 'center' },
  editCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  editInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: 15,
    maxHeight: 160,
    minHeight: 84,
  },
  editActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  editBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  editBtnPrimary: { backgroundColor: colors.accent },
  editBtnText: { fontSize: 14, fontWeight: '700', color: colors.text },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: { width: '100%', height: '80%' },
  viewerEmpty: { color: colors.textMuted },
});
