// src/messaging/types.ts
// ------------------------------------------------------------------
// The Conversation Engine's type contract.
//
// PURE TypeScript on purpose: this file must never import React,
// React Native, or any component. The engine has to be testable in
// plain node, without a device.
// ------------------------------------------------------------------

/** Every kind the backend's public.message_kinds lookup accepts. */
export const MESSAGE_KINDS = [
  'text',
  'image',
  'video',
  'voice',
  'video_message',
  'moment',
  'file',
  'gif',
  'sticker',
  'audio',
  'location',
  'contact',
  'poll',
  'system',
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(v: unknown): v is MessageKind {
  return typeof v === 'string' && (MESSAGE_KINDS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------
// Typed payloads. One envelope, fourteen shapes — so adding a message
// type never changes the transport, the ordering, or the receipts.
// ------------------------------------------------------------------

export interface LocationPayload {
  lat: number;
  lng: number;
  label?: string;
  /** present for live location; ISO timestamp */
  liveUntil?: string;
}

export interface ContactPayload {
  name: string;
  userId?: string;
  phone?: string;
}

export type SystemEvent =
  | 'added_member'
  | 'removed_member'
  | 'left'
  | 'changed_name'
  | 'changed_photo'
  | 'pinned'
  | 'unpinned'
  | 'timer_changed'
  | 'call'
  | 'request_accepted';

export type MessageBody =
  | { type: 'text'; text: string }
  | { type: 'image'; caption?: string }
  | { type: 'video'; caption?: string }
  | { type: 'voice'; durationMs: number; transcript?: string }
  | { type: 'video_message'; durationMs: number; round: true }
  | { type: 'moment'; caption?: string; viewOnce: true }
  | { type: 'file'; fileName: string; byteSize: number; mime: string }
  | { type: 'gif'; provider: 'giphy' | 'klipy' | 'tenor'; id: string; previewPath?: string }
  | { type: 'sticker'; packId: string; stickerId: string; animated: boolean }
  | { type: 'audio'; title?: string; artist?: string; durationMs: number }
  | { type: 'location'; lat: number; lng: number; liveUntil?: string; label?: string }
  | { type: 'contact'; name: string; userId?: string; phone?: string }
  | { type: 'poll'; pollId: string }
  | {
      type: 'system';
      event: SystemEvent;
      actorId?: string;
      targetIds?: string[];
    };

// ------------------------------------------------------------------
// Rows
// ------------------------------------------------------------------

export interface Attachment {
  id: string;
  messageId: string | null;
  conversationId: string;
  position: number;
  storageBucket: string;
  storagePath: string;
  thumbPath: string | null;
  blurhash: string | null;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  wavePeaks: number[] | null;
  uploadState: 'pending' | 'uploading' | 'complete' | 'failed';
  scanState: 'pending' | 'clean' | 'blocked';
  checksum: string | null;
  createdAt: string;
}

export interface Reaction {
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

/** Client-only send state. Never persisted as authoritative. */
export type LocalState = 'queued' | 'sending' | 'sent' | 'failed';

/** Server-derived delivery state. Never guessed by the client. */
export type DeliveryState = 'sent' | 'delivered' | 'seen';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  seq: number;
  createdAt: string;
  editedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  replyTo: string | null;
  forwardedFrom: string | null;
  forwardedFromUser: string | null;
  threadRoot: string | null;
  topicId: string | null;
  pinnedAt: string | null;
  pinnedBy: string | null;
  /** legacy media URL from the pre-v2 `media_url` column. New uploads will use
   *  attachments[] + signed URLs; this keeps every existing message renderable. */
  legacyMediaUrl: string | null;
  /** legacy view-once flag. Superseded by the message_views table once populated. */
  viewOnce: boolean;
  /** user ids who already opened a view-once message */
  viewedBy: string[];
  body: MessageBody;
  attachments: Attachment[];
  reactions: Reaction[];
  /** present only on locally-originated, not-yet-confirmed messages */
  local?: LocalState;
  clientMessageId?: string;
  /** populated on already-ordered history */
  delivery?: DeliveryState;
}

/** What the engine consumes from the DB. Snake_case, exactly as Postgres returns it. */
export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  media_url: string | null;
  reaction: string | null;
  msg_type: string;
  seq: number;
  created_at: string;
  edited_at: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  reply_to: string | null;
  forwarded_from: string | null;
  forwarded_from_user: string | null;
  thread_root: string | null;
  topic_id: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  client_message_id: string | null;
  body: unknown;
  view_once: boolean | null;
  viewed_by: string[] | null;
}

// ------------------------------------------------------------------
// Engine-facing shapes
// ------------------------------------------------------------------

export interface OutgoingDraft {
  conversationId: string;
  kind: MessageKind;
  body: MessageBody;
  /** Generated ONCE and reused across every retry. This is the duplicate fix. */
  clientMessageId: string;
  replyTo?: string | null;
  attachmentIds?: string[];
  mediaUrl?: string | null;
  viewOnce?: boolean;
  expiresAt?: string | null;
  createdAt: string;
}

export interface SendOptions {
  replyTo?: string | null;
  attachmentIds?: string[];
  /**
   * Media URL for image/video/voice/file sends. Written to the legacy
   * `media_url` column for now, which is what the bubbles already render.
   * When the attachments[] pipeline lands this is replaced by attachmentIds.
   */
  mediaUrl?: string | null;
  /** View Once: the recipient may open it a single time (§10). */
  viewOnce?: boolean;
  /** Temporary: auto-expires at this ISO timestamp (§10). */
  expiresAt?: string | null;
}

export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface TimelineState {
  conversationId: string | null;
  /** oldest → newest */
  messages: Message[];
  status: ConnectionStatus;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  /** true once the first page has resolved, so the UI can leave its skeleton */
  hydrated: boolean;
  error: string | null;
}

export function emptyTimeline(): TimelineState {
  return {
    conversationId: null,
    messages: [],
    status: 'offline',
    loading: false,
    loadingOlder: false,
    hasMore: true,
    hydrated: false,
    error: null,
  };
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

/** Postgres unique-violation. On send, this means "already delivered". */
export const SQLSTATE_UNIQUE_VIOLATION = '23505';
/** Postgres insufficient_privilege — RLS refused the write. */
export const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';

export type SendErrorCode =
  | 'duplicate'
  | 'offline'
  | 'forbidden'
  | 'not_participant'
  | 'invalid'
  | 'unknown';

export class SendError extends Error {
  readonly code: SendErrorCode;
  readonly sqlState?: string;

  constructor(code: SendErrorCode, message: string, sqlState?: string) {
    super(message);
    this.name = 'SendError';
    this.code = code;
    this.sqlState = sqlState;
  }

  /**
   * Only network/timeout failures are worth retrying. A 42501 (RLS refused)
   * will never succeed on retry, and retrying it just burns battery.
   */
  get retryable(): boolean {
    return this.code === 'offline' || this.code === 'unknown';
  }
}

// ------------------------------------------------------------------
// Row → domain mapping. Defensive, because the table has legacy
// columns and legacy rows whose body is still '{}'.
// ------------------------------------------------------------------

export function parseBody(kind: MessageKind, raw: unknown, legacyText: string | null): MessageBody {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.type === 'string') return obj as unknown as MessageBody;
    // A text row whose body was never backfilled still has `content`.
    if (kind === 'text' && typeof obj.text === 'string') {
      return { type: 'text', text: obj.text };
    }
  }
  if (kind === 'text') {
    return { type: 'text', text: legacyText ?? '' };
  }
  // Legacy media rows keep their payload in the old media_url column; the
  // renderer falls back to it. Shape here is intentionally permissive, hence
  // the double assertion — a single `as` is rejected because the object
  // literal's `type` is the whole union rather than one member.
  return { type: kind, caption: legacyText ?? undefined } as unknown as MessageBody;
}

export function mapRow(row: MessageRow, reactions: Reaction[] = []): Message {
  const kind: MessageKind = isMessageKind(row.msg_type) ? row.msg_type : 'text';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind,
    seq: Number(row.seq),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    replyTo: row.reply_to,
    forwardedFrom: row.forwarded_from,
    forwardedFromUser: row.forwarded_from_user,
    threadRoot: row.thread_root,
    topicId: row.topic_id,
    pinnedAt: row.pinned_at,
    pinnedBy: row.pinned_by,
    body: parseBody(kind, row.body, row.content),
    legacyMediaUrl: row.media_url,
    viewOnce: !!row.view_once,
    viewedBy: row.viewed_by ?? [],
    attachments: [],
    reactions,
    local: 'sent',
    clientMessageId: row.client_message_id ?? undefined,
  };
}

/** Columns the engine needs. Kept in one place so it stays in sync with MessageRow. */
export const MESSAGE_SELECT =
  'id, conversation_id, sender_id, content, media_url, reaction, msg_type, seq, created_at, ' +
  'edited_at, expires_at, deleted_at, reply_to, forwarded_from, forwarded_from_user, ' +
  'thread_root, topic_id, pinned_at, pinned_by, client_message_id, body, view_once, viewed_by';
