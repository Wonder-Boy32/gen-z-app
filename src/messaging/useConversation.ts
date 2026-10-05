// src/messaging/useConversation.ts
// ------------------------------------------------------------------
// The bridge between the engine and React.
//
// This is the ONLY React-aware part of the messaging module (besides
// the registry types). Screens use this hook and never touch Supabase
// for conversation data again.
// ------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentUserId, type PollDraft } from './api';
import { ConversationEngine, createEngine } from './engine';
import type { CallSignal, TypingSignal } from './transport';
import {
  emptyTimeline,
  type Message,
  type MessageBody,
  type MessageKind,
  type SendOptions,
  type TimelineState,
} from './types';

export interface UseConversationResult {
  state: TimelineState;
  /** who is currently typing/recording, with stale entries auto-expired */
  typing: TypingSignal[];
  sendText: (text: string, options?: SendOptions) => Promise<void>;
  /** send any non-text kind (image, voice, video, file, …) */
  send: (kind: MessageKind, body: MessageBody, options?: SendOptions) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  edit: (messageId: string, body: MessageBody) => Promise<void>;
  remove: (messageId: string, forEveryone: boolean) => Promise<void>;
  /** pin / unpin a message, then refresh the pinned list */
  pin: (messageId: string, pinned: boolean) => Promise<void>;
  /** the thread's pins, most recent first */
  pinned: Message[];
  loadPinned: () => Promise<Message[]>;
  /** leave exactly one unread on this thread */
  markUnread: () => Promise<void>;
  forward: (message: Message, targetConversationId: string) => Promise<void>;
  createPoll: (draft: PollDraft) => Promise<void>;
  emitPresence: (kind: 'recording' | 'uploading', on: boolean) => void;
  /** subscribe to incoming call signals; returns an unsubscribe */
  onCallSignal: (handler: (signal: CallSignal) => void) => () => void;
  /** broadcast a call signal (offer / accept / decline / end) */
  sendCall: (signal: CallSignal) => void;
  loadOlder: () => Promise<void>;
  setTyping: (active: boolean) => void;
  /** convenience: does this message belong to the viewer? */
  isMine: (message: Message) => boolean;
}

/** Typing signals are transient; drop them if no refresh arrives. */
const TYPING_TTL_MS = 6000;

