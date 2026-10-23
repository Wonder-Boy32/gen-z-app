// src/messaging/api.ts
// ------------------------------------------------------------------
// The only place in the engine that talks to Supabase.
//
// Nothing above this layer knows that Postgres exists. Nothing
// below it knows about React. That seam is what makes the engine
// swappable and testable.
//
// Idempotency strategy, and why it is a plain INSERT rather than an
// RPC: public.messages already has a partial unique index on
// (sender_id, client_message_id), and the RLS INSERT policy already
// pins sender_id = auth.uid() (supabase/schema.sql:295). So a direct
// insert is both safe and already idempotent — a retry raises 23505,
// which we translate into "already delivered". No extra migration
// needed. When attachments land, this becomes a `messaging_send` RPC
// so the message + attachment link is atomic; the call signature
// below is designed to stay put when that happens.
// ------------------------------------------------------------------

import { supabase } from '../supabase/client';
import { isStorageRef, resolveMediaRef, resolveMediaRefs } from '../utils/privateMedia';
import {
  MESSAGE_SELECT,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  SQLSTATE_UNIQUE_VIOLATION,
  SendError,
  mapRow,
  type Message,
  type MessageBody,
  type MessageKind,
  type MessageRow,
  type OutgoingDraft,
  type Reaction,
} from './types';

export const PAGE_SIZE = 50;

/**
 * Swap `sb://` references for short-lived signed URLs.
 *
 * Private buckets cannot be addressed by a permanent URL, so the
 * database stores a reference and the read path signs it. Doing this
 * here — on every function that can hand Message objects to the UI —
 * means no renderer has to know the difference, and legacy rows that
 * still hold a plain https URL pass through untouched.
 *
 * One batch call per bucket, so a thread of twenty photos costs one
 * round trip rather than twenty.
 */
async function hydratePrivateMedia(messages: Message[]): Promise<void> {
  const refs = messages
    .map((m) => m.legacyMediaUrl)
    .filter((v): v is string => !!v && isStorageRef(v));

  if (refs.length === 0) return;

  try {
    const resolved = await resolveMediaRefs(refs);
    for (const m of messages) {
      if (m.legacyMediaUrl && isStorageRef(m.legacyMediaUrl)) {
        const signed = resolved.get(m.legacyMediaUrl);
        if (signed) m.legacyMediaUrl = signed;
      }
    }
  } catch {
    // A missing image must never fail the timeline. Unsigned refs stay
    // refs, which render as a broken image rather than the wrong thing.
  }
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** Translate a Postgrest error into something the UI can act on. */
function toSendError(error: PostgrestLikeError, context: string): SendError {
  const code = error.code ?? '';
  const message = error.message ?? `unknown error in ${context}`;

  if (code === SQLSTATE_UNIQUE_VIOLATION) {
    return new SendError('duplicate', message, code);
  }
  if (code === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
    return new SendError('forbidden', message, code);
  }
  // Network failures surface with no sqlstate at all.
  if (!code) {
    return new SendError('offline', message);
  }
  return new SendError('unknown', message, code);
}

// ------------------------------------------------------------------
// Timeline
// ------------------------------------------------------------------

/**
 * Keyset pagination on `seq`. Never OFFSET — OFFSET degrades linearly
 * and silently skips rows when new messages arrive mid-scroll.
 * Returns oldest → newest for direct rendering.
 */
export async function fetchTimeline(
  conversationId: string,
  beforeSeq: number | null,
  limit: number = PAGE_SIZE
): Promise<{ messages: Message[]; hasMore: boolean }> {
  let query = supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .limit(limit + 1);

  if (beforeSeq !== null) {
    query = query.lt('seq', beforeSeq);
  }

  const { data, error } = await query;
  if (error) throw toSendError(error, 'fetchTimeline');

  const rows = (data ?? []) as unknown as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const messages = page.map((r) => mapRow(r));
  await hydratePrivateMedia(messages);
  const ordered = messages.slice().reverse();

  const reactions = await fetchReactions(ordered.map((m) => m.id));
  for (const m of ordered) {
    m.reactions = reactions.filter((r) => r.messageId === m.id);
  }

  return { messages: ordered, hasMore };
}

export async function fetchReactions(messageIds: string[]): Promise<Reaction[]> {
  if (messageIds.length === 0) return [];

  const { data, error } = await supabase
    .from('message_reactions')
    .select('message_id, user_id, emoji, created_at')
    .in('message_id', messageIds);

  if (error) {
    // Reactions are decorative. Never fail a timeline render over them.
    if (__DEV__) console.warn('[messaging] fetchReactions failed:', error.message);
    return [];
  }

  interface ReactionRow {
    message_id: string;
    user_id: string;
    emoji: string;
    created_at: string;
  }

  return ((data ?? []) as unknown as ReactionRow[]).map((r) => ({
    messageId: r.message_id,
    userId: r.user_id,
    emoji: r.emoji,
    createdAt: r.created_at,
  }));
}

// ------------------------------------------------------------------
// Send
// ------------------------------------------------------------------

export interface SendResult {
  message: Message;
  duplicate: boolean;
}

/**
 * Send one message. Idempotent on (senderId, clientMessageId).
 *
 * IMPORTANT: never generate clientMessageId inside this function.
 * It is created once by the caller and reused for every retry —
 * that reuse is the entire duplicate-prevention mechanism.
 */
export async function sendMessage(userId: string, draft: OutgoingDraft): Promise<SendResult> {
  const text = draft.body.type === 'text' ? draft.body.text : null;
  const caption =
    'caption' in draft.body && typeof draft.body.caption === 'string' ? draft.body.caption : null;

  const payload = {
    conversation_id: draft.conversationId,
    sender_id: userId,
    msg_type: draft.kind,
    // `content` is still written for backwards compatibility: the existing
    // ChatThread reads it. It becomes redundant once the screen renders
    // from `body`, and can be dropped in a later phase.
    content: text ?? caption,
    body: draft.body,
    media_url: draft.mediaUrl ?? null,
    // View-once and temporary content are metadata on the row, not a separate
    // table, so the existing view_once column and the new expires_at column
    // both carry the send mode chosen in the composer.
    view_once: draft.viewOnce ?? false,
    expires_at: draft.expiresAt ?? null,
    client_message_id: draft.clientMessageId,
    reply_to: draft.replyTo ?? null,
  };

  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select(MESSAGE_SELECT)
    .single();

  if (error) {
    const mapped = toSendError(error, 'sendMessage');

    if (mapped.code === 'duplicate') {
      const existing = await findByClientMessageId(userId, draft.clientMessageId);
      if (existing) return { message: existing, duplicate: true };
    }
    throw mapped;
  }

  const message = mapRow(data as unknown as MessageRow);
  await hydratePrivateMedia([message]);

  return { message, duplicate: false };
}

/** Reconcile an optimistic bubble against the row the server actually holds. */
export async function findByClientMessageId(
  userId: string,
  clientMessageId: string
): Promise<Message | null> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('sender_id', userId)
    .eq('client_message_id', clientMessageId)
    .maybeSingle();

  if (error || !data) return null;
  const msg = mapRow(data as unknown as MessageRow);
  await hydratePrivateMedia([msg]);
  return msg;
}

