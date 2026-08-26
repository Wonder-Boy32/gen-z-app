import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import LogoHeader from '../components/LogoHeader';
import GifPicker from '../components/GifPicker';
import { uploadMedia } from '../utils/upload';
import Avatar from '../components/Avatar';

const REACTIONS = ['❤️', '😂', '🔥', '👏', '😮', '💯'];
const EMOJI_BAR = ['😀', '😂', '😍', '🔥', '😮', '💯', '👍', '🙏', '😭', '🥳'];

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
  sender: { username: string } | null;
  reply: { content: string | null; media_url: string | null; msg_type: string } | null;
};

type Participant = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  last_seen_at: string | null;
  last_read_at: string | null;
};

type Conv = {
  type: string;
  name: string | null;
  avatar_url: string | null;
};

export default function ChatThread({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
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
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const myIdRef = useRef<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingFlag = useRef(0);

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

    const [{ data: convRows }, { data: partRows }, { data: msgRows }] = await Promise.all([
      supabase.from('conversations').select('type, name, avatar_url').eq('id', conversationId).maybeSingle(),
      supabase
        .from('conversation_participants')
        .select('user_id, last_read_at, profile:profiles(username, avatar_url, last_seen_at)')
        .eq('conversation_id', conversationId),
      supabase
        .from('messages')
        .select('*, sender:profiles(username), reply:messages!messages_reply_to_fkey(content, media_url, msg_type)')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }),
    ]);

    setConv((convRows as Conv | null) ?? null);
    setParticipants(
      ((partRows ?? []) as any[]).map((p) => ({
        user_id: p.user_id,
        username: p.profile?.username ?? 'unknown',
        avatar_url: p.profile?.avatar_url ?? null,
        last_seen_at: p.profile?.last_seen_at ?? null,
        last_read_at: p.last_read_at ?? null,
      }))
    );
    setMessages((msgRows ?? []) as Message[]);
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
          setMessages((prev) => (prev.some((m) => m.id === payload.new.id) ? prev : [...prev, payload.new as Message]));
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
          setMessages((prev) => prev.map((m) => (m.id === payload.new.id ? { ...m, ...(payload.new as Message) } : m)));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversation_participants', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          setParticipants((prev) =>
            prev.map((p) =>
              p.user_id === payload.new.user_id ? { ...p, last_read_at: payload.new.last_read_at ?? p.last_read_at } : p
            )
          );
        }
      )
      .on('broadcast', { event: 'typing' }, ({ payload }: any) => {
        if (payload?.user_id && payload.user_id !== myIdRef.current) {
          setOtherTyping(true);
          if (typingTimer.current) clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setOtherTyping(false), 2500);
        }
      })
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
    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: uid,
      content: clean,
      msg_type: 'text',
      reply_to: replyTo?.id ?? null,
    });
    if (error) console.warn('send error', error.message);
    setText('');
    setReplyTo(null);
    setShowEmoji(false);
    setSending(false);
  };

  const pickMedia = async () => {
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
        reply_to: replyTo?.id ?? null,
      });
      if (msgErr) throw new Error(msgErr.message);
      setReplyTo(null);
    } catch (e: any) {
      console.warn('media send error', e?.message);
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
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: uid,
      media_url: url,
      msg_type: 'gif',
    });
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
    const readAt = other.last_read_at ? new Date(other.last_read_at).getTime() : 0;
    return readAt >= new Date(message.created_at).getTime() ? 'Seen' : 'Sent';
  };

  const renderItem = ({ item }: { item: Message }) => (
    <MessageBubble
      message={item}
      mine={item.sender_id === me}
      isGroup={isGroup}
      reactingTo={reactingTo === item.id}
      actionsOpen={actionsFor === item.id}
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
    />
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Avatar
            url={isGroup ? null : other?.avatar_url}
            name={isGroup ? conv?.name ?? 'G' : other?.username ?? 'G'}
            size={34}
            ring
          />
          <Text style={styles.headerName} numberOfLines={1}>
            {isGroup ? conv?.name ?? 'Group' : `@${other?.username ?? 'unknown'}`}
          </Text>
          {otherTyping ? (
            <Text style={[styles.headerStatus, styles.typingText]}>Typing...</Text>
          ) : (
            <Text style={styles.headerStatus}>
              {isGroup
                ? `${participants.length} members`
                : other && isOnline(other.last_seen_at)
                  ? 'Online'
                  : other
                    ? `Active ${timeAgo(other.last_seen_at)}`
                    : ''}
            </Text>
          )}
        </View>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <FlatList
          data={[...messages].reverse()}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={styles.listContent}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={styles.empty}>No messages yet. Say hi.</Text>}
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
        <View style={styles.inputBar}>
          <Pressable style={styles.attachBtn} onPress={pickMedia} disabled={uploading} hitSlop={6}>
            <Text style={styles.attachText}>{uploading ? '…' : '+'}</Text>
          </Pressable>
          <Pressable style={styles.attachBtn} onPress={() => setGifOpen(true)} hitSlop={6}>
            <Text style={styles.attachText}>🎞</Text>
          </Pressable>
          <Pressable
            style={[styles.attachBtn, recording && styles.micRecording]}
            onPress={toggleRecord}
            hitSlop={6}
          >
            <Text style={styles.attachText}>🎙</Text>
          </Pressable>
          <Pressable
            style={[styles.emojiToggle, showEmoji && styles.emojiToggleActive]}
            onPress={() => setShowEmoji((s) => !s)}
            hitSlop={6}
          >
            <Text style={styles.emojiToggleText}>☺</Text>
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
            style={[styles.sendBtn, (!text.trim() || sending) && styles.btnDisabled]}
            onPress={send}
            disabled={!text.trim() || sending}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      )}

      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onPick={sendGif} />
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
      <Text style={[styles.voiceIcon, mine && styles.voiceIconMine]}>{playing ? '⏸' : '▶'}</Text>
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
  isGroup,
  reactingTo,
  actionsOpen,
  onLongPress,
  onReact,
  onReply,
  onDelete,
  status,
}: {
  message: Message;
  mine: boolean;
  isGroup: boolean;
  reactingTo: boolean;
  actionsOpen: boolean;
  onLongPress: () => void;
  onReact: (m: Message, r: string | null) => void;
  onReply: () => void;
  onDelete: () => void;
  status: string | null;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }).start();
  }, []);

  const player = useVideoPlayer(
    message.msg_type === 'video' && message.media_url && !message.deleted_at ? { uri: message.media_url } : null,
    (p) => {
      p.loop = true;
    }
  );

  return (
    <Animated.View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs, { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
      {!mine && isGroup && <Text style={styles.senderName}>@{message.sender?.username ?? 'unknown'}</Text>}
      <Pressable
        style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
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
            {message.msg_type === 'image' && message.media_url && (
              <Image source={{ uri: message.media_url }} style={styles.msgImage} resizeMode="cover" />
            )}
            {message.msg_type === 'video' && message.media_url && (
              <VideoView player={player} style={styles.msgVideo} contentFit="cover" nativeControls />
            )}
            {message.msg_type === 'gif' && message.media_url && (
              <Image source={{ uri: message.media_url }} style={styles.msgGif} resizeMode="cover" />
            )}
            {message.msg_type === 'voice' && message.media_url && (
              <VoiceBubble uri={message.media_url} mine={mine} />
            )}
            {message.msg_type === 'text' && !!message.content && (
              <Text style={styles.bubbleText}>{message.content}</Text>
            )}
            {!!message.reaction && <Text style={styles.bubbleReaction}>{message.reaction}</Text>}
          </>
        )}
      </Pressable>
      {mine && !!status && <Text style={styles.statusText}>{status}</Text>}

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
    width: 64,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
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
    flex: 1,
  },
  listContent: {
    padding: 14,
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
    marginBottom: 3,
  },
  bubble: {
    borderRadius: radius.md,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  bubbleMine: {
    backgroundColor: colors.accent,
    ...shadows.glow,
  },
  bubbleTheirs: {
    backgroundColor: colors.surfaceAlt,
  },
  bubbleText: {
    color: colors.logoWhite,
    fontSize: 15,
    lineHeight: 20,
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
    padding: 10,
    paddingBottom: 26,
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  attachBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  attachText: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '700',
  },
  emojiToggle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  emojiToggleActive: {
    borderWidth: 1,
    borderColor: colors.accent,
  },
  emojiToggleText: {
    color: colors.text,
    fontSize: 15,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendBtn: {
    marginLeft: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  sendText: {
    color: colors.bg,
    fontSize: 14,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 60,
  },
});
