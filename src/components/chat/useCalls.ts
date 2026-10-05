// ============================================================
// src/components/chat/useCalls.ts
// ============================================================
// The call state machine for a conversation.
//
// WHERE THIS CAME FROM
// The Messaging Paradise migration moved the conversation surface from
// screens/ChatThread.tsx to components/chat/ConversationScreen.tsx. The new
// screen never received the call UI, so the voice and video buttons vanished
// from the header even though CallScreen, CallHistoryRow and the whole calls
// schema were still sitting there, orphaned. This restores that behaviour.
//
// SIGNALLING vs PERSISTENCE — two different jobs
//
//   signalling  → ephemeral broadcast on the engine's existing private channel
//                 (transport.ts). Must be instant; may be lost harmlessly.
//   persistence → the `calls` table via calls_start / calls_set_status.
//                 Survives reloads and is what puts a call in the history.
//
// Neither can replace the other, which is why both are here.
//
// This hook owns no transport of its own. `send` is handed in by the screen,
// which already has one from useConversation — the RLS policy authorises only
// 'conv:' topics, so opening a second channel would simply fail to authorise.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../supabase/client';
import type { CallKind, CallSignal } from '../../messaging/transport';
import type { CallState } from './CallScreen';

/** How long the caller lets it ring before giving up. */
const RING_TIMEOUT_MS = 35_000;

/** How long an ended/declined call stays on screen before dismissing. */
const DISMISS_MS = 1_800;

/**
 * MASTER SWITCH for calling. Currently OFF, deliberately.
 *
 * WHY IT IS OFF
 * The feature below is complete and verified EXCEPT for the media layer. There
 * is no WebRTC anywhere in this project — no RTCPeerConnection, no media SDK —
 * so tapping call would ring the other phone, connect, run a timer, and carry
 * NO audio and NO video. A call button that cannot call is worse than no button:
 * it teaches users the app is broken.
 *
 * WHAT IS ALREADY BUILT AND WORKING (all of it kept, none of it wasted):
 *   - signalling: offer / accept / decline / end, broadcast on the engine's
 *     existing private `conv:` channel — the same one typing uses
 *   - persistence: the `calls` table via calls_start / calls_set_status
 *     (confirmed present and correctly locked to `authenticated` in production)
 *   - history: call entries interleaved into the thread by time
 *   - a caller-side 35s ring timeout recorded as a missed call
 *
 * WHAT IS MISSING
 * Only the audio/video transport. That needs either react-native-webrtc plus a
 * STUN/TURN setup (peer-to-peer, 1:1), or a hosted media service such as
 * LiveKit / Agora / Daily (which also unlocks group calls). The signalling
 * handshake these need is the part that already works, so this is a smaller job
 * than it looks.
 *
 * TO RE-ENABLE: flip this to true. Nothing else needs to change — the header
 * buttons, the call screen and the in-thread history all return as they were.
 */
export const CALLING_ENABLED = false;

type Options = {
  conversationId: string;
  meId: string | null;
  /**
   * The other participant. Null in a group, or until participants load — the
   * calls table is strictly one caller to one callee, so a null peer means
   * calling is not offered rather than ringing an arbitrary member.
   */
  peerId: string | null;
  /** false while the thread is in a state where ringing would be wrong. */
  enabled: boolean;
  send: (signal: CallSignal) => void;
};

export type UseCallsResult = {
  call: CallState;
  /** true when this conversation can place calls at all (1:1 only). */
  canCall: boolean;
  startCall: (kind: CallKind) => void;
  acceptCall: () => void;
  declineCall: () => void;
  endCall: () => void;
  /** feed incoming signals here; returns nothing. */
  handleSignal: (signal: CallSignal) => void;
};