// ------------------------------------------------------------------
// Mutations
// ------------------------------------------------------------------

export async function editMessage(messageId: string, body: MessageBody): Promise<void> {
  const text = body.type === 'text' ? body.text : null;
  // `edited_at` is set by the messages_guard_update trigger once PART 2 of the
  // migration is live. Until then we set it here so the UI still shows "edited".
  const { error } = await supabase
    .from('messages')
    .update({ body, content: text, edited_at: new Date().toISOString() })
    .eq('id', messageId);

  if (error) throw toSendError(error, 'editMessage');
}

/**
 * Delete. `forEveryone` soft-deletes the row; otherwise the message is
 * hidden only for the caller.
 */
export async function deleteMessage(
  userId: string,
  messageId: string,
  forEveryone: boolean
): Promise<void> {
  if (forEveryone) {
    const { error } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString(), content: null, body: {} })
      .eq('id', messageId);
    if (error) throw toSendError(error, 'deleteMessage(forEveryone)');
    return;
  }

  const { error } = await supabase
    .from('message_hides')
    .insert({ message_id: messageId, user_id: userId });
  if (error && error.code !== SQLSTATE_UNIQUE_VIOLATION) {
    throw toSendError(error, 'deleteMessage(forMe)');
  }
}

/**
 * Record that `userId` has opened a view-once message.
 *
 * This is the missing client half of the design in messaging_v2.sql STEP 8.
 * Views belong in `message_views` precisely so that a recipient never needs
 * UPDATE power over the sender's message row — and messaging_v2_hardening.sql
 * states outright that "the client must be moved onto them BEFORE this runs.
 * That is a client change, not a database change."
 *
 * That client change was never made: the hardening checklist still records
 * "[x] the client never writes viewed_by / message_views". The consequence is
 * the reported bug — opening a view-once moment recorded nothing, so
 * MomentBody's `viewedBy` stayed empty and the media could be reopened
 * forever.
 */
