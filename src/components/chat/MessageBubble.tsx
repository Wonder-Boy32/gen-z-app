// ============================================================
// MessageBubble — the unit of the conversation surface.
//
// Tail-less by design. Attribution is carried by the 2px leading
// rail on incoming runs, so grouping reads as a scan-line instead
// of a stack of boxes. See architecture doc §11.2.
//
// One component, every message kind. Adding a kind means adding a
// branch here, NOT a new file that the list has to know about.
// ============================================================

import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import Icon from '../ui/Icon';
import { colors, radius, spacing } from '../../theme';
import PollCard from './PollCard';
import type { BubbleProps } from '../../messaging';
import type { Message, MessageBody } from '../../messaging';
import {
  BUBBLE_RADIUS,
  GROUP_GAP,
  MAX_WIDTH_MINE,
  MAX_WIDTH_THEIRS,
  RAIL_RADIUS,
  RAIL_WIDTH,
  cornerFor,
  ensureReadable,
  fmtBytes,
  fmtDuration,
  fmtTime,
  readableTime,
} from './chatVisuals';

/** Media box width. Height is chosen per item — see the bounds below. */
const MEDIA_W = 216;
/** Default height: used for video, and for a picture until its real size is read. */
const MEDIA_H = 162;
/**
 * Bounds for a picture's rendered height.
 *
 * The frame now follows the picture's own proportions instead of being pinned to
 * a 4:3 box, so the whole image is visible. These clamps stop an extreme panorama
 * collapsing to a sliver and an extreme portrait eating the thread; between them
 * the frame matches the image exactly. MessageList deliberately passes no
 * getItemLayout (see its header note), so a variable row height is safe here.
 */
const MEDIA_MIN_H = 120;
const MEDIA_MAX_H = 320;

export interface ChatBubbleProps extends BubbleProps {
  senderName?: string;
  isGroup?: boolean;
  avatarUrl?: string | null;
  onRetry?: (clientMessageId: string) => void;
  onOpenSender?: (senderId: string) => void;
}

