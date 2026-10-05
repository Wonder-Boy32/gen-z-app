// ============================================================
// MessageList — the virtualised timeline.
//
// NOTE ON PERFORMANCE, stated honestly: architecture doc §12.3
// recommends FlatList's getItemLayout for predictable heights.
// In practice text bubbles have intrinsically variable height, and
// a WRONG getItemLayout is worse than none — it makes the list jump
// while scrolling. So it is deliberately NOT passed here. Media
// boxes keep a fixed WIDTH and a bounded height, which still keeps
// most rows stable.
// The correct fix for very large threads is FlashList, which takes
// an `estimatedItemSize` instead of an exact one. That swap is a
// drop-in change to this file only.
// ============================================================

import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../../theme';
import type { Message } from '../../messaging';
import MessageBubble from './MessageBubble';
import CallHistoryRow, { type CallRow } from './CallHistoryRow';
import { RUN_BREAK_MS, dayLabel, sameDay } from './chatVisuals';

export interface BubblePalette {
  myBg: string;
  myText: string;
  myTime: string;
  theirBg: string;
  theirText: string;
}

export interface MessageListProps {
  messages: Message[];
  /** call history, interleaved into the timeline at its real place in time */
  calls: CallRow[];
  meId: string | null;
  isGroup: boolean;
  typingNames: string[];
  loadingOlder: boolean;
  hasMore: boolean;
  palette: BubblePalette;
  nameFor: (senderId: string) => string | undefined;
  seenFor: (message: Message) => boolean;
  onLoadOlder: () => void;
  onRetry: (clientMessageId: string) => void;
  onReact: (message: Message, emoji: string) => void;
  onLongPress: (message: Message) => void;
  onOpenMedia: (message: Message) => void;
  onOpenSender: (senderId: string) => void;
}

type Row =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'typing' }
  | { key: string; type: 'call'; call: CallRow }
  | { key: string; type: 'msg'; message: Message; grouped: boolean; lastInRun: boolean };

/** A run continues while the speaker is unchanged, the day is unchanged,
 *  and the gap stays under the run-break threshold. */
function withinRun(prev: Message, cur: Message): boolean {
  if (prev.senderId !== cur.senderId) return false;
  if (!sameDay(prev.createdAt, cur.createdAt)) return false;
  return (
    new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() < RUN_BREAK_MS
  );
}

/** One-line description of a message, for the reply-quote strip. */
function previewOf(parent: Message | null, senderName?: string): string {
  if (!parent) return 'Original message';

  const who = senderName ? `${senderName}: ` : '';
  const b = parent.body;

  switch (b.type) {
    case 'text':
      return `${who}${b.text}`;
    case 'image':
      return `${who}📷 Photo`;
    case 'video':
    case 'video_message':
      return `${who}🎥 Video`;
    case 'voice':
      return `${who}🎙️ Voice message`;
    case 'file':
      return `${who}📎 ${b.fileName}`;
    case 'gif':
      return `${who}GIF`;
    case 'sticker':
      return `${who}Sticker`;
    case 'location':
      return `${who}📍 Location`;
    case 'contact':
      return `${who}👤 ${b.name}`;
    case 'poll':
      return `${who}📊 Poll`;
    default:
      return `${who}Message`;
  }
}

/** Imperative handle — used for tap-quote-to-jump and search-result jumps. */
export interface MessageListHandle {
  /** Returns false when the target is outside the loaded window. */
  scrollToMessage: (messageId: string) => boolean;
}