export async function recordView(userId: string, messageId: string): Promise<void> {
  const { error } = await supabase
    .from('message_views')
    .insert({ message_id: messageId, user_id: userId });
  // Already-viewed is the desired end state, not a failure.
  if (error && error.code !== SQLSTATE_UNIQUE_VIOLATION) {
    throw toSendError(error, 'recordView');
  }
}

/**
 * The caller's own view records for a set of messages.
 *
 * RLS on `message_views` is select-own, so this can only ever return views
 * belonging to `userId` — which is exactly the question the UI asks.
 * Returns [] on failure: a missing "already viewed" marker is a cosmetic
 * downgrade, never a reason to fail loading the conversation.
 */
export async function fetchMyViews(userId: string, messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await supabase
    .from('message_views')
    .select('message_id')
    .eq('user_id', userId)
    .in('message_id', messageIds);
  if (error) return [];
  return (data ?? []).map((r: { message_id: string }) => r.message_id);
}

export async function react(userId: string, messageId: string, emoji: string): Promise<void> {
  const { error } = await supabase
    .from('message_reactions')
    .insert({ message_id: messageId, user_id: userId, emoji });
  // Reacting twice with the same emoji is a no-op, not an error.
  if (error && error.code !== SQLSTATE_UNIQUE_VIOLATION) {
    throw toSendError(error, 'react');
  }
}

