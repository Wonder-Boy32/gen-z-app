import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';

// UI-level filter presets. These are tint overlays applied on top of the
// preview (Expo Go cannot run pixel shaders — real filter rendering would
// need a native module, e.g. ffmpeg in a dev build). The chosen filter id
// is stored on the post so a future native renderer can apply it properly.
export type FilterDef = {
  id: string;
  label: string;
  tint: string | null;
  /** extra soft-light layer (Snapchat-style beauty: brighten / soften) */
  glow?: string | null;
  group?: 'looks' | 'beauty';
};

export const FILTERS: FilterDef[] = [
  { id: 'original', label: 'Original', tint: null, group: 'looks' },
  { id: 'vibe', label: 'Vibe', tint: 'rgba(255,157,31,0.20)', group: 'looks' },
  { id: 'midnight', label: 'Midnight', tint: 'rgba(30,42,90,0.42)', group: 'looks' },
  { id: 'sunset', label: 'Sunset', tint: 'rgba(255,92,124,0.24)', group: 'looks' },
  { id: 'mono', label: 'Mono', tint: 'rgba(120,125,140,0.50)', group: 'looks' },
  { id: 'glow', label: 'Glow', tint: 'rgba(139,123,255,0.26)', group: 'looks' },
  { id: 'vhs', label: 'VHS', tint: 'rgba(90,220,160,0.16)', group: 'looks' },
  // Snapchat-style beauty presets — soft-light layers that brighten,
  // smooth and warm the skin without needing a pixel shader
  { id: 'b-clear', label: 'Clear', tint: null, glow: 'rgba(255,255,255,0.10)', group: 'beauty' },
  { id: 'b-soft', label: 'Soft', tint: 'rgba(255,190,200,0.07)', glow: 'rgba(255,255,255,0.14)', group: 'beauty' },
  { id: 'b-glow', label: 'Glow', tint: 'rgba(255,220,180,0.10)', glow: 'rgba(255,255,255,0.10)', group: 'beauty' },
  { id: 'b-fresh', label: 'Fresh', tint: 'rgba(210,240,255,0.10)', glow: 'rgba(255,255,255,0.08)', group: 'beauty' },
  { id: 'b-radiant', label: 'Radiant', tint: 'rgba(255,214,170,0.14)', glow: null, group: 'beauty' },
  { id: 'b-smooth', label: 'Smooth', tint: null, glow: 'rgba(255,255,255,0.18)', group: 'beauty' },
  { id: 'b-porcelain', label: 'Porcelain', tint: 'rgba(255,225,235,0.12)', glow: 'rgba(255,255,255,0.08)', group: 'beauty' },
];

export function getFilterDef(id: string): FilterDef | undefined {
  return FILTERS.find((f) => f.id === id);
}

export function getFilterTint(id: string): string | null {
  return getFilterDef(id)?.tint ?? null;
}

export function getFilterGlow(id: string): string | null {
  return getFilterDef(id)?.glow ?? null;
}

export function getFilterLabel(id: string): string {
  return getFilterDef(id)?.label ?? id;
}

type Props = {
  value: string;
  onChange: (id: string) => void;
};

function Row({
  group,
  label,
  value,
  onChange,
}: {
  group: FilterDef['group'];
  label: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const items = FILTERS.filter((f) => f.group === group);
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {items.map((f) => (
          <Pressable
            key={f.id}
            style={[styles.chip, value === f.id && styles.chipActive]}
            onPress={() => onChange(f.id)}
          >
            <Text style={[styles.chipText, value === f.id && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export default function FilterCarousel({ value, onChange }: Props) {
  return (
    <View>
      <Row group="looks" label="LOOKS" value={value} onChange={onChange} />
      <Row group="beauty" label="BEAUTY" value={value} onChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginTop: 10,
  },
  groupLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  row: {
    paddingHorizontal: 16,
    paddingBottom: 6,
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
