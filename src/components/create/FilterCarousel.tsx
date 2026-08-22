import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, radius } from '../../theme';

// UI-level filter presets. These are tint overlays applied on top of the
// preview (Expo Go cannot run pixel shaders — real filter rendering would
// need a native module, e.g. ffmpeg in a dev build). The chosen filter id
// is stored on the post so a future native renderer can apply it properly.
export const FILTERS: { id: string; label: string; tint: string | null }[] = [
  { id: 'original', label: 'Original', tint: null },
  { id: 'vibe', label: 'Vibe', tint: 'rgba(255,157,31,0.20)' },
  { id: 'midnight', label: 'Midnight', tint: 'rgba(30,42,90,0.42)' },
  { id: 'sunset', label: 'Sunset', tint: 'rgba(255,92,124,0.24)' },
  { id: 'mono', label: 'Mono', tint: 'rgba(120,125,140,0.50)' },
  { id: 'glow', label: 'Glow', tint: 'rgba(139,123,255,0.26)' },
  { id: 'vhs', label: 'VHS', tint: 'rgba(90,220,160,0.16)' },
];

export function getFilterTint(id: string): string | null {
  return FILTERS.find((f) => f.id === id)?.tint ?? null;
}

export function getFilterLabel(id: string): string {
  return FILTERS.find((f) => f.id === id)?.label ?? id;
}

type Props = {
  value: string;
  onChange: (id: string) => void;
};

export default function FilterCarousel({ value, onChange }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {FILTERS.map((f) => (
        <Pressable
          key={f.id}
          style={[styles.chip, value === f.id && styles.chipActive]}
          onPress={() => onChange(f.id)}
        >
          <Text style={[styles.chipText, value === f.id && styles.chipTextActive]}>{f.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.bg,
  },
});
