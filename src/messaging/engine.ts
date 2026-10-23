// src/messaging/engine.ts
// ------------------------------------------------------------------
// THE CONVERSATION ENGINE.
//
// Pure TypeScript. No React, no JSX, no component imports — so it can
// be unit-tested in plain node, and so the Surface cannot accidentally
// grow business logic.
//
// Responsibilities:
//   · own the ordered timeline
//   · own optimistic state and the durable outbox
//   · dedupe against the server and reconcile ids
//   · paginate history with keyset cursors
//   · derive delivery state from receipts, never guess it
//   · expose one observable state object to the UI
// ------------------------------------------------------------------

import {
  PAGE_SIZE,
  createPoll as apiCreatePoll,
  deleteMessage as apiDelete,
  editMessage as apiEdit,
  fetchPinned,
  fetchReactions,
  fetchTimeline,
  forwardMessage as apiForward,
  markConversationUnread as apiMarkUnread,
  markDelivered,
  markRead,
  react as apiReact,
  sendMessage,
  setPinned as apiSetPinned,
  unreact as apiUnreact,
  type PollDraft,
} from './api';
import { isStorageRef, resolveMediaRef } from '../utils/privateMedia';
import { outbox } from './outbox';
import {
  subscribeConversation,
  type CallSignal,
  type Subscription,
  type TypingSignal,
} from './transport';
import {
  SendError,
  emptyTimeline,
  mapRow,
  type ConnectionStatus,
  type Message,
  type MessageBody,
  type MessageKind,
  type MessageRow,
  type OutgoingDraft,
  type SendOptions,
  type TimelineState,
} from './types';

type Listener = (state: TimelineState) => void;

/** Optimistic ids are namespaced so a temp id can never collide with a uuid. */
const TEMP_PREFIX = 'tmp:';

function isTempId(id: string): boolean {
  return id.startsWith(TEMP_PREFIX);
}

function newClientMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class ConversationEngine {
  private conversationId: string | null = null;
  private userId: string | null = null;
  private listeners = new Set<Listener>();
  private subscription: Subscription | null = null;

  /** Server-confirmed messages, keyed by id, always kept seq-ascending. */
  private confirmed: Message[] = [];
  /** Thread pins, most recent first. Kept separate from the timeline window. */
  private pinned: Message[] = [];
  /** Locally-originated messages awaiting confirmation, keyed by clientMessageId. */
  private pending = new Map<string, Message>();

  private state: TimelineState = emptyTimeline();
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private typingActive = false;
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private disposed = false;

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  /** Open a conversation. Idempotent for the same id. */
  async open(conversationId: string, userId: string): Promise<void> {
    if (this.conversationId === conversationId && this.userId === userId) return;

    this.close();
    this.disposed = false;
    this.conversationId = conversationId;
    this.userId = userId;

    this.confirmed = [];
    this.pending.clear();
    this.state = {
      ...emptyTimeline(),
      conversationId,
      loading: true,
      status: 'reconnecting',
    };
    this.emit();

    await outbox.load();
    this.rehydratePending();

    try {
      const { messages, hasMore } = await fetchTimeline(conversationId, null, PAGE_SIZE);
      this.confirmed = messages;
      this.state = { ...this.state, hasMore, loading: false, hydrated: true, error: null };
    } catch (err) {
      this.state = {
        ...this.state,
        loading: false,
        hydrated: true,
        error: err instanceof Error ? err.message : 'Failed to load messages',
      };
    }
    this.emit();

    this.subscription = subscribeConversation(conversationId, userId, {
      onMessageUpsert: (row) => this.onServerRow(row),
      onMessageDelete: (row) => this.onServerDelete(row),
      onReactionChange: () => void this.refreshReactions(),
      onTyping: (signal) => this.onTypingSignal(signal),
      onCallSignal: (signal) => this.handleCallSignal(signal),
      onStatus: (status) => this.onStatus(status),
    });

    // Anything queued from a previous session goes out now.
    void this.flush();
    void this.markReadUpToLatest();
  }

  close(): void {
    this.disposed = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.typingActive = false;
    this.conversationId = null;
    this.userId = null;
    this.retryAttempt = 0;
  }

  /** Sign-out must tear down state, not just navigate away. */
  static reset(): void {
    outbox.clear();
  }

  // ----------------------------------------------------------------
  // Observation
  // ----------------------------------------------------------------

  getState(): TimelineState {
    return { ...this.state, messages: this.merge() };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    if (this.disposed && this.conversationId === null) return;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * Exchange an `sb://` media reference for a signed URL, then re-emit.
   *
   * Both messages that reach the UI through a path other than
   * fetchTimeline need this: the optimistic bubble created at send
   * time (which carries the raw reference) and a row arriving over
   * realtime (mapped directly, never through api.ts). Without it those
   * two would render a broken image while the rest of the thread
   * worked — the kind of bug that looks intermittent.
   */
  private hydrateMedia(message: Message): void {
    const ref = message.legacyMediaUrl;
    if (!ref || !isStorageRef(ref)) return;

    void resolveMediaRef(ref).then((signed) => {
      if (!signed) return;
      const live =
        this.confirmed.find((m) => m.id === message.id) ??
        (message.clientMessageId ? this.pending.get(message.clientMessageId) : undefined);
      if (!live || live.legacyMediaUrl === signed) return;
      live.legacyMediaUrl = signed;
      this.emit();
    });
  }

  // ----------------------------------------------------------------
  // Merge: the dedupe that makes optimistic UI safe
  // ----------------------------------------------------------------

  private rehydratePending(): void {
    if (!this.conversationId) return;
    for (const draft of outbox.forConversation(this.conversationId)) {
      if (this.pending.has(draft.clientMessageId)) continue;
      this.pending.set(draft.clientMessageId, this.toOptimistic(draft, 'queued'));
    }
  }

  private toOptimistic(draft: OutgoingDraft, local: Message['local']): Message {
    return {
      id: `${TEMP_PREFIX}${draft.clientMessageId}`,
      conversationId: draft.conversationId,
      senderId: this.userId ?? '',
      kind: draft.kind,
      seq: 0, // assigned during merge
      createdAt: draft.createdAt,
      editedAt: null,
      deletedAt: null,
      replyTo: draft.replyTo ?? null,
      forwardedFrom: null,
      forwardedFromUser: null,
      threadRoot: null,
      topicId: null,
      pinnedAt: null,
      pinnedBy: null,
      legacyMediaUrl: draft.mediaUrl ?? null,
      viewOnce: draft.viewOnce ?? draft.kind === 'moment',
      expiresAt: draft.expiresAt ?? null,
      viewedBy: [],
      body: draft.body,
      attachments: [],
      reactions: [],
      local,
      clientMessageId: draft.clientMessageId,
    };
  }

  /**
   * Server history + still-pending optimism, in one ordered list.
   *
   * A pending message is dropped from the optimistic tail the moment the
   * server row carrying the same client_message_id appears. That is the
   * reconciliation — it is why a slow network never shows a message twice.
   */
  private merge(): Message[] {
    const serverIds = new Set<string>();
    for (const m of this.confirmed) {
      if (m.clientMessageId) serverIds.add(m.clientMessageId);
    }

    const tail: Message[] = [];
    for (const p of this.pending.values()) {
      if (p.clientMessageId && serverIds.has(p.clientMessageId)) continue;
      tail.push(p);
    }

    const lastSeq = this.confirmed.length
      ? this.confirmed[this.confirmed.length - 1].seq
      : 0;

    const optimistic = tail.map((m, i) => ({ ...m, seq: lastSeq + 1 + i }));
    return [...this.confirmed, ...optimistic];
  }

  private upsertConfirmed(row: Message): void {
    const idx = this.confirmed.findIndex((m) => m.id === row.id);
    if (idx >= 0) {
      this.confirmed[idx] = { ...row, reactions: this.confirmed[idx].reactions };
    } else {
      this.confirmed.push(row);
      this.confirmed.sort((a, b) => a.seq - b.seq);
    }
  }

  // ----------------------------------------------------------------
  // Realtime handlers
  // ----------------------------------------------------------------

  private onServerRow(raw: Record<string, unknown>): void {
    const row = raw as unknown as MessageRow;
    if (!row || typeof row.id !== 'string') return;
    if (this.conversationId && row.conversation_id !== this.conversationId) return;

    if (row.client_message_id) {
      const optimistic = this.pending.get(row.client_message_id);
      if (optimistic) {
        // Confirmed. Drop the local copy and the outbox entry together.
        this.pending.delete(row.client_message_id);
        outbox.remove(row.client_message_id);
      }
    }

    const incoming = mapRow(row);
    this.upsertConfirmed(incoming);
    this.emit();
    this.hydrateMedia(incoming);

    if (row.sender_id !== this.userId) {
      void this.markReadUpToLatest();
    }
  }

  private onServerDelete(raw: Record<string, unknown>): void {
    const id = raw.id;
    if (typeof id !== 'string') return;
    this.confirmed = this.confirmed.filter((m) => m.id !== id);
    this.emit();
  }

  private async refreshReactions(): Promise<void> {
    const visible = this.merge().filter((m) => !isTempId(m.id));
    if (visible.length === 0) return;
    const reactions = await fetchReactions(visible.map((m) => m.id));
    for (const m of this.confirmed) {
      m.reactions = reactions.filter((r) => r.messageId === m.id);
    }
    this.emit();
  }

  private onTypingSignal(signal: TypingSignal): void {
    // The engine does not own typed-presence UI state; it forwards the raw
    // signal so the Surface can decide how (or whether) to show it.
    this.typingHandlers.forEach((h) => h(signal));
  }

  private typingHandlers = new Set<(s: TypingSignal) => void>();

  onTyping(handler: (s: TypingSignal) => void): () => void {
    this.typingHandlers.add(handler);
    return () => {
      this.typingHandlers.delete(handler);
    };
  }

  /**
   * Call signalling follows the same rule as typing: the engine forwards the
   * raw signal and owns no call UI state. Deciding what a signal means — ring,
   * connect, dismiss — belongs to the Surface.
   *
   * Named `handleCallSignal`, NOT `onCallSignal`. The typing equivalent splits
   * the two names (onTypingSignal / onTyping) and that split is load-bearing:
   * a class cannot hold an internal fan-out AND a public registration under one
   * name. The duplicate silently keeps only the LAST definition, so this call
   * would have invoked the registration method passing a signal as its
   * "handler" — a crash on the first incoming call. TypeScript catches it as
   * TS2393; the Metro bundler does NOT, so the bundle passing proves nothing.
   */
  private handleCallSignal(signal: CallSignal): void {
    this.callHandlers.forEach((h) => h(signal));
  }

  private callHandlers = new Set<(s: CallSignal) => void>();

  onCallSignal(handler: (s: CallSignal) => void): () => void {
    this.callHandlers.add(handler);
    return () => {
      this.callHandlers.delete(handler);
    };
  }

  private onStatus(status: ConnectionStatus): void {
    this.state = { ...this.state, status };
    this.emit();

    if (status === 'online') {
      this.retryAttempt = 0;
      void this.flush();
    } else if (status === 'reconnecting') {
      this.scheduleRetry();
    }
  }

  /**
   * Backoff with jitter. Without jitter every client that dropped with the
   * same cell tower reconnects in lockstep and re-floods the API.
   */
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const base = Math.min(1000 * 2 ** this.retryAttempt, 30_000);
    const jitter = Math.random() * 0.3 * base;
    this.retryAttempt += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, base + jitter);
  }

  // ----------------------------------------------------------------
  // Sending
  // ----------------------------------------------------------------

  async sendText(text: string, options: SendOptions = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.enqueue('text', { type: 'text', text: trimmed }, options);
  }

  async send(kind: MessageKind, body: MessageBody, options: SendOptions = {}): Promise<void> {
    await this.enqueue(kind, body, options);
  }

  private async enqueue(
    kind: MessageKind,
    body: MessageBody,
    options: SendOptions
  ): Promise<void> {
    if (!this.conversationId || !this.userId) return;

    const draft: OutgoingDraft = {
      conversationId: this.conversationId,
      kind,
      body,
      // Generated ONCE. Every retry reuses it, which is what makes the send
      // idempotent. Generating it per attempt would reintroduce duplicates.
      clientMessageId: newClientMessageId(),
      replyTo: options.replyTo ?? null,
      attachmentIds: options.attachmentIds,
      mediaUrl: options.mediaUrl ?? null,
      viewOnce: options.viewOnce ?? false,
      expiresAt: options.expiresAt ?? null,
      createdAt: new Date().toISOString(),
    };

    outbox.append(draft);

    const optimisticMessage = this.toOptimistic(draft, 'queued');
    this.pending.set(draft.clientMessageId, optimisticMessage);
    this.emit();
    this.hydrateMedia(optimisticMessage);

    await this.flush();
  }

  /**
   * Flush the outbox for this conversation, strictly in order.
   *
   * Sequential on purpose: concurrent sends in one conversation arrive out
   * of order at the server, and out-of-order bubbles are the bug users
   * notice most.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.conversationId || !this.userId) return;
    const conversationId = this.conversationId;
    const userId = this.userId;

    this.flushing = true;
    let shouldRetry = false;

    try {
      for (const draft of outbox.forConversation(conversationId)) {
        const optimistic = this.pending.get(draft.clientMessageId);
        if (optimistic && optimistic.local === 'failed') continue; // needs manual retry

        if (optimistic) {
          this.pending.set(draft.clientMessageId, { ...optimistic, local: 'sending' });
          this.emit();
        }

        try {
          const { message } = await sendMessage(userId, draft);

          this.pending.delete(draft.clientMessageId);
          outbox.remove(draft.clientMessageId);
          // On a duplicate the returned row is the already-stored one, so the
          // same upsert handles both paths — it just replaces the optimist.
          this.upsertConfirmed(message);
          this.emit();
        } catch (err) {
          const isSendError = err instanceof SendError;
          const retryable = isSendError ? err.retryable : true;

          if (retryable) {
            // Stay in the outbox; the message is not lost.
            const cur = this.pending.get(draft.clientMessageId);
            if (cur) this.pending.set(draft.clientMessageId, { ...cur, local: 'queued' });
            shouldRetry = true;
            this.emit();
            break; // preserve order: do not send later messages first
          }

          const cur = this.pending.get(draft.clientMessageId);
          if (cur) this.pending.set(draft.clientMessageId, { ...cur, local: 'failed' });
          this.emit();
        }
      }
    } finally {
      this.flushing = false;
      if (shouldRetry) this.scheduleRetry();
      this.emit();
    }
  }

  /** Explicit user retry from the failed-bubble UI. */
  async retry(clientMessageId: string): Promise<void> {
    const cur = this.pending.get(clientMessageId);
    if (cur) this.pending.set(clientMessageId, { ...cur, local: 'queued' });
    this.emit();
    await this.flush();
  }

  // ----------------------------------------------------------------
  // Pagination
  // ----------------------------------------------------------------

  async loadOlder(): Promise<void> {
    if (!this.conversationId) return;
    if (this.state.loadingOlder || !this.state.hasMore) return;

    const oldest = this.confirmed[0];
    this.state = { ...this.state, loadingOlder: true };
    this.emit();

    try {
      const { messages, hasMore } = await fetchTimeline(
        this.conversationId,
        oldest ? oldest.seq : null,
        PAGE_SIZE
      );
      const known = new Set(this.confirmed.map((m) => m.id));
      const fresh = messages.filter((m) => !known.has(m.id));
      this.confirmed = [...fresh, ...this.confirmed];
      this.state = { ...this.state, hasMore, loadingOlder: false };
    } catch (err) {
      this.state = {
        ...this.state,
        loadingOlder: false,
        error: err instanceof Error ? err.message : 'Failed to load older messages',
      };
    }
    this.emit();
  }

  // ----------------------------------------------------------------
  // Read state
  // ----------------------------------------------------------------

  async markReadUpToLatest(): Promise<void> {
    if (!this.conversationId || !this.userId) return;
    const latest = this.confirmed[this.confirmed.length - 1];
    if (!latest) return;
    await markRead(this.conversationId, this.userId, latest.seq);
  }

  async markDeliveredUpToLatest(): Promise<void> {
    if (!this.conversationId || !this.userId) return;
    const latest = this.confirmed[this.confirmed.length - 1];
    if (!latest) return;
    await markDelivered(this.conversationId, this.userId, latest.seq);
  }

  // ----------------------------------------------------------------
  // Message actions
  // ----------------------------------------------------------------

  async react(messageId: string, emoji: string): Promise<void> {
    if (!this.userId || isTempId(messageId)) return;
    const target = this.confirmed.find((m) => m.id === messageId);
    if (!target) return;

    const already = target.reactions.some(
      (r) => r.userId === this.userId && r.emoji === emoji
    );

    // Optimistic toggle.
    target.reactions = already
      ? target.reactions.filter((r) => !(r.userId === this.userId && r.emoji === emoji))
      : [
          ...target.reactions,
          { messageId, userId: this.userId, emoji, createdAt: new Date().toISOString() },
        ];
    this.emit();

    try {
      if (already) await apiUnreact(this.userId, messageId, emoji);
      else await apiReact(this.userId, messageId, emoji);
    } catch {
      void this.refreshReactions(); // roll back to server truth
    }
  }

  async edit(messageId: string, body: MessageBody): Promise<void> {
    const target = this.confirmed.find((m) => m.id === messageId);
    const previous = target?.body;
    if (target) {
      target.body = body;
      target.editedAt = new Date().toISOString();
      this.emit();
    }
    try {
      await apiEdit(messageId, body);
    } catch (err) {
      if (target && previous) {
        target.body = previous;
        this.emit();
      }
      throw err;
    }
  }

  async delete(messageId: string, forEveryone: boolean): Promise<void> {
    if (!this.userId) return;
    await apiDelete(this.userId, messageId, forEveryone);
    // Either way the message leaves THIS client's timeline: delete-for-everyone
    // soft-deletes it server-side and the realtime broadcast removes it
    // elsewhere; delete-for-me is local to this user only.
    this.confirmed = this.confirmed.filter((m) => m.id !== messageId);
    this.emit();
  }

  // ----------------------------------------------------------------
  // Pin, unread, forward, polls
  // ----------------------------------------------------------------

  async pin(messageId: string, pinned: boolean): Promise<void> {
    if (!this.userId) return;
    const target = this.confirmed.find((m) => m.id === messageId);
    const previous = target ? { at: target.pinnedAt, by: target.pinnedBy } : null;

    if (target) {
      target.pinnedAt = pinned ? new Date().toISOString() : null;
      target.pinnedBy = pinned ? this.userId : null;
      this.emit();
    }

    try {
      await apiSetPinned(messageId, this.userId, pinned);
    } catch (err) {
      if (target && previous) {
        target.pinnedAt = previous.at;
        target.pinnedBy = previous.by;
        this.emit();
      }
      throw err;
    }
  }

  /** The thread's pinned messages, most recently pinned first (cap 3). */
  async loadPinned(): Promise<Message[]> {
    if (!this.conversationId) return [];
    this.pinned = await fetchPinned(this.conversationId);
    this.emit();
    return this.pinned;
  }

  getPinned(): Message[] {
    return this.pinned;
  }

  /** Leave exactly one unread so the inbox badge reads "1" (§4). */
  async markUnread(): Promise<void> {
    if (!this.conversationId || !this.userId) return;
    await apiMarkUnread(this.conversationId, this.userId);
  }

  async forward(message: Message, targetConversationId: string): Promise<void> {
    if (!this.userId) return;
    await apiForward(
      this.userId,
      {
        id: message.id,
        kind: message.kind,
        body: message.body,
        mediaUrl: message.legacyMediaUrl,
      },
      targetConversationId,
      newClientMessageId()
    );
  }

  /**
   * §29 — a poll is two rows (a message + a polls row), so it goes straight to
   * the API rather than through the outbox. The confirm arrives by realtime.
   */
  async createPoll(conversationId: string, draft: PollDraft): Promise<void> {
    if (!this.userId) return;
    await apiCreatePoll(this.userId, conversationId, draft, newClientMessageId());
  }

  // ----------------------------------------------------------------
  // Typing
  // ----------------------------------------------------------------

  /**
   * Debounced so a keystroke never becomes a network call. Emits `on` at
   * most once per 3s while the user is active, then `off` after 4s idle.
   */
  setTyping(active: boolean, kind: TypingSignal['kind'] = 'typing'): void {
    const sub = this.subscription;
    if (!sub) return;

    if (active) {
      if (!this.typingActive) {
        this.typingActive = true;
        sub.sendTyping(kind, true);
      }
      if (this.typingTimer) clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => {
        this.typingActive = false;
        sub.sendTyping(kind, false);
        this.typingTimer = null;
      }, 4000);
      return;
    }

    if (this.typingActive) {
      this.typingActive = false;
      sub.sendTyping(kind, false);
    }
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
  }

  /** Call on send so the recipient's indicator clears immediately. */
  stopTyping(): void {
    this.setTyping(false);
  }

  /**
   * The other presence kinds (§25, §26): "recording…" and "sending a file…".
   * Sent straight out with no debounce state of their own, so they cannot
   * interfere with the typing indicator's single-flight flag.
   */
  emitPresence(kind: 'recording' | 'uploading', on: boolean): void {
    this.subscription?.sendTyping(kind, on);
  }

  /**
   * Broadcast a call signal to the other participant(s).
   *
   * Silence when there is no subscription is intentional: before the channel
   * is open there is nobody to signal, and throwing here would turn a transient
   * transport gap into a crash on the tap that started the call.
   */
  sendCall(signal: CallSignal): void {
    this.subscription?.sendCall(signal);
  }
}

/** One engine per open conversation; the hook owns its instance. */
export function createEngine(): ConversationEngine {
  return new ConversationEngine();
}
