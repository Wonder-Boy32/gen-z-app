// ============================================================
// MediaEditorScreen — editing after capture (spec §9).
//
// expo-image-manipulator ~57.0.20 verified against node_modules:
//   · useImageManipulator(uri) -> context
//   · context.resize({width?,height?}) / rotate(deg) / flip(dir)
//     / crop({originX,originY,width,height}) / reset()
//   · await context.renderAsync() -> ImageRef
//   · await ImageRef.saveAsync({format, compress}) -> ImageResult
//   · SaveFormat.JPEG|PNG|WEBP, FlipType.Vertical|Horizontal
//
// HONEST SCOPE, stated in the UI as well as here:
// freehand draw, blur/redaction and stickers need `react-native-svg`
// and `expo-blur`, which are NOT installed. Rather than hide three
// requested features, they are rendered as visibly disabled controls
// so their absence is legible instead of looking like a bug.
//
// Text/emoji overlays are drawn over the preview but NOT flattened
// into the exported pixels — impossible without react-native-svg.
// The caption is therefore returned separately so the parent can
// attach it to the message.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlipType, SaveFormat, useImageManipulator } from 'expo-image-manipulator';
import Icon from '../components/ui/Icon';
import { colors, radius, spacing } from '../theme';
import { TOP_INSET } from '../utils/useInsets';

const MAX_LONG_EDGE = 1600;

const ASPECTS = [
  { key: 'original', label: 'Original', ratio: null },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:5', label: '4:5', ratio: 4 / 5 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
] as const;

type AspectKey = (typeof ASPECTS)[number]['key'];

type Edit =
  | { kind: 'rotate'; degrees: number }
  | { kind: 'flip'; dir: 'horizontal' | 'vertical' }
  | { kind: 'aspect'; key: AspectKey };

export interface MediaEditorScreenProps {
  uri: string;
  mediaType: 'photo' | 'video';
  onCancel: () => void;
  onDone: (editedUri: string, caption: string | null) => void;
}

