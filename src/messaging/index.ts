// src/messaging/index.ts
// ------------------------------------------------------------------
// Public surface of the Conversation Engine.
//
// Import from here, never from the individual files:
//   import { useConversation, createRegistry } from '../messaging';
// ------------------------------------------------------------------

export {
  MESSAGE_KINDS,
  SendError,
  emptyTimeline,
  isMessageKind,
  mapRow,
  parseBody,
  MESSAGE_SELECT,
  SQLSTATE_INSUFFICIENT_PRIVILEGE,
  SQLSTATE_UNIQUE_VIOLATION,
} from './types';

export type {
  Attachment,
  ConnectionStatus,
  DeliveryState,
  LocalState,
  Message,
  MessageBody,
  MessageKind,
  MessageRow,
  OutgoingDraft,
  Reaction,
  SendErrorCode,
  SendOptions,
  SystemEvent,
  TimelineState,
} from './types';

export {
  PAGE_SIZE,
  currentUserId,
  signedMediaUrl,
  consumeViewOnce,
  recordView,
  fetchMyViews,
} from './api';

export { ConversationEngine, createEngine } from './engine';
export { outbox } from './outbox';
export { createRegistry, missingKinds, resolveRenderer } from './registry';
export type { BubbleProps, MessageRenderer, RendererRegistry } from './registry';
export { useConversation } from './useConversation';
export type { UseConversationResult } from './useConversation';
export type { Subscription, TransportHandlers, TypingSignal } from './transport';