export function useCalls({
  conversationId,
  meId,
  peerId,
  enabled,
  send,
}: Options): UseCallsResult {
  const [call, setCall] = useState<CallState>(null);

  // Mirrors of state that callbacks and unmount cleanup need to read without
  // becoming stale. `call` alone is not enough: a callback created during a
  // ring would otherwise still see the state from before it started.
  const callRef = useRef<CallState>(null);
  const startedAtRef = useRef(0);
  /** client callId → `calls` row id, for whichever side we are. */
  const dbIdRef = useRef<Record<string, string>>({});

  // `send` comes from a hook and can change identity; keeping it in a ref stops
  // that churn from tearing down startCall/endCall mid-call.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const setCallBoth = useCallback((next: CallState) => {
    callRef.current = next;
    setCall(next);
  }, []);

  /**
   * Persist a status change, but ONLY with a real row id.
   *
   * Passing the client-generated callId here is what silently broke the old
   * implementation: it is not a UUID, so Postgres rejected the call and the row
   * stayed 'ringing' forever. Better to skip the write than to issue one that
   * cannot succeed.
   */
  const setDbStatus = useCallback(
    (cur: NonNullable<CallState>, status: string, duration?: number) => {
      const dbId = dbIdRef.current[cur.callId];
      if (!dbId) return;
      void supabase.rpc('calls_set_status', {
        p_call_id: dbId,
        p_status: status,
        p_duration: duration ?? null,
      });
    },
    []
  );

  // ---------------------------------------------------------------- outgoing
  const startCall = useCallback(
    (kind: CallKind) => {
      const uid = meId;
      if (!uid || !peerId || callRef.current) return;

      const callId = `${uid}-${Date.now()}`;
      startedAtRef.current = Date.now();

      // Ring immediately. Waiting for the RPC first would put a network round
      // trip between the tap and any feedback, which is exactly the kind of
      // dead-feeling interaction this app is trying to avoid.
      setCallBoth({ dir: 'out', kind, status: 'ringing', callId });

      void (async () => {
        const res = await supabase.rpc('calls_start', {
          p_conversation_id: conversationId,
          p_callee_id: peerId,
          p_kind: kind,
        });

        const cur = callRef.current;
        // Bail if the user already hung up while the write was in flight.
        if (!cur || cur.callId !== callId) return;

        if (res.error || !res.data) {
          // calls_start validates that both users are participants, so a
          // failure here means the call could not legitimately exist.
          setCallBoth({ ...cur, status: 'ended' });
          return;
        }

        const dbId = String(res.data);
        dbIdRef.current[callId] = dbId;

        // Offer carries dbId so the callee can persist its own accept/decline.
        sendRef.current({ type: 'offer', callId, kind, from: uid, dbId });
      })();
    },
    [conversationId, meId, peerId, setCallBoth]
  );

  // ------------------------------------------------------- caller gives up
  useEffect(() => {
    if (call?.status !== 'ringing' || call.dir !== 'out') return;
    const callId = call.callId;

    const t = setTimeout(() => {
      const cur = callRef.current;
      if (!cur || cur.callId !== callId) return;
      if (cur.status !== 'ringing' || cur.dir !== 'out') return;

      setDbStatus(cur, 'missed');
      sendRef.current({ type: 'end', callId });
      setCallBoth({ ...cur, status: 'ended' });
    }, RING_TIMEOUT_MS);

    return () => clearTimeout(t);
  }, [call?.status, call?.dir, call?.callId, setCallBoth, setDbStatus]);

  // ------------------------------------------------------------ incoming
  const handleSignal = useCallback(
    (signal: CallSignal) => {
      const cur = callRef.current;

      switch (signal.type) {
        case 'offer': {
          if (!enabled) return;
          if (cur) return; // already ringing or in a call — ignore
          if (signal.from === meId) return; // own echo
          if (signal.dbId) dbIdRef.current[signal.callId] = signal.dbId;
          setCallBoth({
            dir: 'in',
            kind: signal.kind,
            status: 'ringing',
            callId: signal.callId,
          });
          return;
        }

        case 'accept': {
          if (cur?.dir === 'out' && cur.callId === signal.callId) {
            setCallBoth({ ...cur, status: 'active' });
          }
          return;
        }

        case 'decline': {
          if (cur?.dir === 'out' && cur.callId === signal.callId) {
            setCallBoth({ ...cur, status: 'declined' });
            setDbStatus(cur, 'declined');
          }
          return;
        }

        case 'end': {
          if (!cur || cur.callId !== signal.callId) return;

          // Caller hung up before we answered — that is a missed call, not an
          // ended one, and it is what drives the missed-call notification.
          if (cur.dir === 'in' && cur.status === 'ringing') {
            setDbStatus(cur, 'missed');
            setCallBoth(null);
            return;
          }
          setCallBoth({ ...cur, status: 'ended' });
          return;
        }
      }
    },
    [enabled, meId, setCallBoth, setDbStatus]
  );

  // ------------------------------------------------------------ outgoing
  const acceptCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    setDbStatus(cur, 'active');
    sendRef.current({ type: 'accept', callId: cur.callId });
    setCallBoth({ ...cur, status: 'active' });
  }, [setCallBoth, setDbStatus]);

  const declineCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    setDbStatus(cur, 'declined');
    sendRef.current({ type: 'decline', callId: cur.callId });
    setCallBoth(null);
  }, [setCallBoth, setDbStatus]);

  const endCall = useCallback(() => {
    const cur = callRef.current;
    if (!cur) return;
    const dur = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    setDbStatus(cur, 'completed', dur);
    sendRef.current({ type: 'end', callId: cur.callId });
    setCallBoth(null);
  }, [setCallBoth, setDbStatus]);

  // ------------------------------------------------------- auto-dismiss
  useEffect(() => {
    if (call?.status !== 'ended' && call?.status !== 'declined') return;
    const t = setTimeout(() => setCallBoth(null), DISMISS_MS);
    return () => clearTimeout(t);
  }, [call?.status, setCallBoth]);

  // ------------------------------------------------- teardown on leaving
  // Leaving the thread mid-call would otherwise strand the other side ringing
  // with no way to hang up.
  useEffect(() => {
    return () => {
      const cur = callRef.current;
      if (!cur) return;
      if (cur.status !== 'ringing' && cur.status !== 'active') return;

      const dur = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
      const dbId = dbIdRef.current[cur.callId];
      if (dbId) {
        void supabase.rpc('calls_set_status', {
          p_call_id: dbId,
          p_status: cur.status === 'active' ? 'completed' : 'missed',
          p_duration: cur.status === 'active' ? dur : null,
        });
      }
      sendRef.current({ type: 'end', callId: cur.callId });
    };
  }, []);

  return {
    call,
    // Only 1:1. The calls table is one caller to one callee, so offering this
    // in a group would ring an arbitrary member.
    //
    // CALLING_ENABLED is the single gate for the whole user-facing feature.
    // ConversationScreen renders the header buttons behind this flag, so
    // turning calling on or off is this one line — no UI edits, no rebuild.
    canCall: CALLING_ENABLED && enabled && !!meId && !!peerId,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    handleSignal,
  };
}