export default function MediaEditorScreen({
  uri,
  mediaType,
  onCancel,
  onDone,
}: MediaEditorScreenProps) {
  const context = useImageManipulator(uri);

  const [edits, setEdits] = useState<Edit[]>([]);
  const [preview, setPreview] = useState<string>(uri);
  const [originalSize, setOriginalSize] = useState<{ w: number; h: number } | null>(null);
  const [caption, setCaption] = useState('');
  const [overlay, setOverlay] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Original dimensions drive aspect cropping. Read once.
  useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (alive) setOriginalSize({ w, h });
      },
      () => {
        if (alive) setOriginalSize(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  const cropRectFor = useCallback(
    (ratio: number, w: number, h: number) => {
      const current = w / h;
      let cw = w;
      let ch = h;
      if (current > ratio) cw = Math.round(h * ratio);
      else ch = Math.round(w / ratio);
      return {
        originX: Math.max(0, Math.round((w - cw) / 2)),
        originY: Math.max(0, Math.round((h - ch) / 2)),
        width: Math.max(1, cw),
        height: Math.max(1, ch),
      };
    },
    []
  );

  /**
   * Rebuild from the ORIGINAL every time rather than stacking edits on the
   * previous render. Stacking loses quality on every pass and makes "undo"
   * impossible; rebuilding keeps one lossy step no matter how many edits.
   */
  const apply = useCallback(
    async (next: Edit[]) => {
      setWorking(true);
      setError(null);
      try {
        context.reset();

        for (const edit of next) {
          if (edit.kind === 'rotate') context.rotate(edit.degrees);
          else if (edit.kind === 'flip') {
            context.flip(edit.dir === 'horizontal' ? FlipType.Horizontal : FlipType.Vertical);
          } else if (edit.kind === 'aspect' && originalSize) {
            const def = ASPECTS.find((a) => a.key === edit.key);
            if (def?.ratio) {
              context.crop(cropRectFor(def.ratio, originalSize.w, originalSize.h));
            }
          }
        }

        // Cap the long edge so a 12MP photo does not become a 12MP upload.
        if (originalSize) {
          const longest = Math.max(originalSize.w, originalSize.h);
          if (longest > MAX_LONG_EDGE) {
            if (originalSize.w >= originalSize.h) context.resize({ width: MAX_LONG_EDGE });
            else context.resize({ height: MAX_LONG_EDGE });
          }
        }

        const ref = await context.renderAsync();
        const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.88 });

        setEdits(next);
        setPreview(saved.uri);
      } catch (err) {
        setError('That edit could not be applied');
        if (__DEV__) console.warn('[mediaEditor] render failed:', err);
      } finally {
        setWorking(false);
      }
    },
    [context, cropRectFor, originalSize]
  );

  const push = useCallback(
    (edit: Edit) => {
      // Aspect is a single-select: replace any existing aspect edit.
      const base = edit.kind === 'aspect' ? edits.filter((e) => e.kind !== 'aspect') : edits;
      void apply([...base, edit]);
    },
    [apply, edits]
  );

  const undo = useCallback(() => {
    if (edits.length === 0) return;
    void apply(edits.slice(0, -1));
  }, [apply, edits]);

  const resetAll = useCallback(() => {
    void apply([]);
  }, [apply]);

  const activeAspect = useMemo(() => {
    const found = edits.find((e) => e.kind === 'aspect');
    return found && found.kind === 'aspect' ? found.key : 'original';
  }, [edits]);

  const isVideo = mediaType === 'video';

  return (
    <View style={styles.root}>
      {/* header */}
      <View style={[styles.header, { paddingTop: TOP_INSET + 8 }]}>
        <Pressable style={styles.headerBtn} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel editing">
          <Icon name="close" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Edit</Text>
        <Pressable
          style={styles.headerBtn}
          onPress={undo}
          disabled={edits.length === 0 || working}
          accessibilityRole="button"
          accessibilityLabel="Undo last edit"
        >
          <Icon name="arrow-undo-outline" size={20} color={edits.length === 0 ? colors.textFaint : colors.text} />
        </Pressable>
      </View>

      {/* preview */}
      <View style={styles.previewWrap}>
        <Image source={{ uri: preview }} style={styles.preview} resizeMode="contain" />

        {/* overlays are preview-only; see the file header for why */}
        {!!overlay && (
          <View style={styles.overlayHost} pointerEvents="none">
            <Text style={styles.overlayText}>{overlay}</Text>
          </View>
        )}

        {working && (
          <View style={styles.working}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )}

        {isVideo && (
          <View style={styles.videoBadge}>
            <Icon name="videocam" size={12} color="#fff" />
            <Text style={styles.videoBadgeText}>Video — frame edits only</Text>
          </View>
        )}
      </View>

      {!!error && (
        <Pressable style={styles.errorBar} onPress={() => setError(null)}>
          <Icon name="alert-circle" size={13} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </Pressable>
      )}

      {/* tools */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolRow}>
        <Tool icon="refresh" label="Rotate L" onPress={() => push({ kind: 'rotate', degrees: -90 })} disabled={working} />
        <Tool icon="refresh" label="Rotate R" flip onPress={() => push({ kind: 'rotate', degrees: 90 })} disabled={working} />
        <Tool icon="swap-horizontal" label="Flip H" onPress={() => push({ kind: 'flip', dir: 'horizontal' })} disabled={working} />
        <Tool icon="swap-vertical" label="Flip V" onPress={() => push({ kind: 'flip', dir: 'vertical' })} disabled={working} />
        <Tool
          icon="happy-outline"
          label={overlay ? 'Remove text' : 'Add text'}
          onPress={() => setOverlay((o) => (o ? null : '✨'))}
          disabled={working}
        />
        <Tool icon="cut-outline" label="Draw" onPress={() => undefined} disabled unavailable />
        <Tool icon="eye-off-outline" label="Blur" onPress={() => undefined} disabled unavailable />
        <Tool icon="pricetags-outline" label="Stickers" onPress={() => undefined} disabled unavailable />
      </ScrollView>

      {/* aspect presets */}
      <View style={styles.aspectRow}>
        {ASPECTS.map((a) => {
          const on = activeAspect === a.key;
          return (
            <Pressable
              key={a.key}
              onPress={() => push({ kind: 'aspect', key: a.key })}
              disabled={working || !originalSize}
              style={[styles.aspectChip, on && styles.aspectChipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Crop ${a.label}`}
            >
              <Text style={[styles.aspectText, on && styles.aspectTextOn]}>{a.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* caption */}
      <View style={styles.captionWrap}>
        <TextInput
          value={caption}
          onChangeText={setCaption}
          placeholder={isVideo ? 'Add a caption…' : 'Add a caption…'}
          placeholderTextColor={colors.textFaint}
          style={styles.captionInput}
          maxLength={1000}
          multiline
          accessibilityLabel="Caption for this media"
        />
      </View>

      <Text style={styles.scopeNote}>
        Draw, blur and stickers need `react-native-svg` and `expo-blur`, which are not installed.
      </Text>

      {/* actions */}
      <View style={styles.actionRow}>
        <Pressable style={styles.ghostBtn} onPress={resetAll} disabled={edits.length === 0 || working} accessibilityRole="button">
          <Text style={[styles.ghostText, edits.length === 0 && { color: colors.textFaint }]}>Reset</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, working && { opacity: 0.6 }]}
          onPress={() => onDone(preview, caption.trim() ? caption.trim() : null)}
          disabled={working}
          accessibilityRole="button"
        >
          <Icon name="arrow-up" size={17} color={colors.bg} />
          <Text style={styles.primaryText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Tool({
  icon,
  label,
  onPress,
  disabled,
  unavailable,
  flip,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  unavailable?: boolean;
  flip?: boolean;
}) {
  return (
    <Pressable
      style={[styles.tool, unavailable && styles.toolUnavailable]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={unavailable ? `${label} — unavailable` : label}
      accessibilityState={{ disabled: !!disabled }}
    >
      <View style={[styles.toolIcon, flip && { transform: [{ scaleX: -1 }] }]}>
        <Icon name={icon} size={20} color={unavailable ? colors.textFaint : colors.text} />
      </View>
      <Text style={[styles.toolLabel, unavailable && { color: colors.textFaint }]}>{label}</Text>
      {unavailable && <Text style={styles.toolSoon}>n/a</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  previewWrap: {
    flex: 1,
    margin: spacing.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  preview: { width: '100%', height: '100%' },
  overlayHost: {
    position: 'absolute',
    bottom: '12%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  overlayText: { fontSize: 44 },
  working: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  videoBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  videoBadgeText: { color: '#fff', fontSize: 10.5, fontWeight: '600' },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,92,124,0.12)',
  },
  errorText: { color: colors.danger, fontSize: 12, flex: 1 },
  toolRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.md },
  tool: { alignItems: 'center', gap: 4, width: 62 },
  toolUnavailable: { opacity: 0.55 },
  toolIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolLabel: { fontSize: 10.5, color: colors.textMuted, textAlign: 'center' },
  toolSoon: { fontSize: 9, color: colors.textFaint, fontWeight: '700' },
  aspectRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  aspectChip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  aspectChipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  aspectText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  aspectTextOn: { color: colors.bg },
  captionWrap: { paddingHorizontal: spacing.md },
  captionInput: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14,
    maxHeight: 90,
    minHeight: 44,
  },
  scopeNote: {
    fontSize: 10.5,
    color: colors.textFaint,
    paddingHorizontal: spacing.md,
    paddingTop: 6,
    lineHeight: 14,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  ghostBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  ghostText: { color: colors.textMuted, fontWeight: '700', fontSize: 14 },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  primaryText: { color: colors.bg, fontWeight: '800', fontSize: 15 },
});