export default function MessageBubble(props: ChatBubbleProps) {
  const { message, isMine, grouped, lastInRun, seen, onReact, onLongPress, onOpenMedia } = props;

  const theme = props.palette ?? {
    myBg: colors.accent,
    myText: colors.bg,
    myTime: 'rgba(6,10,22,0.70)',
    theirBg: colors.surfaceAlt,
    theirText: colors.text,
  };
  const bg = isMine ? theme.myBg : theme.theirBg;
  const fg = ensureReadable(isMine ? theme.myText : theme.theirText, bg);
  const timeColor = readableTime(isMine ? theme.myTime : colors.textFaint, bg);

  const deleted = !!message.deletedAt;
  const failed = message.local === 'failed';
  const pending = message.local === 'queued' || message.local === 'sending';

  return (
    <View
      style={[
        styles.row,
        isMine ? styles.rowMine : styles.rowTheirs,
        grouped ? { marginTop: GROUP_GAP } : undefined,
      ]}
      accessibilityRole="text"
      accessibilityLabel={describe(message, isMine, props.senderName)}
    >
      {/* the rail: only on the first bubble of an incoming run */}
      {!isMine && (
        <View
          style={[
            styles.rail,
            {
              backgroundColor: theme.myBg,
              opacity: grouped ? 0 : 0.85,
              width: grouped ? 0 : RAIL_WIDTH,
              marginRight: grouped ? 0 : spacing.sm,
            },
          ]}
        />
      )}

      <Pressable
        onLongPress={() => onLongPress?.(message)}
        delayLongPress={280}
        style={[
          styles.bubble,
          { backgroundColor: bg },
          cornerFor(isMine, lastInRun),
          isMine ? styles.bubbleMine : styles.bubbleTheirs,
          failed && styles.bubbleFailed,
        ]}
      >
        {/* sender name — group chats only, first bubble of a run */}
        {props.isGroup && !isMine && !grouped && (
          <Pressable onPress={() => props.onOpenSender?.(message.senderId)}>
            <Text style={[styles.sender, { color: theme.myBg }]} numberOfLines={1}>
              {props.senderName ?? 'Member'}
            </Text>
          </Pressable>
        )}

        {/* reply quote */}
        {!!message.replyTo && <ReplyQuote preview={props.replyPreview ?? null} fg={fg} />}

        {deleted ? (
          <Text style={[styles.deleted, { color: fg }]}>This message was deleted</Text>
        ) : (
          <BubbleContent
            message={message}
            fg={fg}
            bg={bg}
            isMine={isMine}
            onOpenMedia={onOpenMedia}
          />
        )}

        {/* footer: time + send state */}
        <View style={styles.footer}>
          {!!message.editedAt && !deleted && (
            <Text style={[styles.meta, { color: timeColor }]}>edited</Text>
          )}
          <Text style={[styles.meta, { color: timeColor }]}>{fmtTime(message.createdAt)}</Text>
          {isMine && !deleted && (
            <SendState failed={failed} pending={pending} seen={!!seen} color={timeColor} />
          )}
        </View>
      </Pressable>

      {/* reactions, anchored under the bubble on the outgoing/incoming side */}
      {message.reactions.length > 0 && (
        <ReactionRow
          message={message}
          isMine={isMine}
          myId={props.message.senderId}
          onReact={onReact}
        />
      )}

      {failed && (
        <Pressable
          style={styles.retry}
          onPress={() => props.onRetry?.(message.clientMessageId ?? '')}
          accessibilityRole="button"
          accessibilityLabel="Retry sending this message"
        >
          <Icon name="refresh" size={13} color={colors.danger} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
}

// ------------------------------------------------------------
// Content by kind
// ------------------------------------------------------------

function BubbleContent({
  message,
  fg,
  bg,
  isMine,
  onOpenMedia,
}: {
  message: Message;
  fg: string;
  bg: string;
  isMine: boolean;
  onOpenMedia?: (m: Message) => void;
}) {
  const body = message.body;

  // View-once short-circuits every kind — a Moment is a Moment.
  if (message.viewOnce) {
    return <MomentBody message={message} fg={fg} isMine={isMine} onOpenMedia={onOpenMedia} />;
  }

  switch (body.type) {
    case 'text':
      return <Text style={[styles.text, { color: fg }]}>{body.text}</Text>;

    case 'image':
      return (
        <View>
          <Media uri={message.legacyMediaUrl} kind="image" onPress={() => onOpenMedia?.(message)} />
          {!!body.caption && <Text style={[styles.caption, { color: fg }]}>{body.caption}</Text>}
        </View>
      );

    case 'video':
    case 'video_message':
      return (
        <View>
          <Media uri={message.legacyMediaUrl} kind="video" onPress={() => onOpenMedia?.(message)} />
          {'caption' in body && !!body.caption && (
            <Text style={[styles.caption, { color: fg }]}>{body.caption}</Text>
          )}
          {'durationMs' in body && (
            <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>
              {fmtDuration(body.durationMs)}
            </Text>
          )}
        </View>
      );

    case 'gif':
    case 'sticker':
      return <Media uri={message.legacyMediaUrl} kind="image" onPress={() => onOpenMedia?.(message)} />;

    case 'voice':
      return message.legacyMediaUrl ? (
        <VoicePlayer uri={message.legacyMediaUrl} fg={fg} durationMs={body.durationMs} />
      ) : (
        <Text style={[styles.meta, { color: fg }]}>Voice message</Text>
      );

    case 'file':
      return (
        <View style={styles.fileRow}>
          <Icon name="document-outline" size={26} color={fg} />
          <View style={styles.fileMeta}>
            <Text style={[styles.fileName, { color: fg }]} numberOfLines={1}>
              {body.fileName}
            </Text>
            <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>{fmtBytes(body.byteSize)}</Text>
          </View>
        </View>
      );

    case 'location':
      return (
        <View style={styles.fileRow}>
          <Icon name="location-outline" size={24} color={fg} />
          <View style={styles.fileMeta}>
            <Text style={[styles.fileName, { color: fg }]} numberOfLines={1}>
              {body.label ?? 'Location'}
            </Text>
            <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>
              {body.lat.toFixed(5)}, {body.lng.toFixed(5)}
            </Text>
          </View>
        </View>
      );

    case 'contact':
      return (
        <View style={styles.fileRow}>
          <Icon name="person-circle-outline" size={26} color={fg} />
          <View style={styles.fileMeta}>
            <Text style={[styles.fileName, { color: fg }]} numberOfLines={1}>
              {body.name}
            </Text>
            {!!body.phone && (
              <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>{body.phone}</Text>
            )}
          </View>
        </View>
      );

    case 'poll':
      // The message body only carries the poll's id; PollCard owns its own
      // fetch, loading state and vote handling, so a poll failure degrades to
      // a label instead of taking the whole bubble down.
      return body.pollId ? (
        <PollCard pollId={body.pollId} messageId={message.id} isMine={isMine} fg={fg} bg={bg} />
      ) : (
        <View style={styles.fileRow}>
          <Icon name="stats-chart-outline" size={24} color={fg} />
          <Text style={[styles.fileName, { color: fg }]}>Poll</Text>
        </View>
      );

    case 'audio':
      return (
        <View style={styles.fileRow}>
          <Icon name="musical-notes-outline" size={24} color={fg} />
          <View style={styles.fileMeta}>
            <Text style={[styles.fileName, { color: fg }]} numberOfLines={1}>
              {body.title ?? 'Audio'}
            </Text>
            <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>
              {fmtDuration(body.durationMs)}
            </Text>
          </View>
        </View>
      );

    case 'system':
      return <Text style={[styles.meta, { color: fg, opacity: 0.85 }]}>{body.event}</Text>;

    default: {
      // Unknown or legacy kind: never render an empty bubble.
      const legacy = message.legacyMediaUrl;
      if (legacy) return <Media uri={legacy} kind="image" onPress={() => onOpenMedia?.(message)} />;
      return <Text style={[styles.meta, { color: fg }]}>Unsupported message</Text>;
    }
  }
}

function MomentBody({
  message,
  fg,
  isMine,
  onOpenMedia,
}: {
  message: Message;
  fg: string;
  isMine: boolean;
  onOpenMedia?: (m: Message) => void;
}) {
  const openedByMe = message.viewedBy.length > 0 && !isMine;

  const label = isMine
    ? 'Moment'
    : openedByMe
      ? 'Moment · opened'
      : 'Moment · tap to open';

  return (
    <Pressable
      disabled={isMine || openedByMe}
      onPress={() => onOpenMedia?.(message)}
      style={styles.moment}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={openedByMe ? 'eye-off-outline' : 'flash-outline'} size={22} color={fg} />
      <View style={styles.fileMeta}>
        <Text style={[styles.fileName, { color: fg }]}>{label}</Text>
        <Text style={[styles.meta, { color: fg, opacity: 0.7 }]}>
          {isMine ? 'View once' : openedByMe ? 'Already viewed' : 'Disappears once opened'}
        </Text>
      </View>
    </Pressable>
  );
}

function ReplyQuote({ preview, fg }: { preview: string | null; fg: string }) {
  return (
    <View style={[styles.quote, { borderLeftColor: fg }]}>
      <Icon name="arrow-undo-outline" size={12} color={fg} />
      <Text style={[styles.quoteText, { color: fg }]} numberOfLines={2}>
        {/* The parent may have fallen outside the loaded window (paginated
            history), so "original message" is a real state, not an error. */}
        {preview ?? 'Original message'}
      </Text>
    </View>
  );
}

function Media({
  uri,
  kind,
  onPress,
}: {
  uri: string | null;
  kind: 'image' | 'video';
  onPress?: () => void;
}) {
  // A URI that is SET but fails to LOAD previously rendered as a silent blank
  // box. The guard below only catches a MISSING url, and <Image> draws nothing
  // at all when its fetch fails — so a dead or unauthorised media URL produced
  // exactly the "white blank with nothing in it" that was reported, with no
  // clue as to why. Tracking the failure makes an invisible problem visible.
  const [failed, setFailed] = useState(false);

  // The picture's real proportions, read from the image itself.
  //
  // The bubble used to be a FIXED 216x162 frame with resizeMode="cover", which
  // cropped every photo that was not exactly 4:3 — portraits lost their tops and
  // bottoms, which is the "I want the full view of the picture" report. A message
  // carries no dimension metadata, so the image is the only source of truth.
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!uri || kind !== 'image') return;
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => {
        if (!cancelled && w > 0 && h > 0) setRatio(w / h);
      },
      // A failed probe is not worth surfacing — the default frame still renders.
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [uri, kind]);

  if (!uri || failed) {
    return (
      <View style={[styles.media, styles.mediaEmpty]}>
        <Icon name="image-outline" size={26} color={colors.textFaint} />
        <Text style={styles.mediaEmptyText}>
          {uri ? "Couldn't load media" : 'Media unavailable'}
        </Text>
      </View>
    );
  }

  // Follow the picture's own proportions so the whole frame fits, clamped so
  // neither a panorama nor a tall portrait can dominate the thread.
  const imageFrame =
    kind === 'image' && ratio
      ? { height: Math.min(Math.max(MEDIA_W / ratio, MEDIA_MIN_H), MEDIA_MAX_H) }
      : null;

  return (
    <Pressable onPress={onPress} style={[styles.media, imageFrame]}>
      <Image
        source={{ uri }}
        style={styles.mediaImage}
        // 'contain' for pictures, NOT 'cover'. With a clamped frame a cover fit
        // would crop again — the exact bug being fixed. Anything that does not
        // fill the frame is letterboxed against the bubble instead of cut off.
        // Video keeps 'cover' so its thumbnail still fills the frame.
        resizeMode={kind === 'image' ? 'contain' : 'cover'}
        onError={() => setFailed(true)}
      />
      {kind === 'video' && (
        <View style={styles.playOverlay}>
          <Icon name="play" size={26} color="#fff" />
        </View>
      )}
    </Pressable>
  );
}

function VoicePlayer({ uri, fg, durationMs }: { uri: string; fg: string; durationMs: number }) {
  const player = useAudioPlayer(uri);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s: { playing?: boolean; currentTime?: number }) => {
      setPlaying(!!s.playing);
      setPos(s.currentTime ?? 0);
    });
    return () => sub.remove();
  }, [player]);

  const total = durationMs > 0 ? durationMs / 1000 : 1;
  const pct = Math.min((pos / total) * 100, 100);

  return (
    <Pressable
      style={styles.voiceRow}
      onPress={() => (player.playing ? player.pause() : player.play())}
      accessibilityRole="button"
      accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
    >
      <Icon name={playing ? 'pause' : 'play'} size={16} color={fg} />
      <View style={[styles.voiceTrack, { backgroundColor: fg, opacity: 0.25 }]}>
        <View style={[styles.voiceFill, { width: `${pct}%`, backgroundColor: fg }]} />
      </View>
      <Text style={[styles.meta, { color: fg }]}>{fmtDuration(durationMs || pos * 1000)}</Text>
    </Pressable>
  );
}

