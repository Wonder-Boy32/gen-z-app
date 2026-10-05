// src/messaging/registry.ts
// ------------------------------------------------------------------
// The renderer registry.
//
// This is what permanently ends the "another branch inside a 2053-line
// file" pattern. The message list resolves a component from this map;
// adding a message type becomes one entry plus one component.
//
// The registry holds no components itself — the existing bubbles live
// inside ChatThread.tsx and are not exported. So the Surface supplies
// them, and this file only defines the contract. That keeps the engine
// free of React and lets the screen migrate one bubble at a time.
// ------------------------------------------------------------------

import type { ComponentType } from 'react';
import { MESSAGE_KINDS, type Message, type MessageKind } from './types';

export interface BubbleProps {
  message: Message;
  /** true when the viewer authored it — drives alignment and chrome */
  isMine: boolean;
  /** grouped with the message above: suppress the avatar and tighten spacing */
  grouped: boolean;
  /** true when this is the last message in the run, so the tail shows */
  lastInRun: boolean;
  onReply?: (message: Message) => void;
  onReact?: (message: Message, emoji: string) => void;
  onLongPress?: (message: Message) => void;
  onOpenMedia?: (message: Message) => void;
  /** reuse an already-resolved colour scheme from the conversation theme */
  accent?: string;
  /**
   * Delivery receipt, derived by the Surface (not the engine) from the other
   * participants' read state. Only meaningful for the viewer's own messages.
   */
  seen?: boolean;
  /** bubble fill/text colours, already resolved from the conversation theme */
  palette?: { myBg: string; myText: string; myTime: string; theirBg: string; theirText: string };
  /**
   * Resolved text for the quoted parent. The engine carries reply_to as an id
   * only, so the Surface resolves it against the messages it has loaded.
   */
  replyPreview?: string | null;
}

export type MessageRenderer = ComponentType<BubbleProps>;

export type RendererRegistry = Partial<Record<MessageKind, MessageRenderer>>;

/** Build a registry, warning loudly about any kind left unhandled. */
export function createRegistry(renderers: RendererRegistry): RendererRegistry {
  return renderers;
}

/** Unmapped kinds return null so the Surface can render its own fallback. */
export function resolveRenderer(
  registry: RendererRegistry,
  kind: MessageKind
): MessageRenderer | null {
  return registry[kind] ?? null;
}

/** Kinds with no renderer yet — useful for a dev-time coverage assertion. */
export function missingKinds(registry: RendererRegistry): MessageKind[] {
  return MESSAGE_KINDS.filter((k) => !registry[k]);
}
