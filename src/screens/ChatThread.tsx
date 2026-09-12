import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
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
import { VideoView, useVideoPlayer } from 'expo-video';
import { useAudioPlayer, useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import { supabase } from '../supabase/client';
import {
  preventScreenCaptureAsync,
  allowScreenCaptureAsync,
  addScreenshotListener,
} from 'expo-screen-capture';
import { colors, radius, shadows } from '../theme';
import Icon from '../components/ui/Icon';
import { TOP_INSET } from '../utils/useInsets';
import LogoHeader from '../components/LogoHeader';
import GifPicker from '../components/GifPicker';
import { uploadMedia } from '../utils/upload';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import ChatSettingsSheet, { ChatSettingsData } from '../components/chat/ChatSettingsSheet';
import CallScreen, { CallState } from '../components/chat/CallScreen';
import CallHistoryRow, { CallRow } from '../components/chat/CallHistoryRow';
import {
  resolveChatPalette,
  isCustomWallpaper,
  customWallpaperUri,
  WALLPAPERS,
  ChatPalette,
} from '../utils/chatTheme';

const REACTIONS = ['❤️', '😂', '🔥', '👏', '😮', '💯'];
const EMOJI_BAR = ['😀', '😂', '😍', '🔥', '😮', '💯', '👍', '🙏', '😭', '🥳'];

// WhatsApp-style date divider rows inserted between calendar days
type DateRow = { type: 'date'; label: string };

function dateLabel(d: Date): string {
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === today.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString([], opts);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  media_url: string | null;
  msg_type: string;
  reaction: string | null;
  reply_to: string | null;
  deleted_at: string | null;
  created_at: string;
  view_once?: boolean | null;
  viewed_by?: string[] | null;
  sender: { username: string; verified?: boolean } | null;
  reply: { content: string | null; media_url: string | null; msg_type: string } | null;
};

type Participant = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  verified?: boolean;
  last_seen_at: string | null;
  last_read_at: string | null;
  muted?: boolean;
  muted_until?: string | null;
  nickname?: string | null;
  chat_color?: string;
  wallpaper?: string;
  sound_enabled?: boolean;
};

type Conv = {
  type: string;
  name: string | null;
  avatar_url: string | null;
  disappear_seconds?: number | null;
};

