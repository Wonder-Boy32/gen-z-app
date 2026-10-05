import React, { useMemo } from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { colors } from '../../theme';

/**
 * CaptionText — renders a caption with its #hashtags as real, tappable links.
 *
 * WHY THIS EXISTS
 *
 * Captions used to render as one plain string, so a hashtag in a caption was
 * decoration: it looked meaningful and did nothing. The rest of the app already
 * treats a tag as an address (FeedScreen has an exact post_hashtags filter, and
 * a tag in search results already opens it), so the caption was the one place
 * where a hashtag was NOT a link. This closes that gap.
 *
 * The link is deliberately LOWER-CASED: sync_hashtags() stores tags as
 * lower(regexp_matches[1]), so tapping "#BigGod" has to open `biggod` or it would
 * find nothing. The visible text keeps the author's original casing — only the
 * value handed to the handler is normalised, because that value is a database key.
 */

// A token only counts when it starts at the beginning of the string or after a
// character that cannot be part of a word — so "email#tag" and "foo@bar.com" stay
// plain text, while "#tag" and " @someone" become links.
const TOKEN = /(^|[^A-Za-z0-9_#@])(#([A-Za-z0-9_]{1,40})|@([A-Za-z0-9._]{1,30}))/g;

type Part = { text: string; tag?: string; mention?: string };

/** Split into plain runs and link tokens. Exported so it can be unit-tested. */
export function splitCaption(input: string): Part[] {
  const out: Part[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    // The lead character belongs to the surrounding prose, not to the link.
    if (m[1]) out.push({ text: m[1] });
    if (m[3]) out.push({ text: m[2], tag: m[3].toLowerCase() });
    else if (m[4]) out.push({ text: m[2], mention: m[4] });
    last = m.index + m[0].length;

    // A zero-length match would spin forever; the pattern cannot produce one,
    // but an accidental future edit that could should fail loudly instead of
    // hanging the render.
    if (m[0].length === 0) re.lastIndex += 1;
  }

  if (last < input.length) out.push({ text: input.slice(last) });
  return out;
}

type Props = {
  text: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Given the normalised (lower-case) tag, without the '#'. */
  onPressTag?: (tag: string) => void;
  /** Given the username, without the '@'. */
  onPressMention?: (username: string) => void;
};

export default function CaptionText({ text, style, numberOfLines, onPressTag, onPressMention }: Props) {
  const parts = useMemo(() => splitCaption(text ?? ''), [text]);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((p, i) => {
        // A token is only styled as a link when there is something to do with it.
        // Styling a link that does nothing is worse than plain text — it invites
        // a tap and then ignores it.
        if (p.tag && onPressTag) {
          return (
            <Text
              key={i}
              style={styles.link}
              suppressHighlighting
              onPress={() => onPressTag(p.tag as string)}
            >
              {p.text}
            </Text>
          );
        }
        if (p.mention && onPressMention) {
          return (
            <Text
              key={i}
              style={styles.link}
              suppressHighlighting
              onPress={() => onPressMention(p.mention as string)}
            >
              {p.text}
            </Text>
          );
        }
        return <Text key={i}>{p.text}</Text>;
      })}
    </Text>
  );
}

const styles = {
  link: {
    color: colors.accent,
    fontWeight: '700' as const,
  },
};