const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  props,
  ref
) {
  const {
    messages,
    calls,
    meId,
    isGroup,
    typingNames,
    loadingOlder,
    hasMore,
    palette,
    nameFor,
    seenFor,
    onLoadOlder,
    onRetry,
    onReact,
    onLongPress,
    onOpenMedia,
    onOpenSender,
  } = props;

  const listRef = useRef<FlatList<Row>>(null);

  // Chronological rows, then reversed for an inverted FlatList — which keeps
  // the newest message pinned to the bottom without a scrollToEnd hack.
  // Reply parents are resolved against the messages we actually hold, so a
  // quoted bubble shows real text rather than a raw uuid.
  const byId = useMemo(() => {
    const m = new Map<string, Message>();
    for (const msg of messages) m.set(msg.id, msg);
    return m;
  }, [messages]);

  /**
   * Resolve the quoted parent's text. Note this names the PARENT's sender, not
   * the current message's — quoting your own reply must still show who was
   * originally quoted.
   */
  const replyPreviewFor = useCallback(
    (m: Message): string | null => {
      if (!m.replyTo) return null;
      const parent = byId.get(m.replyTo) ?? null;
      return previewOf(parent, parent ? nameFor(parent.senderId) : undefined);
    },
    [byId, nameFor]
  );

  const rows = useMemo<Row[]>(() => {
    // Calls and messages share ONE timeline. A call is an event, not a message
    // — it has no body, nothing to reply to and nothing to react to — so it is
    // interleaved by time rather than coerced into the message shape.
    type Entry = { at: number; iso: string; msg?: Message; call?: CallRow };

    const entries: Entry[] = [
      ...messages.map((m) => ({ at: new Date(m.createdAt).getTime(), iso: m.createdAt, msg: m })),
      ...calls.map((c) => ({
        at: new Date(c.started_at).getTime(),
        iso: c.started_at,
        call: c,
      })),
    ].sort((a, b) => a.at - b.at);

    const out: Row[] = [];

    for (let i = 0; i < entries.length; i += 1) {
      const cur = entries[i];
      const prev = i > 0 ? entries[i - 1] : null;
      const next = i + 1 < entries.length ? entries[i + 1] : null;

      // Day dividers are driven by the merged stream, so a call on a new day
      // opens that day rather than appearing under the previous one.
      if (!prev || !sameDay(prev.iso, cur.iso)) {
        out.push({ key: `d-${cur.iso}-${i}`, type: 'date', label: dayLabel(cur.iso) });
      }

      if (cur.call) {
        out.push({ key: `c-${cur.call.id}`, type: 'call', call: cur.call });
        continue;
      }

      const m = cur.msg as Message;
      // Runs are resolved against the neighbouring MESSAGES. A call sitting
      // between two bubbles means they are not adjacent on screen, so the run
      // breaks there and no grouped tail is drawn pointing at a call row.
      const prevMsg = prev?.msg ?? null;
      const nextMsg = next?.msg ?? null;

      out.push({
        key: m.clientMessageId ?? m.id,
        type: 'msg',
        message: m,
        grouped: !!prevMsg && withinRun(prevMsg, m),
        lastInRun: !nextMsg || !withinRun(m, nextMsg),
      });
    }

    if (typingNames.length > 0) out.push({ key: 'typing', type: 'typing' });

    return out.reverse();
  }, [messages, calls, typingNames]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage(messageId: string) {
        const index = rows.findIndex(
          (r) => r.type === 'msg' && r.message.id === messageId
        );
        if (index < 0) return false;
        listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
        return true;
      },
    }),
    [rows]
  );

  return (
    <FlatList
      ref={listRef}
      data={rows}
      inverted
      keyExtractor={(item: Row) => item.key}
      // Long threads have variable-height rows, so an index can briefly be
      // unmeasurable. Rather than crash, drop the jump and stay where we are.
      onScrollToIndexFailed={() => undefined}
      style={styles.list}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={20}
      maxToRenderPerBatch={10}
      updateCellsBatchingPeriod={50}
      windowSize={11}
      removeClippedSubviews
      onEndReached={hasMore ? onLoadOlder : undefined}
      onEndReachedThreshold={0.4}
      ListFooterComponent={
        loadingOlder ? (
          <View style={styles.footer}>
            <ActivityIndicator size="small" color={colors.textFaint} />
          </View>
        ) : null
      }
      renderItem={({ item }: { item: Row }) => {
        if (item.type === 'date') {
          return (
            <View style={styles.dateRow}>
              <View style={styles.datePill}>
                <Text style={styles.dateText}>{item.label}</Text>
              </View>
            </View>
          );
        }

        if (item.type === 'typing') {
          return (
            <View style={styles.typingRow}>
              <Text style={styles.typingText}>
                {typingNames.length === 1
                  ? `${typingNames[0]} is typing…`
                  : `${typingNames.slice(0, 2).join(', ')} are typing…`}
              </Text>
            </View>
          );
        }

        if (item.type === 'call') {
          return <CallHistoryRow call={item.call} me={meId} />;
        }

        const m = item.message;
        const isMine = !!meId && m.senderId === meId;

        return (
          <MessageBubble
            message={m}
            isMine={isMine}
            grouped={item.grouped}
            lastInRun={item.lastInRun}
            seen={isMine ? seenFor(m) : undefined}
            palette={palette}
            isGroup={isGroup}
            senderName={nameFor(m.senderId)}
            onRetry={onRetry}
            onReact={onReact}
            onLongPress={onLongPress}
            onOpenMedia={onOpenMedia}
            onOpenSender={onOpenSender}
            replyPreview={replyPreviewFor(m)}
          />
        );
      }}
    />
  );
});

export default MessageList;

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  footer: { paddingVertical: spacing.md, alignItems: 'center' },
  dateRow: { alignItems: 'center', marginVertical: spacing.md },
  datePill: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  dateText: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.4 },
  typingRow: { paddingVertical: spacing.sm, paddingLeft: spacing.md },
  typingText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic' },
});