export default function ChatThread({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
// Group chats can have thousands of messages — never fetch them all at once.
// Load the latest page, then fetch older pages as the user scrolls up.
const HISTORY_PAGE = 80;
const [hasOlder, setHasOlder] = useState(false);
const [loadingOlder, setLoadingOlder] = useState(false);
const loadingOlderRef = useRef(false);
const oldestRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [otherTyping, setOtherTyping] = useState(false);
  const [conv, setConv] = useState<Conv | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [uploading, setUploading] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);
  const [viewer, setViewer] = useState<{ uri: string; video?: boolean; once?: boolean } | null>(null);
  const viewerPlayer = useVideoPlayer(viewer?.video ? { uri: viewer.uri } : null, (p) => {
    p.loop = false;
  });
  useEffect(() => {
    if (viewer?.video) viewerPlayer.play();
  }, [viewer, viewerPlayer]);

  // view-once reveal: block screenshots (Android FLAG_SECURE) and instantly
  // close the viewer if a screenshot is detected (iOS can only detect, not
  // block — the media is already destroyed server-side anyway).
  useEffect(() => {
    if (!viewer?.once) return;
    let sub: { remove: () => void } | null = null;
    (async () => {
      try {
        await preventScreenCaptureAsync();
      } catch {}
    })();
    try {
      sub = addScreenshotListener(() => setViewer(null));
    } catch {}
    return () => {
      try {
        allowScreenCaptureAsync();
      } catch {}
      sub?.remove();
    };
  }, [viewer?.once]);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const myIdRef = useRef<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingFlag = useRef(0);

  // ---- per-user chat settings + calls --------------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [call, setCall] = useState<CallState>(null);
  const callRef = useRef<CallState>(null);
  const callStartedAtRef = useRef(0);
  const callIdMapRef = useRef<Record<string, string>>({});
  const setCallBoth = useCallback((next: CallState) => {
    callRef.current = next;
    setCall(next);
  }, []);
  const listRef = useRef<FlatList<Message | DateRow | CallRow>>(null);

  // Client-side enrichment refs — sender/reply are resolved from already
  // loaded data instead of DB joins (joins were breaking the message query).
  const messagesRef = useRef<Message[]>([]);
  const participantsRef = useRef<Participant[]>([]);

  const commitMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const commitParticipants = useCallback((updater: (prev: Participant[]) => Participant[]) => {
    setParticipants((prev) => {
      const next = updater(prev);
      participantsRef.current = next;
      return next;
    });
  }, []);

  const enrich = useCallback((raw: any): Message => {
    const part = participantsRef.current.find((p) => p.user_id === raw.sender_id);
    const rep = raw.reply_to ? messagesRef.current.find((m) => m.id === raw.reply_to) : null;
    return {
      ...(raw as Message),
      sender: part ? { username: part.username, verified: part.verified ?? false } : null,
      reply: rep ? { content: rep.content, media_url: rep.media_url, msg_type: rep.msg_type } : null,
    };
  }, []);

  const me = myIdRef.current;
  const other = participants.find((p) => p.user_id !== me) ?? null;
  const isGroup = conv?.type === 'group';
  const myReadAt = participants.find((p) => p.user_id === me)?.last_read_at ?? null;

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    myIdRef.current = user?.id ?? null;
    const uid = user?.id ?? null;

    const [{ data: convRows }, { data: partRows }, { data: msgRows }, { data: callRows }] = await Promise.all([
      supabase
        .from('conversations')
        .select('type, name, avatar_url, disappear_seconds')
        .eq('id', conversationId)
        .maybeSingle(),
      supabase
        .from('conversation_participants')
        .select(
          'user_id, last_read_at, muted, muted_until, nickname, chat_color, wallpaper, sound_enabled, profile:profiles(username, avatar_url, last_seen_at, verified)'
        )
        .eq('conversation_id', conversationId),
      supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(HISTORY_PAGE),
      supabase
        .from('calls')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('started_at', { ascending: true }),
    ]);

    setConv((convRows as Conv | null) ?? null);
    const partList = ((partRows ?? []) as any[]).map((p) => ({
      user_id: p.user_id,
      username: p.profile?.username ?? 'unknown',
      avatar_url: p.profile?.avatar_url ?? null,
      verified: p.profile?.verified ?? false,
      last_seen_at: p.profile?.last_seen_at ?? null,
      last_read_at: p.last_read_at ?? null,
      muted: p.muted ?? false,
      muted_until: p.muted_until ?? null,
      nickname: p.nickname ?? null,
      chat_color: p.chat_color ?? 'orange',
      wallpaper: p.wallpaper ?? 'glow',
      sound_enabled: p.sound_enabled ?? true,
    }));
    // Populate refs directly so enrich() sees them immediately (setState
    // updaters only run during render, which would be too late for the map).
    participantsRef.current = partList;
    setParticipants(partList);
    const rows = ((msgRows ?? []) as any[]).map((raw) => enrich(raw));
    messagesRef.current = rows;
    setMessages(rows);
    // pagination bookkeeping: oldest loaded message + whether more exist
    const fetched = ((msgRows ?? []) as any[]).length;
    oldestRef.current = rows.length ? rows[0].created_at : null;
    setHasOlder(fetched >= HISTORY_PAGE);
    setCalls(((callRows ?? []) as CallRow[]).sort((a, b) => a.started_at.localeCompare(b.started_at)));
    setLoading(false);

    // mark read
    if (uid && conversationId) {
      await supabase
        .from('conversation_participants')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', uid);
    }
  }, [conversationId]);

  // Fetch the page of messages OLDER than the oldest one we have (fires as
  // the user scrolls to the top of a long history).
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasOlder || !oldestRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .lt('created_at', oldestRef.current)
        .order('created_at', { ascending: true })
        .limit(HISTORY_PAGE);
      const older = ((data ?? []) as any[]).map((raw) => enrich(raw));
      if (older.length) {
        oldestRef.current = older[0].created_at;
        commitMessages((prev) => [...older, ...prev]);
        setHasOlder(older.length >= HISTORY_PAGE);
      } else {
        setHasOlder(false);
      }
    } catch {
      // keep hasOlder as-is; the user can scroll again to retry
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasOlder, conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  // realtime: messages + read markers + typing broadcast
  useEffect(() => {
    const channel = supabase
      .channel(`chat2:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          commitMessages((prev) => {
            if (prev.some((m) => m.id === payload.new.id)) return prev;
            // drop the optimistic placeholder for this same send (if realtime
            // beat the insert response), then append the real row
            const cleaned = prev.filter(
              (m) =>
                !(
                  m.id.startsWith('local-') &&
                  m.sender_id === payload.new.sender_id &&
                  Math.abs(new Date(m.created_at).getTime() - new Date(payload.new.created_at).getTime()) < 4000
                )
            );
            return [...cleaned, enrich(payload.new)];
          });
          // mark read on incoming
          const uid = myIdRef.current;
          if (uid && conversationId && payload.new.sender_id !== uid) {
            supabase
              .from('conversation_participants')
              .update({ last_read_at: new Date().toISOString() })
              .eq('conversation_id', conversationId)
              .eq('user_id', uid);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          commitMessages((prev) => prev.map((m) => (m.id === payload.new.id ? enrich({ ...m, ...payload.new }) : m)));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversation_participants', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          setParticipants((prev) =>
            prev.map((p) =>
              p.user_id === payload.new.user_id
                ? {
                    ...p,
                    last_read_at: payload.new.last_read_at ?? p.last_read_at,
                    muted: payload.new.muted ?? p.muted,
                    muted_until: payload.new.muted_until ?? p.muted_until,
                    nickname: payload.new.nickname ?? p.nickname,
                    chat_color: payload.new.chat_color ?? p.chat_color,
                    wallpaper: payload.new.wallpaper ?? p.wallpaper,
                    sound_enabled: payload.new.sound_enabled ?? p.sound_enabled,
                  }
                : p
            )
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `id=eq.${conversationId}` },
        (payload: any) => {
          setConv((prev) =>
            prev ? { ...prev, disappear_seconds: payload.new.disappear_seconds ?? null } : prev
          );
        }
      )
      .on('broadcast', { event: 'call-offer' }, ({ payload }: any) => {
        if (!payload?.callId || !payload?.from) return;
        if (payload.from === myIdRef.current) return;
        if (callRef.current) return; // already in a call
        setCallBoth({
          dir: 'in',
          kind: payload.kind === 'video' ? 'video' : 'audio',
          status: 'ringing',
          callId: payload.callId,
        });
        // auto-mark missed if not answered within 45s (like WhatsApp)
        setTimeout(() => {
          const cur = callRef.current;
          if (cur && cur.callId === payload.callId && cur.dir === 'in' && cur.status === 'ringing') {
            const dbId = callIdMapRef.current[cur.callId] ?? cur.callId;
            supabase.rpc('calls_set_status', { p_call_id: dbId, p_status: 'missed' }).then(() => {});
            channel.send({ type: 'broadcast', event: 'call-end', payload: { callId: cur.callId } });
            setCallBoth(null);
          }
        }, 45000);
      })
      .on('broadcast', { event: 'call-accept' }, ({ payload }: any) => {
        if (callRef.current?.dir === 'out' && callRef.current.callId === payload?.callId) {
          setCallBoth({ ...callRef.current, status: 'active' });
        }
      })
      .on('broadcast', { event: 'call-decline' }, ({ payload }: any) => {
        if (callRef.current?.dir === 'out' && callRef.current.callId === payload?.callId) {
          setCallBoth({ ...callRef.current, status: 'declined' });
        }
      })
      .on('broadcast', { event: 'call-end' }, ({ payload }: any) => {
        const cur = callRef.current;
        if (cur && cur.callId === payload?.callId) {
          setCallBoth({ ...cur, status: 'ended' });
        }
      })
      .on('broadcast', { event: 'typing' }, ({ payload }: any) => {
        if (payload?.user_id && payload.user_id !== myIdRef.current) {
          setOtherTyping(true);
          if (typingTimer.current) clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setOtherTyping(false), 2500);
        }
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls', filter: `conversation_id=eq.${conversationId}` },
        (payload: any) => {
          setCalls((prev) => {
            const row = payload.new as CallRow;
            if (prev.some((c) => c.id === row.id)) return prev;
            return [...prev, row].sort((a, b) => a.started_at.localeCompare(b.started_at));
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: `conversation_id=eq.${conversationId}` },
        (payload: any) => {
          setCalls((prev) =>
            prev.map((c) => (c.id === payload.new.id ? ({ ...c, ...(payload.new as CallRow) } as CallRow) : c))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [conversationId]);

  // online status refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // record timer
  useEffect(() => {
    if (recording) {
      setRecordSeconds(0);
      recordTimer.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } else if (recordTimer.current) {
      clearInterval(recordTimer.current);
      recordTimer.current = null;
    }
    return () => {
      if (recordTimer.current) clearInterval(recordTimer.current);
    };
  }, [recording]);

  const sendTyping = () => {
    const uid = myIdRef.current;
    if (!uid) return;
    const now = Date.now();
    if (now - typingFlag.current < 2500) return;
    typingFlag.current = now;
    supabase
      .channel(`chat2:${conversationId}`)
      .send({ type: 'broadcast', event: 'typing', payload: { user_id: uid } });
  };

  const send = async () => {
    const clean = text.trim();
    const uid = myIdRef.current;
    if (!clean || !uid || sending) return;
    setSending(true);

    // optimistic: render the bubble instantly, then sync with the DB row.
    // Realtime (or the swap below) reconciles ids; the placeholder is
    // removed if the insert fails.
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const temp: Message = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: uid,
      content: clean,
      media_url: null,
      msg_type: 'text',
      reaction: null,
      reply_to: replyTo?.id ?? null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      sender: null,
      reply: replyTo
        ? { content: replyTo.content, media_url: replyTo.media_url, msg_type: replyTo.msg_type }
        : null,
    };
    commitMessages((prev) => [...prev, enrich(temp)]);

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: uid,
        content: clean,
        msg_type: 'text',
        reply_to: replyTo?.id ?? null,
      })
      .select('id, created_at')
      .single();
    if (error || !data) {
      console.warn('send error', error?.message);
      commitMessages((prev) => prev.filter((m) => m.id !== tempId));
      setSending(false);
      return;
    }
    // swap the placeholder for the real row (keeps status + reply working)
    commitMessages((prev) =>
      prev.map((m) => (m.id === tempId ? { ...m, id: data.id, created_at: data.created_at ?? m.created_at } : m))
    );
    setText('');
    setReplyTo(null);
    setShowEmoji(false);
    setAttachOpen(false);
    setSending(false);
  };

  const pickMedia = async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const uid = myIdRef.current;
    if (!uid) return;
    setUploading(true);
    try {
      const isVideo = asset.mimeType?.startsWith('video') ?? false;
      const ext = asset.fileName?.split('.').pop() ?? (isVideo ? 'mp4' : 'jpg');
      const path = `chat/${conversationId}/${Date.now()}.${ext}`;
      const publicUrl = await uploadMedia(
        path,
        asset.uri,
        asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
      );
      const { error: msgErr } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_id: uid,
        media_url: publicUrl,
        msg_type: isVideo ? 'video' : 'image',
        view_once: viewOnce,
        reply_to: replyTo?.id ?? null,
      });
      if (msgErr) throw new Error(msgErr.message);
      setReplyTo(null);
      setViewOnce(false);
    } catch (e: any) {
      console.warn('media send error', e?.message);
    } finally {
      setUploading(false);
    }
  };

  const takePhoto = async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const uid = myIdRef.current;
    if (!uid) return;
    setUploading(true);
    try {
      const isVideo = asset.mimeType?.startsWith('video') ?? false;
      const ext = asset.fileName?.split('.').pop() ?? (isVideo ? 'mp4' : 'jpg');
      const path = `chat/${conversationId}/cam-${Date.now()}.${ext}`;
      const publicUrl = await uploadMedia(
        path,
        asset.uri,
        asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
      );
      const { error: msgErr } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_id: uid,
        media_url: publicUrl,
        msg_type: isVideo ? 'video' : 'image',
        view_once: viewOnce,
        reply_to: replyTo?.id ?? null,
      });
      if (msgErr) throw new Error(msgErr.message);
      setReplyTo(null);
      setViewOnce(false);
    } catch (e: any) {
      console.warn('camera send error', e?.message);
    } finally {
      setUploading(false);
    }
  };

  const toggleRecord = async () => {
    const uid = myIdRef.current;
    if (!uid) return;
    if (recording) {
      try {
        await recorder.stop();
        const uri = recorder.uri;
        setRecording(false);
        if (uri) await sendVoice(uri);
      } catch (e) {
        console.warn('stop record error', e);
        setRecording(false);
      }
    } else {
      try {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) return;
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        await recorder.record();
        setRecording(true);
      } catch (e) {
        console.warn('record error', e);
      }
    }
  };

  const sendVoice = async (uri: string) => {
    const uid = myIdRef.current;
    if (!uid) return;
    setUploading(true);
    try {
      const path = `chat/${conversationId}/voice-${Date.now()}.m4a`;
      const publicUrl = await uploadMedia(path, uri, 'audio/mp4');
      const { error: msgErr } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_id: uid,
        media_url: publicUrl,
        msg_type: 'voice',
      });
      if (msgErr) throw new Error(msgErr.message);
    } catch (e: any) {
      console.warn('voice send error', e?.message);
    } finally {
      setUploading(false);
    }
  };

  const sendGif = async (url: string) => {
    const uid = myIdRef.current;
    if (!uid) return;
    setGifOpen(false);
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const temp: Message = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: uid,
      content: null,
      media_url: url,
      msg_type: 'gif',
      reaction: null,
      reply_to: null,
      deleted_at: null,
      created_at: new Date().toISOString(),
      sender: null,
      reply: null,
    };
    commitMessages((prev) => [...prev, enrich(temp)]);
    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: uid,
        media_url: url,
        msg_type: 'gif',
      })
      .select('id, created_at')
      .single();
    if (error || !data) {
      console.warn('gif send error', error?.message);
      commitMessages((prev) => prev.filter((m) => m.id !== tempId));
      return;
    }
    commitMessages((prev) =>
      prev.map((m) => (m.id === tempId ? { ...m, id: data.id, created_at: data.created_at ?? m.created_at } : m))
    );
  };

  const setReaction = async (message: Message, reaction: string | null) => {
    setReactingTo(null);
    await supabase.from('messages').update({ reaction }).eq('id', message.id);
  };

  const deleteMessage = async (message: Message) => {
    setActionsFor(null);
    await supabase.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', message.id);
  };

  const statusFor = (message: Message) => {
    if (message.sender_id !== me || !other || message.deleted_at) return null;
    // view-once: WhatsApp-style "Opened" once any other participant viewed it
    if (message.view_once) {
      const opened = (message.viewed_by ?? []).some((id) => id !== me);
      return opened ? 'Opened' : 'Sent';
    }
    const readAt = other.last_read_at ? new Date(other.last_read_at).getTime() : 0;
    return readAt >= new Date(message.created_at).getTime() ? 'Seen' : 'Sent';
  };

  const openOnce = async (m: Message) => {
    if (!m.media_url) return;
    const meId = myIdRef.current;
    // reveal full-screen ONCE
    setViewer({ uri: m.media_url, video: m.msg_type === 'video', once: true });
    // the media dies the moment it's opened: viewed_by marks it, media_url
    // and content are nulled so NOBODY (including the sender) can ever see
    // it again, and the uploaded file is deleted from storage.
    const cur = m.viewed_by ?? [];
    const next = meId && !cur.includes(meId) ? [...cur, meId] : cur;
    await supabase
      .from('messages')
      .update({ viewed_by: next, media_url: null, content: null })
      .eq('id', m.id);
    try {
      const path = m.media_url.split('/object/public/')[1];
      if (path) await supabase.storage.from('media').remove([path]);
    } catch {}
  };

  // ---- per-user settings, theming + call helpers ----------------------
  const myPart = participants.find((p) => p.user_id === me) ?? null;
  const mySettings: ChatSettingsData | null = me
    ? {
        muted: myPart?.muted ?? false,
        mutedUntil: myPart?.muted_until ?? null,
        nickname: myPart?.nickname ?? null,
        chatColor: myPart?.chat_color ?? 'orange',
        wallpaper: myPart?.wallpaper ?? 'glow',
        disappearSeconds: conv?.disappear_seconds ?? null,
        soundEnabled: myPart?.sound_enabled ?? true,
      }
    : null;
  const palette = resolveChatPalette(mySettings?.chatColor);
  const wallpaperDef = WALLPAPERS.find((w) => w.key === (mySettings?.wallpaper ?? 'glow')) ?? WALLPAPERS[0];
  const mutedChat =
    !!mySettings?.muted && (!mySettings.mutedUntil || new Date(mySettings.mutedUntil).getTime() > Date.now());
  const displayName =
    mySettings?.nickname ?? (isGroup ? conv?.name ?? 'Group' : other ? `@${other.username}` : '');

  const applySettings = useCallback((patch: Partial<ChatSettingsData>) => {
    const map: Record<string, any> = {};
    if ('muted' in patch) map.muted = patch.muted;
    if ('mutedUntil' in patch) map.muted_until = patch.mutedUntil;
    if ('nickname' in patch) map.nickname = patch.nickname;
    if ('chatColor' in patch) map.chat_color = patch.chatColor;
    if ('wallpaper' in patch) map.wallpaper = patch.wallpaper;
    if ('soundEnabled' in patch) map.sound_enabled = patch.soundEnabled;
    if (Object.keys(map).length) {
      const uid = myIdRef.current;
      if (uid) {
        setParticipants((prev) => prev.map((p) => (p.user_id === uid ? { ...p, ...map } : p)));
        participantsRef.current = participantsRef.current.map((p) =>
          p.user_id === uid ? { ...p, ...map } : p
        );
      }
    }
    if ('disappearSeconds' in patch) {
      setConv((prev) => (prev ? { ...prev, disappear_seconds: patch.disappearSeconds ?? null } : prev));
    }
  }, []);

  const startCall = useCallback(
    (kind: 'audio' | 'video') => {
      const uid = myIdRef.current;
      if (!uid || callRef.current) return;
      const callee = participantsRef.current.find((p) => p.user_id !== uid);
      if (!callee) return;
      const callId = `${uid}-${Date.now()}`;
      callStartedAtRef.current = Date.now();
      setCallBoth({ dir: 'out', kind, status: 'ringing', callId });
      // persist the call for history; broadcast uses the client id both sides agree on
      supabase
        .rpc('calls_start', {
          p_conversation_id: conversationId,
          p_callee_id: callee.user_id,
          p_kind: kind,
        })
        .then((res: any) => {
          if (!res?.error && res?.data) callIdMapRef.current[callId] = res.data as string;
        });
      supabase
        .channel(`chat2:${conversationId}`)
        .send({ type: 'broadcast', event: 'call-offer', payload: { callId, kind, from: uid } });
    },
    [conversationId, setCallBoth]
  );

  const acceptCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    const dbId = callIdMapRef.current[cur.callId] ?? cur.callId;
    supabase.rpc('calls_set_status', { p_call_id: dbId, p_status: 'active' }).then(() => {});
    supabase
      .channel(`chat2:${conversationId}`)
      .send({ type: 'broadcast', event: 'call-accept', payload: { callId: cur.callId } });
    setCallBoth({ ...cur, status: 'active' });
  }, [conversationId, setCallBoth]);

  const declineCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    const dbId = callIdMapRef.current[cur.callId] ?? cur.callId;
    supabase.rpc('calls_set_status', { p_call_id: dbId, p_status: 'declined' }).then(() => {});
    supabase
      .channel(`chat2:${conversationId}`)
      .send({ type: 'broadcast', event: 'call-decline', payload: { callId: cur.callId } });
    setCallBoth(null);
  }, [conversationId, setCallBoth]);

  const endCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    const dbId = callIdMapRef.current[cur.callId] ?? cur.callId;
    const dur = Math.max(0, Math.round((Date.now() - callStartedAtRef.current) / 1000));
    const status = cur.status === 'active' ? 'completed' : cur.status === 'ringing' ? 'missed' : 'completed';
    supabase
      .rpc('calls_set_status', {
        p_call_id: dbId,
        p_status: status,
        p_duration: status === 'completed' ? dur : null,
      })
      .then(() => {});
    supabase
      .channel(`chat2:${conversationId}`)
      .send({ type: 'broadcast', event: 'call-end', payload: { callId: cur.callId } });
    setCallBoth(null);
  }, [conversationId, setCallBoth]);

  // auto-dismiss ended/declined calls
  useEffect(() => {
    if (call?.status === 'ended' || call?.status === 'declined') {
      const t = setTimeout(() => setCallBoth(null), 1800);
      return () => clearTimeout(t);
    }
  }, [call?.status, setCallBoth]);

  // end any active call when leaving the thread
  useEffect(() => {
    return () => {
      const cur = callRef.current;
      if (cur) {
        const dbId = callIdMapRef.current[cur.callId] ?? cur.callId;
        const dur = Math.max(0, Math.round((Date.now() - callStartedAtRef.current) / 1000));
        const status = cur.status === 'active' ? 'completed' : cur.status === 'ringing' ? 'missed' : 'completed';
        supabase
          .rpc('calls_set_status', {
            p_call_id: dbId,
            p_status: status,
            p_duration: status === 'completed' ? dur : null,
          })
          .then(() => {});
        supabase
          .channel(`chat2:${conversationId}`)
          .send({ type: 'broadcast', event: 'call-end', payload: { callId: cur.callId } });
      }
    };
  }, [conversationId]);

  // disappearing messages: hard-delete anything past the timer
  useEffect(() => {
    const secs = conv?.disappear_seconds;
    if (!secs) return;
    const sweep = () => {
      const cutoff = new Date(Date.now() - secs * 1000).toISOString();
      supabase
        .from('messages')
        .delete()
        .eq('conversation_id', conversationId)
        .lt('created_at', cutoff)
        .then(() => {});
    };
    sweep();
    const t = setInterval(sweep, 60000);
    return () => clearInterval(t);
  }, [conversationId, conv?.disappear_seconds]);

  // insert WhatsApp-style date dividers between calendar days, merging call history in
  const rows = useMemo(() => {
    const items: (Message | DateRow | CallRow)[] = [];
    const merged: { t: string; row: Message | CallRow }[] = [
      ...messages.map((m) => ({ t: m.created_at, row: m as Message })),
      ...calls.map((c) => ({ t: c.started_at, row: c as CallRow })),
    ].sort((a, b) => a.t.localeCompare(b.t));
    let prevDay = '';
    for (const x of merged) {
      const day = new Date(x.t).toDateString();
      if (day !== prevDay) {
        items.push({ type: 'date', label: dateLabel(new Date(x.t)) });
        prevDay = day;
      }
      items.push(x.row);
    }
    return items;
  }, [messages, calls]);

  const isDateRow = (x: Message | DateRow | CallRow): x is DateRow => 'type' in x && x.type === 'date';
  const isCallRow = (x: Message | DateRow | CallRow): x is CallRow => 'caller_id' in x;

  // jump to a message found via in-chat search (inverted list math)
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const idx = rows.findIndex((r) => !isDateRow(r) && r.id === messageId);
      if (idx < 0) return;
      const listIndex = rows.length - 1 - idx;
      listRef.current?.scrollToIndex({ index: listIndex, animated: true, viewPosition: 0.4 });
    },
    [rows]
  );

  const renderItem = ({ item }: { item: Message | DateRow | CallRow }) => {
    if (isDateRow(item)) {
      return (
        <View style={styles.dateWrap}>
          <Text style={styles.dateChip}>{item.label}</Text>
        </View>
      );
    }
    if (isCallRow(item)) {
      return <CallHistoryRow call={item} me={me} />;
    }
    return (
      <MessageBubble
        message={item}
        mine={item.sender_id === me}
        meId={me}
        isGroup={isGroup}
        reactingTo={reactingTo === item.id}
        actionsOpen={actionsFor === item.id}
        onOpenMedia={(uri) => setViewer({ uri, video: false })}
        onOpenOnce={openOnce}
        onLongPress={() => {
          setReactingTo(null);
          setActionsFor(actionsFor === item.id ? null : item.id);
        }}
        onReact={setReaction}
        onReply={() => {
          setReplyTo(item);
          setActionsFor(null);
        }}
        onDelete={() => deleteMessage(item)}
        status={statusFor(item)}
        palette={palette}
      />
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      {/* chat wallpaper — preset glows or the user's own photo */}
      <View style={[styles.wallpaper, { backgroundColor: wallpaperDef.base }]} pointerEvents="none">
        {isCustomWallpaper(mySettings?.wallpaper ?? '') ? (
          <Image source={{ uri: customWallpaperUri(mySettings!.wallpaper) }} style={styles.wallImage} resizeMode="cover" />
        ) : (
          wallpaperDef.glows.map((g, i) => (
            <View
              key={i}
              style={[
                styles.wallGlow,
                {
                  width: g.w,
                  height: g.h,
                  top: g.top,
                  left: g.left,
                  right: g.right,
                  backgroundColor: g.color,
                },
              ]}
            />
          ))
        )}
      </View>

      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerInfo}>
          <Avatar
            url={isGroup ? null : other?.avatar_url}
            name={isGroup ? conv?.name ?? 'G' : other?.username ?? 'G'}
            size={38}
            ring
            verified={!isGroup && !!other?.verified}
          />
          <View style={styles.headerTextBlock}>
            <View style={styles.headerNameRow}>
              <Text style={styles.headerName} numberOfLines={1}>
                {displayName}
              </Text>
              {!isGroup && !mySettings?.nickname && !!(other as any)?.verified && (
                <VerifiedBadge size={14} style={styles.verifiedInline} />
              )}
            </View>
            {otherTyping ? (
              <Text style={[styles.headerStatus, styles.typingText]}>Typing...</Text>
            ) : (
              <Text style={styles.headerStatus} numberOfLines={1}>
                {mutedChat
                  ? 'Muted'
                  : isGroup
                    ? `${participants.length} members`
                    : other && isOnline(other.last_seen_at)
                      ? 'Online'
                      : other
                        ? `Active ${timeAgo(other.last_seen_at)}`
                        : ''}
              </Text>
            )}
          </View>
        </View>
        <View style={styles.headerSpacer} />
        {!isGroup && other && (
          <>
            <Pressable style={styles.headerIconBtn} hitSlop={6} onPress={() => startCall('video')}>
              <Icon name="videocam-outline" size={21} color={colors.text} />
            </Pressable>
            <Pressable style={styles.headerIconBtn} hitSlop={6} onPress={() => startCall('audio')}>
              <Icon name="call-outline" size={18} color={colors.text} />
            </Pressable>
          </>
        )}
        <Pressable style={styles.headerIconBtn} hitSlop={6} onPress={() => setSettingsOpen(true)}>
          <Icon name="ellipsis-horizontal" size={20} color={colors.text} />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          ref={listRef}
          data={[...rows].reverse()}
          keyExtractor={(item) =>
            isDateRow(item) ? `date-${item.label}` : isCallRow(item) ? `call-${item.id}` : item.id
          }
          inverted
          contentContainerStyle={styles.listContent}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={styles.empty}>No messages yet. Say hi.</Text>}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingOlder ? (
              <ActivityIndicator color={colors.accent} style={styles.olderLoader} />
            ) : null
          }
          onScrollToIndexFailed={({ index }) => {
            // variable-height rows: estimate, then retry once settled
            listRef.current?.scrollToOffset({ offset: index * 90, animated: false });
            setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 }), 250);
          }}
        />
      )}

      {replyTo && (
        <View style={styles.replyBar}>
          <Text style={styles.replyLabel}>Replying to @{replyTo.sender?.username ?? 'unknown'}</Text>
          <Text style={styles.replyPreview} numberOfLines={1}>
            {replyTo.deleted_at ? 'Message deleted' : replyTo.content ?? (replyTo.msg_type === 'video' ? '🎬 Video' : '🖼 Image')}
          </Text>
          <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
            <Text style={styles.replyClose}>✕</Text>
          </Pressable>
        </View>
      )}

      {showEmoji && (
        <View style={styles.emojiBar}>
          {EMOJI_BAR.map((e) => (
            <Pressable key={e} style={styles.emojiBtn} onPress={() => setText((t) => t + e)}>
              <Text style={styles.emojiText}>{e}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {recording ? (
        <View style={styles.recordingBar}>
          <View style={styles.recDot} />
          <Text style={styles.recTime}>
            {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:
            {String(recordSeconds % 60).padStart(2, '0')}
          </Text>
          <Text style={styles.recHint}>Recording... tap stop to send</Text>
          <Pressable style={styles.recStop} onPress={toggleRecord}>
            <Text style={styles.recStopText}>Stop</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {attachOpen && (
            <View style={styles.attachPanel}>
              <Pressable style={styles.attachItem} onPress={pickMedia} disabled={uploading}>
                <View style={styles.attachIcon}>
                  <Icon name="images-outline" size={22} color={colors.accent} />
                </View>
                <Text style={styles.attachLabel}>Gallery</Text>
              </Pressable>
              <Pressable style={styles.attachItem} onPress={takePhoto} disabled={uploading}>
                <View style={styles.attachIcon}>
                  <Icon name="camera-outline" size={22} color={colors.accent} />
                </View>
                <Text style={styles.attachLabel}>Camera</Text>
              </Pressable>
              <Pressable
                style={styles.attachItem}
                onPress={() => {
                  setAttachOpen(false);
                  setGifOpen(true);
                }}
              >
                <View style={styles.attachIcon}>
                  <Icon name="film-outline" size={22} color={colors.accent} />
                </View>
                <Text style={styles.attachLabel}>GIF</Text>
              </Pressable>
              <Pressable
                style={styles.attachItem}
                onPress={() => {
                  setAttachOpen(false);
                  setShowEmoji(true);
                }}
              >
                <View style={styles.attachIcon}>
                  <Icon name="happy-outline" size={22} color={colors.accent} />
                </View>
                <Text style={styles.attachLabel}>Emoji</Text>
              </Pressable>
              <Pressable style={styles.attachItem} onPress={() => setViewOnce((v) => !v)}>
                <View style={[styles.attachIcon, viewOnce && styles.attachIconActive]}>
                  <Icon name="eye" size={22} color={viewOnce ? colors.bg : colors.accent} />
                </View>
                <Text style={[styles.attachLabel, viewOnce && styles.attachLabelActive]}>View once</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.inputBar}>
            <View style={[styles.field, attachOpen && styles.fieldOpen]}>
              <Pressable style={styles.plusBtn} onPress={() => setAttachOpen((o) => !o)} hitSlop={6}>
                <Icon name={attachOpen ? 'close' : 'add'} size={24} color={colors.accent} />
              </Pressable>
              <TextInput
                style={styles.input}
                placeholder="Message..."
                placeholderTextColor={colors.textFaint}
                value={text}
                onChangeText={(t) => {
                  setText(t);
                  sendTyping();
                }}
                onSubmitEditing={send}
              />
              <Pressable
                style={styles.emojiToggleBtn}
                onPress={() => {
                  setShowEmoji((s) => !s);
                  setAttachOpen(false);
                }}
                hitSlop={6}
              >
                <Icon name={showEmoji ? 'keypad' : 'happy-outline'} size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            {text.trim() ? (
              <Pressable style={[styles.sendCircle, sending && styles.btnDisabled]} onPress={send} disabled={sending}>
                <Icon name="arrow-up" size={22} color={colors.bg} />
              </Pressable>
            ) : (
              <Pressable style={styles.micBtn} onPress={toggleRecord} hitSlop={6}>
                <Icon name="mic" size={24} color={recording ? colors.danger : colors.text} />
              </Pressable>
            )}
          </View>
        </>
      )}

      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />

      {/* ⋮ chat settings (per-user: theme, wallpaper, mute, nickname…) */}
      <ChatSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        convId={conversationId}
        isGroup={isGroup}
        other={other ? { id: other.user_id, username: other.username, avatar_url: other.avatar_url } : null}
        settings={mySettings}
        onChange={applySettings}
        messages={messages}
        onJump={jumpToMessage}
        onBlocked={() => {
          setSettingsOpen(false);
          onBack();
        }}
      />

      {/* audio / video call */}
      <CallScreen
        state={call}
        name={displayName}
        avatarUrl={other?.avatar_url ?? null}
        soundOn={mySettings?.soundEnabled ?? true}
        onAccept={acceptCall}
        onDecline={declineCall}
        onEnd={endCall}
      />

      {/* full-screen media viewer (tap image/gif or reveal a view-once) */}
      {viewer && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setViewer(null)} statusBarTranslucent>
          <Pressable style={styles.viewerOverlay} onPress={() => setViewer(null)}>
            {viewer.video ? (
              <VideoView player={viewerPlayer} style={styles.viewerVideo} contentFit="contain" nativeControls />
            ) : (
              <Image source={{ uri: viewer.uri }} style={styles.viewerImage} resizeMode="contain" />
            )}
            <View style={styles.viewerClose} pointerEvents="none">
              <Icon name="close" size={22} color={colors.text} />
            </View>
          </Pressable>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

function VoiceBubble({ uri, mine }: { uri: string; mine: boolean }) {
  const player = useAudioPlayer(uri);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s: any) => {
      setPlaying(s.playing ?? false);
      if (s.duration && s.duration > 0) setDuration(s.duration);
    });
    return () => sub.remove();
  }, [player]);

  const toggle = () => {
    if (player.playing) player.pause();
    else player.play();
  };

  return (
    <Pressable style={styles.voiceRow} onPress={toggle}>
      <Icon
        name={playing ? 'pause' : 'play'}
        size={16}
        color={mine ? colors.bg : colors.cyan}
      />
      <View style={styles.voiceBar}>
        <View
          style={[
            styles.voiceFill,
            { width: `${Math.min(((player.currentTime ?? 0) / Math.max(duration, 1)) * 100, 100)}%` },
          ]}
        />
      </View>
      <Text style={[styles.voiceTime, mine && styles.voiceTimeMine]}>
        {duration ? `${Math.round(duration)}s` : '…'}
      </Text>
    </Pressable>
  );
}

function isOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 2 * 60 * 1000;
}

function timeAgo(lastSeen: string | null): string {
  if (!lastSeen) return 'recently';
  const mins = Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ago`;
}

function MessageBubble({
  message,
  mine,
  meId,
  isGroup,
  reactingTo,
  actionsOpen,
  onLongPress,
  onReact,
  onReply,
  onDelete,
  onOpenMedia,
  onOpenOnce,
  status,
  palette,
}: {
  message: Message;
  mine: boolean;
  meId: string | null;
  isGroup: boolean;
  reactingTo: boolean;
  actionsOpen: boolean;
  onLongPress: () => void;
  onReact: (m: Message, r: string | null) => void;
  onReply: () => void;
  onDelete: () => void;
  onOpenMedia: (uri: string) => void;
  onOpenOnce: (m: Message) => void;
  status: string | null;
  palette: ChatPalette;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }).start();
  }, []);

  // true view-once: the sender can't re-view either. Recipient gets a
  // "Tap to view" tile until they open it once; opening destroys the media,
  // after which BOTH sides see a permanent "Opened" tile.
  const isOnce = !!message.view_once;
  const iViewed = isOnce && !mine && !!meId && (message.viewed_by ?? []).includes(meId);
  const otherViewed = isOnce && mine && (message.viewed_by ?? []).some((id) => id !== meId);
  const onceOpened = iViewed || otherViewed;

  const player = useVideoPlayer(
    message.msg_type === 'video' && message.media_url && !message.deleted_at && !isOnce
      ? { uri: message.media_url }
      : null,
    (p) => {
      p.loop = true;
    }
  );

  return (
    <Animated.View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs, { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
      {!mine && isGroup && (
        <View style={styles.senderLine}>
          <Text style={styles.senderName}>@{message.sender?.username ?? 'unknown'}</Text>
          {!!(message.sender as any)?.verified && <VerifiedBadge size={11} glow={false} style={styles.verifiedInline} />}
        </View>
      )}
      <View style={styles.bubbleGroup}>
        <View
          style={[
            styles.tail,
            mine ? styles.tailMine : styles.tailTheirs,
            { backgroundColor: mine ? palette.tailMine : palette.tailTheirs },
          ]}
        />
        <Pressable
        style={[
          styles.bubble,
          mine ? styles.bubbleMine : styles.bubbleTheirs,
          { backgroundColor: mine ? palette.myBg : palette.theirBg },
        ]}
        onLongPress={onLongPress}
        delayLongPress={250}
      >
        {!!message.reply_to && !message.deleted_at && (
          <View style={styles.replyQuote}>
            <Text style={styles.replyQuoteText} numberOfLines={1}>
              {message.reply?.content ?? (message.reply?.msg_type === 'video' ? '🎬 Video' : '🖼 Image')}
            </Text>
          </View>
        )}
        {message.deleted_at ? (
          <Text style={styles.deletedText}>Message deleted</Text>
        ) : (
          <>
            {message.msg_type === 'image' && (message.media_url || (isOnce && onceOpened)) && (
              <View>
                {isOnce ? (
                  onceOpened ? (
                    <View style={[styles.msgImage, styles.onceTile]}>
                      <Icon name="eye-off" size={20} color={colors.textMuted} />
                      <Text style={styles.onceTileText}>Opened</Text>
                    </View>
                  ) : mine ? (
                    <View style={[styles.msgImage, styles.onceTile]}>
                      <Icon name="eye" size={20} color={colors.text} />
                      <Text style={styles.onceTileText}>View once</Text>
                    </View>
                  ) : (
                    <Pressable style={[styles.msgImage, styles.onceTile]} onPress={() => onOpenOnce(message)}>
                      <Icon name="eye" size={20} color={colors.text} />
                      <Text style={styles.onceTileText}>Tap to view</Text>
                    </Pressable>
                  )
                ) : (
                  <Pressable onPress={() => onOpenMedia(message.media_url!)}>
                    <Image source={{ uri: message.media_url! }} style={styles.msgImage} resizeMode="cover" />
                  </Pressable>
                )}
              </View>
            )}
            {message.msg_type === 'video' && (message.media_url || (isOnce && onceOpened)) &&
              (isOnce ? (
                onceOpened ? (
                  <View style={[styles.msgVideo, styles.onceTile]}>
                    <Icon name="eye-off" size={20} color={colors.textMuted} />
                    <Text style={styles.onceTileText}>Opened</Text>
                  </View>
                ) : mine ? (
                  <View style={[styles.msgVideo, styles.onceTile]}>
                    <Icon name="eye" size={20} color={colors.text} />
                    <Text style={styles.onceTileText}>View once</Text>
                  </View>
                ) : (
                  <Pressable style={[styles.msgVideo, styles.onceTile]} onPress={() => onOpenOnce(message)}>
                    <Icon name="eye" size={20} color={colors.text} />
                    <Text style={styles.onceTileText}>Tap to view</Text>
                  </Pressable>
                )
              ) : (
                <VideoView player={player} style={styles.msgVideo} contentFit="cover" nativeControls />
              ))}
            {message.msg_type === 'gif' && message.media_url && (
              <Pressable onPress={() => onOpenMedia(message.media_url!)}>
                <Image source={{ uri: message.media_url }} style={styles.msgGif} resizeMode="cover" />
              </Pressable>
            )}
            {message.msg_type === 'voice' && message.media_url && (
              <VoiceBubble uri={message.media_url} mine={mine} />
            )}
            {message.msg_type === 'text' && !!message.content && (
              <Text style={[styles.bubbleText, mine && { color: palette.myText }]}>{message.content}</Text>
            )}
            <View style={styles.msgMeta}>
              <Text style={[styles.msgTime, mine && styles.msgTimeMine, mine && { color: palette.myTime }]}>
                {fmtTime(message.created_at)}
              </Text>
              {mine && !!status && (
                <Icon
                  name={status === 'Sent' ? 'checkmark' : 'checkmark-done'}
                  size={13}
                  color={palette.myTime}
                />
              )}
            </View>
          </>
        )}
        </Pressable>
      </View>
      {/* reaction chip — WhatsApp style, below the text */}
      {!!message.reaction && !message.deleted_at && (
        <View style={[styles.reactionChip, mine ? styles.reactionChipMine : styles.reactionChipTheirs]}>
          <Text style={styles.reactionChipText}>{message.reaction}</Text>
        </View>
      )}

      {reactingTo && !message.deleted_at && (
        <View style={styles.reactionBar}>
          {REACTIONS.map((r) => (
            <Pressable
              key={r}
              style={[styles.reactionBtn, message.reaction === r && styles.reactionBtnActive]}
              onPress={() => onReact(message, message.reaction === r ? null : r)}
            >
              <Text style={styles.reactionEmoji}>{r}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {actionsOpen && !message.deleted_at && (
        <View style={styles.actionBar}>
          <Pressable style={styles.actionBtn} onPress={onReply}>
            <Text style={styles.actionText}>Reply</Text>
          </Pressable>
          {mine && (
            <Pressable style={styles.actionBtn} onPress={onDelete}>
              <Text style={[styles.actionText, styles.actionDanger]}>Delete</Text>
            </Pressable>
          )}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 10,
    backgroundColor: colors.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  backBtn: {
    width: 52,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  headerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTextBlock: {
    flex: 1,
  },
  headerSpacer: {
    width: 2,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  headerAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  headerAvatarText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  headerName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  headerStatus: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  typingText: {
    color: colors.accent,
  },
  loader: {
    marginTop: 30,
  },
  olderLoader: {
    paddingVertical: 14,
  },
  // chat wallpaper — preset glows or the user's own photo
  wallpaper: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  wallImage: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0.35,
  },
  wallGlow: {
    position: 'absolute',
    borderRadius: 999,
  },
  wallGlowA: {
    width: 340,
    height: 340,
    top: '28%',
    left: -150,
    backgroundColor: 'rgba(255,122,26,0.05)',
  },
  wallGlowB: {
    width: 300,
    height: 300,
    bottom: '18%',
    right: -130,
    backgroundColor: 'rgba(99,102,241,0.06)',
  },
  wallGlowC: {
    width: 220,
    height: 220,
    top: '4%',
    right: -90,
    backgroundColor: 'rgba(56,189,248,0.05)',
  },
  // WhatsApp-style date dividers
  dateWrap: {
    alignItems: 'center',
    marginVertical: 10,
  },
  dateChip: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: colors.glass,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  listContent: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  row: {
    marginBottom: 14,
    maxWidth: '88%',
  },
  rowMine: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  rowTheirs: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  senderName: {
    color: colors.textMuted,
    fontSize: 11,
  },
  senderLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
    gap: 4,
  },
  verifiedInline: {
    marginLeft: 2,
  },
  headerNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bubbleGroup: {
    position: 'relative',
  },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  bubbleMine: {
    backgroundColor: colors.accent,
    borderTopRightRadius: 5,
    ...shadows.glow,
  },
  bubbleTheirs: {
    backgroundColor: '#1D2740',
    borderTopLeftRadius: 5,
  },
  // WhatsApp-style bubble tail (rotated square at the top corner)
  tail: {
    position: 'absolute',
    top: 0,
    width: 10,
    height: 10,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
  tailMine: {
    right: -5,
    backgroundColor: colors.accent,
  },
  tailTheirs: {
    left: -5,
    backgroundColor: '#1D2740',
  },
  // time + status ticks, inside the bubble bottom-right (WhatsApp style)
  msgMeta: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 3,
    marginTop: 4,
  },
  msgTime: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10.5,
    fontWeight: '600',
  },
  msgTimeMine: {
    color: 'rgba(4,7,15,0.72)',
  },
  bubbleText: {
    color: colors.logoWhite,
    fontSize: 15,
    lineHeight: 20,
  },
  // WhatsApp-style reaction chip — floats at the bottom edge of the bubble
  reactionChip: {
    position: 'relative',
    marginTop: -10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    zIndex: 3,
    elevation: 3,
  },
  reactionChipMine: {
    alignSelf: 'flex-end',
    marginRight: 8,
  },
  reactionChipTheirs: {
    alignSelf: 'flex-start',
    marginLeft: 8,
  },
  reactionChipText: {
    fontSize: 14,
    lineHeight: 17,
  },
  // view-once media (WhatsApp style)
  onceTile: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  onceTileText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 6,
  },
  onceBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(4,7,15,0.72)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 9,
  },
  onceBadgeText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '800',
  },
  // full-screen media viewer
  viewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
  viewerVideo: {
    width: '100%',
    height: '100%',
  },
  viewerClose: {
    position: 'absolute',
    top: TOP_INSET + 14,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleReaction: {
    fontSize: 18,
    marginTop: 4,
  },
  deletedText: {
    color: colors.textFaint,
    fontSize: 13,
    fontStyle: 'italic',
  },
  replyQuote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.cyan,
    paddingLeft: 8,
    marginBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 6,
    paddingVertical: 3,
    paddingRight: 8,
  },
  replyQuoteText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  msgImage: {
    width: 210,
    height: 260,
    borderRadius: radius.sm,
  },
  msgVideo: {
    width: 210,
    height: 260,
    borderRadius: radius.sm,
  },
  msgGif: {
    width: 200,
    height: 200,
    borderRadius: radius.sm,
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 160,
    paddingVertical: 2,
  },
  voiceIcon: {
    color: colors.textMuted,
    fontSize: 18,
    marginRight: 8,
  },
  voiceIconMine: {
    color: colors.bg,
  },
  voiceBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  voiceFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.cyan,
  },
  voiceTime: {
    color: colors.textMuted,
    fontSize: 11,
    marginLeft: 8,
    minWidth: 28,
    textAlign: 'right',
  },
  voiceTimeMine: {
    color: colors.bg,
  },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingBottom: 26,
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.danger,
    marginRight: 8,
  },
  recTime: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  recHint: {
    color: colors.textMuted,
    fontSize: 13,
    flex: 1,
    marginLeft: 12,
  },
  recStop: {
    backgroundColor: colors.danger,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  recStopText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '700',
  },
  micRecording: {
    borderColor: colors.danger,
  },
  statusText: {
    color: colors.textFaint,
    fontSize: 10,
    marginTop: 3,
  },
  reactionBar: {
    flexDirection: 'row',
    marginTop: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  reactionBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  reactionBtnActive: {
    backgroundColor: colors.borderStrong,
  },
  reactionEmoji: {
    fontSize: 18,
  },
  actionBar: {
    flexDirection: 'row',
    marginTop: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  actionText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  actionDanger: {
    color: colors.danger,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  replyLabel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '600',
  },
  replyPreview: {
    color: colors.textMuted,
    fontSize: 12,
    flex: 1,
    marginHorizontal: 10,
  },
  replyClose: {
    color: colors.textMuted,
    fontSize: 14,
    padding: 4,
  },
  emojiBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 6,
    justifyContent: 'space-around',
  },
  emojiBtn: {
    padding: 4,
  },
  emojiText: {
    fontSize: 22,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 26,
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    paddingLeft: 6,
    paddingRight: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldOpen: {
    borderColor: colors.accent,
  },
  plusBtn: {
    padding: 6,
  },
  emojiToggleBtn: {
    padding: 6,
  },
  input: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 6,
    color: colors.text,
    fontSize: 15,
  },
  micBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    ...shadows.glow,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  attachPanel: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  attachItem: {
    alignItems: 'center',
    width: 72,
  },
  attachIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIconActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  attachLabelActive: {
    color: colors.accent,
    fontWeight: '700',
  },
  attachLabel: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 6,
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 60,
  },
});