export function useConversation(conversationId: string | null): UseConversationResult {
  const [state, setState] = useState<TimelineState>(emptyTimeline());
  const [typing, setTypingSignals] = useState<TypingSignal[]>([]);
  const [pinned, setPinned] = useState<Message[]>([]);
  const engineRef = useRef<ConversationEngine | null>(null);
  const userIdRef = useRef<string | null>(null);

  // Call handlers are held here rather than on the engine because the screen
  // registers during its own mount, which can happen before the engine exists.
  // The engine fans into this set once it opens, so late registration still works.
  const callHandlersRef = useRef(new Set<(s: CallSignal) => void>());

  useEffect(() => {
    if (!conversationId) {
      setState(emptyTimeline());
      setTypingSignals([]);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let unlistenTyping: (() => void) | null = null;
    let unlistenCalls: (() => void) | null = null;
    const engine = createEngine();

    const typingSeen = new Map<string, { signal: TypingSignal; at: number }>();

    (async () => {
      const uid = await currentUserId();
      if (cancelled || !uid) return;

      userIdRef.current = uid;
      engineRef.current = engine;

      unsubscribe = engine.subscribe(setState);

      unlistenTyping = engine.onTyping((signal) => {
        if (!signal.on) typingSeen.delete(signal.userId);
        else typingSeen.set(signal.userId, { signal, at: Date.now() });

        const live = [...typingSeen.values()]
          .filter((e) => Date.now() - e.at < TYPING_TTL_MS)
          .map((e) => e.signal);
        setTypingSignals(live);

        if (signal.on) {
          // Re-publish on a timer so the indicator expires on its own if the
          // sender's app was killed mid-typing.
          setTimeout(() => {
            if (cancelled) return;
            setTypingSignals((prev) =>
              prev.filter((t) => t.userId !== signal.userId || Date.now() - (typingSeen.get(signal.userId)?.at ?? 0) < TYPING_TTL_MS)
            );
          }, TYPING_TTL_MS + 50);
        }
      });

      unlistenCalls = engine.onCallSignal((signal) => {
        callHandlersRef.current.forEach((h) => h(signal));
      });

      await engine.open(conversationId, uid);

      // Pins live outside the paginated window, so fetch them separately.
      const pins = await engine.loadPinned();
      if (!cancelled) setPinned(pins);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      unlistenTyping?.();
      unlistenCalls?.();
      engine.close();
      if (engineRef.current === engine) engineRef.current = null;
      typingSeen.clear();
    };
  }, [conversationId]);

  const sendText = useCallback(async (text: string, options?: SendOptions) => {
    await engineRef.current?.sendText(text, options);
  }, []);

  const send = useCallback(async (kind: MessageKind, body: MessageBody, options?: SendOptions) => {
    await engineRef.current?.send(kind, body, options);
  }, []);

  const retry = useCallback(async (clientMessageId: string) => {
    await engineRef.current?.retry(clientMessageId);
  }, []);

  const react = useCallback(async (messageId: string, emoji: string) => {
    await engineRef.current?.react(messageId, emoji);
  }, []);

  const edit = useCallback(async (messageId: string, body: MessageBody) => {
    await engineRef.current?.edit(messageId, body);
  }, []);

  const remove = useCallback(async (messageId: string, forEveryone: boolean) => {
    await engineRef.current?.delete(messageId, forEveryone);
  }, []);

  const loadPinned = useCallback(async () => {
    const list = (await engineRef.current?.loadPinned()) ?? [];
    setPinned(list);
    return list;
  }, []);

  const pin = useCallback(async (messageId: string, isPinned: boolean) => {
    await engineRef.current?.pin(messageId, isPinned);
    const list = (await engineRef.current?.loadPinned()) ?? [];
    setPinned(list);
  }, []);

  const markUnread = useCallback(async () => {
    await engineRef.current?.markUnread();
  }, []);

  const forward = useCallback(async (message: Message, targetConversationId: string) => {
    await engineRef.current?.forward(message, targetConversationId);
  }, []);

  const createPoll = useCallback(
    async (draft: PollDraft) => {
      if (!conversationId) return;
      await engineRef.current?.createPoll(conversationId, draft);
    },
    [conversationId]
  );

  const emitPresence = useCallback((kind: 'recording' | 'uploading', on: boolean) => {
    engineRef.current?.emitPresence(kind, on);
  }, []);

  const onCallSignal = useCallback((handler: (signal: CallSignal) => void) => {
    callHandlersRef.current.add(handler);
    return () => {
      callHandlersRef.current.delete(handler);
    };
  }, []);

  const sendCall = useCallback((signal: CallSignal) => {
    engineRef.current?.sendCall(signal);
  }, []);

  const loadOlder = useCallback(async () => {
    await engineRef.current?.loadOlder();
  }, []);

  const setTyping = useCallback((active: boolean) => {
    engineRef.current?.setTyping(active);
  }, []);

  const isMine = useCallback(
    (message: Message) => !!userIdRef.current && message.senderId === userIdRef.current,
    []
  );

  return useMemo(
    () => ({
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
      loadPinned,
      markUnread,
      forward,
      createPoll,
      emitPresence,
      onCallSignal,
      sendCall,
      loadOlder,
      setTyping,
      isMine,
    }),
    [
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
      loadPinned,
      markUnread,
      forward,
      createPoll,
      emitPresence,
      onCallSignal,
      sendCall,
      loadOlder,
      setTyping,
      isMine,
    ]
  );
}