export async function unreact(userId: string, messageId: string, emoji: string): Promise<void> {
  const { error } = await supabase
    .from('message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji);
  if (error) throw toSendError(error, 'unreact');
}

/**
 * Mark read up to a seq.
 *
 * Both columns are written on purpose during the migration window:
 *   last_read_seq — the new authoritative cursor, O(1) even in a 200-member group
 *   last_read_at  — still read by the existing ChatThread for seen ticks
 *                      and by ChatsScreen for unread badges
 * Once the screen renders from `last_read_seq`, the timestamp write can go.
 */
export async function markRead(
  conversationId: string,
  userId: string,
  uptoSeq: number
): Promise<void> {
  // The updated row is requested back so a no-op can be DETECTED.
  //
  // PostgREST does not raise an error when RLS filters every row out of an
  // UPDATE — it reports success having changed nothing. That is precisely how a
  // read cursor stops advancing while looking like it worked, leaving an unread
  // badge lit forever with nothing in the logs. Checking the returned rows turns
  // that silent failure into something visible.
  const { data, error } = await supabase
    .from('conversation_participants')
    .update({ last_read_seq: uptoSeq, last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .select('user_id');

  if (error) {
    console.warn('[messaging] markRead failed:', error.message);
    return;
  }
  if (!data || data.length === 0) {
    console.warn(
      '[messaging] markRead updated no rows for conversation',
      conversationId,
      '- the read cursor did not advance, so the unread badge will stay lit.'
    );
  }
}

export async function markDelivered(
  conversationId: string,
  userId: string,
  uptoSeq: number
): Promise<void> {
  const { error } = await supabase
    .from('conversation_participants')
    .update({ last_delivered_seq: uptoSeq })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  if (error && __DEV__) console.warn('[messaging] markDelivered failed:', error.message);
}

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/**
 * Open a view-once moment.
 *
 * The server decides whether this is the first and only viewing: it
 * checks conversation membership, refuses the sender, refuses a second
 * call, and stamps consumption before returning the media reference.
 * Ending up here twice means the media is genuinely gone, not merely
 * hidden by a local flag.
 *
 * Returns a signed URL ready to display, or null if the bytes are
 * already removed.
 */
export async function consumeViewOnce(messageId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('consume_view_once', { p_message: messageId });
  if (error) throw new Error(error.message);

  const ref = (data as { media_ref?: string | null } | null)?.media_ref ?? null;
  if (!ref) return null;
  return resolveMediaRef(ref);
}

export async function signedMediaUrl(storagePath: string, ttlSeconds = 600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('chat-media')
    .createSignedUrl(storagePath, ttlSeconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

// ------------------------------------------------------------------
// Pin, unread and forward (§4)
// ------------------------------------------------------------------

/**
 * Pin / unpin. A pin records WHO pinned it — that is exactly why
 * pinned_at/pinned_by exist alongside the legacy bare `pinned` boolean.
 * The legacy column is left untouched so nothing that reads it breaks.
 */
export async function setPinned(
  messageId: string,
  userId: string,
  pinned: boolean
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({
      pinned_at: pinned ? new Date().toISOString() : null,
      pinned_by: pinned ? userId : null,
    })
    .eq('id', messageId);

  if (error) throw toSendError(error, 'setPinned');
}

/**
 * Mark a thread unread.
 *
 * Moves the read cursor to the SECOND-newest message, which leaves exactly one
 * unread. Setting it to just-below-the-newest is what makes the badge read "1"
 * rather than counting the whole thread — which is what people mean by
 * "mark as unread".
 */
export async function markConversationUnread(
  conversationId: string,
  userId: string
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('messages')
    .select('seq')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('seq', { ascending: false })
    .limit(2);

  if (readErr) throw toSendError(readErr, 'markConversationUnread(read)');

  const rows = (data ?? []) as { seq: number }[];
  if (rows.length === 0) return;

  const target = rows.length > 1 ? rows[1].seq : Math.max(0, rows[0].seq - 1);

  const { error } = await supabase
    .from('conversation_participants')
    .update({ last_read_seq: target })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  if (error) throw toSendError(error, 'markConversationUnread(write)');
}

/** Pin one of the caller's own messages to the top of the thread. */
export async function fetchPinned(conversationId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .not('pinned_at', 'is', null)
    .order('pinned_at', { ascending: false })
    .limit(3);

  if (error) return [];
  const pinned = ((data ?? []) as unknown as MessageRow[]).map((r) => mapRow(r));
  await hydratePrivateMedia(pinned);
  return pinned;
}

/**
 * Forward a message into another conversation.
 *
 * Forwarding COPIES rather than links: the target keeps its own copy with
 * provenance attached (forwarded_from + forwarded_from_user), so deleting the
 * original does not quietly gut every thread it was sent to.
 */
export async function forwardMessage(
  userId: string,
  source: {
    id: string;
    kind: MessageKind;
    body: MessageBody;
    mediaUrl: string | null;
  },
  targetConversationId: string,
  clientMessageId: string
): Promise<void> {
  const { error } = await supabase.from('messages').insert({
    conversation_id: targetConversationId,
    sender_id: userId,
    msg_type: source.kind,
    content: source.body.type === 'text' ? source.body.text : null,
    body: source.body,
    media_url: source.mediaUrl,
    forwarded_from: source.id,
    forwarded_from_user: userId,
    client_message_id: clientMessageId,
  });

  if (error) throw toSendError(error, 'forwardMessage');
}

// ------------------------------------------------------------------
// Polls (§29)
// ------------------------------------------------------------------

export interface PollDraft {
  question: string;
  options: string[];
  multi: boolean;
  anonymous: boolean;
  closesAt: string | null;
}

/**
 * Create a poll message. Two statements, not one, because there is no
 * messaging_send RPC yet — so this is NOT atomic. If the polls insert fails we
 * roll the message back rather than leave an un-openable "Poll" bubble.
 */
export async function createPoll(
  userId: string,
  conversationId: string,
  draft: PollDraft,
  clientMessageId: string
): Promise<string> {
  const options = draft.options
    .map((label, i) => ({ id: `o${i + 1}`, label }))
    .slice(0, 8);

  const { data: msg, error: msgErr } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: userId,
      msg_type: 'poll',
      content: draft.question,
      body: { type: 'poll', pollId: '' },
      client_message_id: clientMessageId,
    })
    .select('id')
    .single();

  if (msgErr) throw toSendError(msgErr, 'createPoll(message)');

  const messageId = (msg as { id: string }).id;

  const { data: poll, error: pollErr } = await supabase
    .from('polls')
    .insert({
      message_id: messageId,
      question: draft.question,
      options,
      multi: draft.multi,
      anonymous: draft.anonymous,
      closes_at: draft.closesAt,
    })
    .select('id')
    .single();

  if (pollErr) {
    // Roll back the orphan bubble so the thread never shows a dead poll.
    await supabase.from('messages').delete().eq('id', messageId);
    throw toSendError(pollErr, 'createPoll(poll)');
  }

  // The bubble needs the poll's id to render it, but the message had to be
  // inserted before the poll row existed. Patch the body now. If this write
  // fails the bubble degrades to a plain "Poll" label rather than rendering a
  // card that can never load.
  const pollId = (poll as { id: string }).id;
  const { error: patchErr } = await supabase
    .from('messages')
    .update({ body: { type: 'poll', pollId } })
    .eq('id', messageId);

  if (patchErr && __DEV__) {
    console.warn('[messaging] poll body patch failed:', patchErr.message);
  }

  return messageId;
}
