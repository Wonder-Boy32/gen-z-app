// src/messaging/outbox.ts
// ------------------------------------------------------------------
// A durable, ordered outbox.
//
// This is the file that makes the app feel unbroken with no
// connection. A message typed offline is written here and survives
// an app kill; it is flushed in order when connectivity returns.
//
// Persistence is AsyncStorage rather than SQLite on purpose: the
// outbox is bounded (we cap it), the writes are tiny, and AsyncStorage
// is already a dependency. If the outbox ever needs to hold hundreds
// of media items, move this to SQLite behind the same interface.
// ------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OutgoingDraft } from './types';

const KEY = 'messaging:outbox:v1';

/** Hard cap so a permanently-offline device cannot grow without bound. */
const MAX_ENTRIES = 200;

type Listener = (drafts: OutgoingDraft[]) => void;

export class Outbox {
  private drafts: OutgoingDraft[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  /** Read persisted state into memory. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.drafts = parsed.filter(isDraft);
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[messaging] outbox load failed:', err);
      this.drafts = [];
    }
    this.loaded = true;
    this.emit();
  }

  /**
   * Serialise persistence. Concurrent sends must not interleave
   * read-modify-write on the same key, or drafts get lost.
   */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.drafts);
    this.writeChain = this.writeChain
      .then(() => AsyncStorage.setItem(KEY, snapshot))
      .catch((err) => {
        if (__DEV__) console.warn('[messaging] outbox persist failed:', err);
      });
    return this.writeChain;
  }

  snapshot(): OutgoingDraft[] {
    return this.drafts.slice();
  }

  /** Drafts for one conversation, oldest first — the flush order. */
  forConversation(conversationId: string): OutgoingDraft[] {
    return this.drafts.filter((d) => d.conversationId === conversationId);
  }

  has(clientMessageId: string): boolean {
    return this.drafts.some((d) => d.clientMessageId === clientMessageId);
  }

  append(draft: OutgoingDraft): void {
    if (this.has(draft.clientMessageId)) return;

    this.drafts.push(draft);
    if (this.drafts.length > MAX_ENTRIES) {
      // Drop the oldest non-per-conversation excess rather than refusing the
      // newest message — the newest is what the user is looking at.
      this.drafts.splice(0, this.drafts.length - MAX_ENTRIES);
    }
    this.emit();
    void this.persist();
  }

  remove(clientMessageId: string): void {
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((d) => d.clientMessageId !== clientMessageId);
    if (this.drafts.length !== before) {
      this.emit();
      void this.persist();
    }
  }

  /** Used on sign-out. Prevents user A's queue flushing under user B. */
  clear(): void {
    this.drafts = [];
    this.emit();
    void this.persist();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

function isDraft(value: unknown): value is OutgoingDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversationId === 'string' &&
    typeof v.clientMessageId === 'string' &&
    typeof v.kind === 'string' &&
    !!v.body &&
    typeof v.body === 'object'
  );
}

/** Single shared instance; the engine owns its lifecycle. */
export const outbox = new Outbox();
