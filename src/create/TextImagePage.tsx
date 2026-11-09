// ============================================================
// src/create/TextImagePage.tsx
// ============================================================
// "Create a Drop" — write the thing, then make it an image.
//
// The reference for this page is a phone-sized writing sheet: a white card,
// a line of placeholder, one Next button. What it gets right is that there is
// exactly ONE thing to do on the page. No toolbar, no tabs, no mode switch.
//
// So this keeps that single-purpose shape and drops the rest. It is not a copy:
// the reference floats its card over a collage of sticky notes and uses a pink
// CTA; GEN Z is midnight navy with the orange accent, and the backdrop here is
// two faint rings rather than someone else's paper texture.
//
// It is a PAGE, not a modal, and that is the point of the rewrite — the create
// flow now has three real pages instead of one component pretending to be four.

import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Icon from '../components/ui/Icon';
import { colors, radius } from '../theme';
import { useInsets } from '../utils/useInsets';

const LIMIT = 600;

/**
 * Card backgrounds. These are the same six the composer's text card already
 * offers, so the colour chosen here is the colour that posts — not a preview of
 * a palette the composer does not have.
 */
const CARD_COLORS = ['#0C1030', '#FF9A2E', '#8B5CF6', '#FF5C7C', '#34D399', '#1E2466'] as const;
const isDarkCard = (c: string) => c === '#0C1030' || c === '#1E2466';

export default function TextImagePage({
  onBack,
  onNext,
}: {
  onBack: () => void;
  /** hands the text AND its card colour to the composer, which posts it */
  onNext: (text: string, bg: string) => void;
}) {
  const insets = useInsets();
  const [text, setText] = useState('');
  const [bg, setBg] = useState<string>(CARD_COLORS[0]);

  const trimmed = text.trim();
  const ready = trimmed.length > 0;
  const dark = isDarkCard(bg);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Backdrop. Two rings, deliberately almost invisible — they give the
          page depth without competing with the card, which is the only thing
          that should hold attention. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.ring, styles.ringA]} />
        <View style={[styles.ring, styles.ringB]} />
      </View>

      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityLabel="Back">
          <Icon name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Create an image of your text</Text>
        <View style={styles.back} />
      </View>

      <View style={styles.body}>
        {/* The card IS the preview: it is painted in the chosen background with
            the text in the same contrast colour the composer will post, so
            nothing about the final image is a surprise. */}
        <View style={[styles.card, { backgroundColor: bg, borderColor: bg }]}>
          <TextInput
            value={text}
            onChangeText={(v) => setText(v.slice(0, LIMIT))}
            placeholder="Share your thoughts or questions to spark discussions"
            placeholderTextColor={dark ? 'rgba(255,255,255,0.45)' : 'rgba(7,4,15,0.45)'}
            style={[styles.input, { color: dark ? '#FFFFFF' : '#0C1030' }]}
            multiline
            autoFocus
            textAlignVertical="top"
            maxLength={LIMIT}
            selectionColor={colors.accent}
          />
        </View>

        <View style={styles.swatchRow}>
          {CARD_COLORS.map((c) => {
            const on = bg === c;
            return (
              <Pressable
                key={c}
                onPress={() => setBg(c)}
                hitSlop={6}
                style={[styles.swatch, { backgroundColor: c }, on && styles.swatchOn]}
                accessibilityLabel={`Background ${c}`}
                accessibilityState={{ selected: on }}
              >
                {on && (
                  <Icon name="checkmark" size={14} color={isDarkCard(c) ? '#FFFFFF' : '#0C1030'} />
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.meta}>
          <Text style={styles.metaText}>
            {ready ? `${text.length}/${LIMIT}` : 'Drop expires 7 days after you post'}
          </Text>
        </View>
      </View>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) + 10 }]}>
        <Pressable
          onPress={() => ready && onNext(trimmed, bg)}
          disabled={!ready}
          style={[styles.next, !ready && styles.nextOff]}
          accessibilityRole="button"
          accessibilityLabel="Next"
        >
          <Text style={[styles.nextText, !ready && styles.nextTextOff]}>Next</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  ring: {
    position: 'absolute',
    borderRadius: 9999,
    borderWidth: 1,
  },
  ringA: {
    width: 420,
    height: 420,
    top: -120,
    left: -140,
    borderColor: colors.border,
  },
  ringB: {
    width: 320,
    height: 320,
    bottom: 40,
    right: -120,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 10,
  },
  back: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  body: {
    flex: 1,
    paddingHorizontal: 18,
  },
  card: {
    flex: 1,
    marginTop: 10,
    marginBottom: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  swatchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingBottom: 4,
  },
  swatch: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchOn: { borderColor: colors.accent },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 4,
  },
  metaText: {
    color: colors.textFaint,
    fontSize: 11,
    fontWeight: '600',
  },
  footer: {
    paddingHorizontal: 18,
    paddingTop: 12,
  },
  next: {
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextOff: {
    backgroundColor: colors.surfaceAlt,
  },
  nextText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '800',
  },
  nextTextOff: {
    color: colors.textFaint,
  },
});
