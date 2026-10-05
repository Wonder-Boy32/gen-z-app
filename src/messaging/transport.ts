// src/messaging/transport.ts
// ------------------------------------------------------------------
// Two transports, chosen per event type — because durable events and
// ephemeral signals have opposite requirements.
//
//   postgres_changes  → messages, reactions, receipts. Durable, and
//                       authorised by RLS: the database decides who
//                       receives what.
//   broadcast         → typing / recording / presence. Never written
//                       to disk, expires naturally, zero DB writes.
//
// Typing must never be a table. A busy 200-person group would write
// thousands of rows a minute just to say someone is fumbling with
// their keyboard.
// ------------------------------------------------------------------

import { supabase } from '../supabase/client';
import type { ConnectionStatus } from './types';

/** Minimal structural shape — avoids reaching into supabase-js internals. */
interface PgPayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

export interface TypingSignal {
  userId: string;
  kind: 'typing' | 'recording' | 'uploading';
  on: boolean;
}

export type CallKind = 'audio' | 'video';

/**
 * Ephemeral call signalling.
 *
 * Carried on the SAME private channel as typing, and that is a deliberate
 * constraint rather than convenience. The RLS policy that authorises private
 * topics (see supabase/messaging_v2_realtime.sql) enumerates exactly
 * 'conv:' || conversation_id — so a second topic such as 'calls:<uuid>' would be
 * rejected at subscribe time unless a new migration widened the policy.
 * Riding the existing channel keeps calls working with no schema change.
 *
 * Signalling is ephemeral; the `calls` table is what makes a call durable.
 */
export type CallSignal =
  | {
      type: 'offer';
      callId: string;
      kind: CallKind;
      from: string;
      /**
       * The `calls` row id, once calls_start() has returned.
       *
       * This is carried in the offer because the CALLEE has no other way to
       * learn it. Without it the callee cannot persist accept/decline/missed —
       * it only knows its own client-generated callId, which is not a UUID, and
       * calls_set_status(p_call_id uuid, …) rejects it. The old implementation
       * fell back to the client id, so every callee-side update silently failed
       * and calls stayed 'ringing' in history forever.
       */
      dbId?: string;
    }
  | { type: 'accept'; callId: string }
  | { type: 'decline'; callId: string }
  | { type: 'end'; callId: string };

export interface TransportHandlers {
  onMessageUpsert: (row: Record<string, unknown>) => void;
  onMessageDelete: (row: Record<string, unknown>) => void;
  onReactionChange: () => void;
  onTyping: (signal: TypingSignal) => void;
  onCallSignal: (signal: CallSignal) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export interface Subscription {
  /** Broadcast a transient signal. Never awaited; failure is harmless. */
  sendTyping: (kind: TypingSignal['kind'], on: boolean) => void;
  /** Broadcast a call signal on the same private channel. */
  sendCall: (signal: CallSignal) => void;
  unsubscribe: () => void;
}

const TYPING_EVENT = 'typing';
const CALL_EVENT = 'call';

/**
 * Validate before trusting. A broadcast payload is attacker-controllable in
 * principle, and a malformed one must never be allowed to put the UI into a
 * ringing state — so anything that does not match the shape exactly is dropped
 * rather than coerced.
 */
function parseCallSignal(raw: unknown): CallSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const callId = p.callId;
  if (typeof callId !== 'string' || !callId) return null;

  switch (p.type) {
    case 'offer': {
      if (typeof p.from !== 'string' || !p.from) return null;
      if (p.kind !== 'audio' && p.kind !== 'video') return null;
      const dbId = typeof p.dbId === 'string' && p.dbId ? p.dbId : undefined;
      return { type: 'offer', callId, kind: p.kind, from: p.from, dbId };
    }
    case 'accept':
    case 'decline':
    case 'end':
      return { type: p.type, callId };
    default:
      return null;
  }
}

function mapChannelStatus(status: string): ConnectionStatus {
  switch (status) {
    case 'SUBSCRIBED':
      return 'online';
    case 'CHANNEL_ERROR':
    case 'TIMED_OUT':
      return 'reconnecting';
    case 'CLOSED':
      return 'offline';
    default:
      return 'reconnecting';
  }
}

export function subscribeConversation(
  conversationId: string,
  userId: string,
  handlers: TransportHandlers
): Subscription {
  // `private: true` is REQUIRED, not cosmetic. By default a Supabase
  // broadcast channel is public: anyone who learns the conversation UUID
  // can subscribe to it. Private channels are authorised through RLS on
  // realtime.messages, which allows a user to join a topic only if they
  // are a participant of that conversation.
  //   → see supabase/messaging_v2_realtime.sql
  // If that policy is missing, this subscribe will fail authorisation.
  const channel = supabase
    .channel(`conv:${conversationId}`, { config: { private: true } })
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload: unknown) => {
        const p = payload as PgPayload;
        if (p.eventType === 'DELETE') {
          handlers.onMessageDelete(p.old ?? {});
        } else {
          handlers.onMessageUpsert(p.new ?? {});
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'message_reactions',
      },
      () => {
        // The reaction table has no conversation_id to filter on, so the
        // engine re-reads reactions for the visible window. Cheap, and it
        // avoids a denormalised column just to make filtering easy.
        handlers.onReactionChange();
      }
    )
    .on('broadcast', { event: TYPING_EVENT }, (msg: unknown) => {
      const payload = (msg as { payload?: Record<string, unknown> }).payload;
      if (!payload) return;
      const from = payload.userId;
      const kind = payload.kind;
      const on = payload.on;
      if (typeof from !== 'string' || from === userId) return;
      if (kind !== 'typing' && kind !== 'recording' && kind !== 'uploading') return;
      if (typeof on !== 'boolean') return;
      handlers.onTyping({ userId: from, kind, on });
    })
    .on('broadcast', { event: CALL_EVENT }, (msg: unknown) => {
      const signal = parseCallSignal((msg as { payload?: unknown })?.payload);
      if (!signal) return;
      // Ignore our own echo. The channel delivers to every subscriber
      // including the sender, so without this a caller would ring itself.
      if (signal.type === 'offer' && signal.from === userId) return;
      handlers.onCallSignal(signal);
    });

  channel.subscribe((status: string) => {
    handlers.onStatus(mapChannelStatus(status));
  });

  return {
    sendTyping: (kind, on) => {
      // Fire and forget. A dropped typing ping is not worth a retry, and
      // awaiting it would put network latency on the keystroke path.
      void channel.send({
        type: 'broadcast',
        event: TYPING_EVENT,
        payload: { userId, kind, on },
      });
    },
    sendCall: (signal) => {
      // Fire and forget, like typing. If a signal is lost the call's durable
      // row in `calls` is still there; the UI recovers from the table rather
      // than from a retry queue.
      void channel.send({
        type: 'broadcast',
        event: CALL_EVENT,
        payload: signal,
      });
    },
    unsubscribe: () => {
      void supabase.removeChannel(channel);
    },
  };
}