function SendState({
  failed,
  pending,
  seen,
  color,
}: {
  failed: boolean;
  pending: boolean;
  seen: boolean;
  color: string;
}) {
  if (failed) return <Icon name="alert-circle" size={13} color={colors.danger} />;
  if (pending) return <Icon name="time-outline" size={13} color={color} />;
  return <Icon name={seen ? 'checkmark-done' : 'checkmark'} size={13} color={color} />;
}

function ReactionRow({
  message,
  isMine,
  onReact,
}: {
  message: Message;
  isMine: boolean;
  myId: string;
  onReact?: (m: Message, emoji: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const r of message.reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);

  return (
    <View style={[styles.reactions, isMine ? styles.reactionsMine : styles.reactionsTheirs]}>
      {[...counts.entries()].map(([emoji, n]) => (
        <Pressable
          key={emoji}
          onPress={() => onReact?.(message, emoji)}
          style={styles.reactionChip}
          accessibilityRole="button"
          accessibilityLabel={`${emoji} ${n}`}
        >
          <Text style={styles.reactionEmoji}>{emoji}</Text>
          {n > 1 && <Text style={styles.reactionCount}>{n}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

// ------------------------------------------------------------
// Screen-reader description (§49)
// ------------------------------------------------------------

function describe(message: Message, isMine: boolean, senderName?: string): string {
  const who = isMine ? 'You' : (senderName ?? 'They');
  const when = fmtTime(message.createdAt);
  const body: MessageBody = message.body;

  let what: string;
  if (message.deletedAt) what = 'message deleted';
  else if (message.viewOnce) what = 'view once moment';
  else {
    switch (body.type) {
      case 'text':
        what = body.text;
        break;
      case 'voice':
        what = `voice message, ${fmtDuration(body.durationMs)}`;
        break;
      case 'image':
        what = 'photo';
        break;
      case 'video':
      case 'video_message':
        what = 'video';
        break;
      case 'file':
        what = `file, ${body.fileName}`;
        break;
      case 'location':
        what = 'location';
        break;
      case 'contact':
        what = `contact, ${body.name}`;
        break;
      default:
        what = body.type;
    }
  }

  const state =
    message.local === 'failed'
      ? ', failed to send'
      : message.local === 'queued' || message.local === 'sending'
        ? ', sending'
        : '';

  return `${who}, ${when}: ${what}${state}`;
}

const styles = StyleSheet.create({
  row: { marginTop: 1, maxWidth: '100%' },
  rowMine: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'flex-end' },
  rowTheirs: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'flex-start' },
  rail: { borderRadius: RAIL_RADIUS, alignSelf: 'stretch', minHeight: 26 },
  bubble: {
    borderRadius: BUBBLE_RADIUS,
    paddingHorizontal: spacing.md - 2,
    paddingTop: spacing.sm + 1,
    paddingBottom: 6,
    minWidth: 76,
  },
  bubbleMine: { maxWidth: MAX_WIDTH_MINE },
  bubbleTheirs: { maxWidth: MAX_WIDTH_THEIRS },
  bubbleFailed: { borderWidth: 1, borderColor: colors.danger },
  sender: { fontSize: 12, fontWeight: '700', marginBottom: 2 },
  text: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 14, lineHeight: 19, marginTop: 6 },
  deleted: { fontSize: 14, fontStyle: 'italic', opacity: 0.7 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 3,
  },
  meta: { fontSize: 10.5, fontWeight: '600' },
  quote: {
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    opacity: 0.9,
  },
  quoteText: { fontSize: 12.5, flexShrink: 1 },
  media: {
    width: MEDIA_W,
    height: MEDIA_H,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaImage: { width: '100%', height: '100%' },
  mediaEmpty: { gap: 4 },
  mediaEmptyText: { fontSize: 11, color: colors.textFaint },
  playOverlay: {
    position: 'absolute',
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 168 },
  voiceTrack: { flex: 1, height: 3, borderRadius: 2, overflow: 'hidden' },
  voiceFill: { height: 3, borderRadius: 2 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 168 },
  fileMeta: { flexShrink: 1 },
  fileName: { fontSize: 14, fontWeight: '600' },
  moment: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 168 },
  reactions: { flexDirection: 'row', gap: 4, marginTop: -6, zIndex: 2 },
  reactionsMine: { alignSelf: 'flex-end', marginRight: spacing.sm },
  reactionsTheirs: { alignSelf: 'flex-start', marginLeft: spacing.lg },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { fontSize: 10, color: colors.textMuted, fontWeight: '700' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  retryText: { fontSize: 11, color: colors.danger, fontWeight: '700' },
});
