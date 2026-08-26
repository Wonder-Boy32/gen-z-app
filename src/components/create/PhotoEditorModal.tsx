import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../../theme';

export const COLLAGES = [
  { id: 'single', label: 'Single' },
  { id: 'duo', label: 'Duo' },
  { id: 'trio', label: 'Trio' },
  { id: 'grid', label: 'Grid' },
];

// Minimal layout previews drawn with Views — shows the shape of each collage.
function Mini({ id }: { id: string }) {
  const cell = { flex: 1, backgroundColor: colors.borderStrong, margin: 1.5, borderRadius: 2 };
  if (id === 'duo') {
    return (
      <View style={styles.mini}>
        <View style={cell} />
        <View style={cell} />
      </View>
    );
  }
  if (id === 'trio') {
    return (
      <View style={styles.mini}>
        <View style={[cell, { flex: 1.4 }]} />
        <View style={{ flex: 1 }}>
          <View style={[cell, { flex: 1 }]} />
          <View style={[cell, { flex: 1 }]} />
        </View>
      </View>
    );
  }
  if (id === 'grid') {
    return (
      <View style={styles.miniWrap}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[cell, { width: '31%', aspectRatio: 1 }]} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.mini}>
      <View style={[cell, { flex: 1 }]} />
    </View>
  );
}

type Props = {
  visible: boolean;
  images: ImagePicker.ImagePickerAsset[];
  value: string;
  onChange: (id: string) => void;
  onClose: () => void;
};

export default function PhotoEditorModal({ visible, images, value, onChange, onClose }: Props) {
  const count = images.length;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>🖼 Photo layout</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            {count} photo{count === 1 ? '' : 's'} selected — choose how they sit together.
          </Text>
          <View style={styles.row}>
            {COLLAGES.filter((c) => c.id !== 'trio' || count >= 3).map((c) => (
              <Pressable
                key={c.id}
                style={[styles.card, value === c.id && styles.cardActive]}
                onPress={() => onChange(c.id)}
              >
                <Mini id={c.id} />
                <Text style={[styles.cardLabel, value === c.id && styles.cardLabelActive]}>{c.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.reorderHint}>Tip: reorder photos from the media sheet.</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 20,
    paddingBottom: 36,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  close: {
    color: colors.textMuted,
    fontSize: 18,
    padding: 4,
  },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  card: {
    width: '23%',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    padding: 8,
    alignItems: 'center',
  },
  cardActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  mini: {
    flexDirection: 'row',
    width: '100%',
    height: 64,
  },
  miniWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: '100%',
    height: 64,
    justifyContent: 'space-between',
  },
  cardLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
  },
  cardLabelActive: {
    color: colors.accent,
  },
  reorderHint: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 14,
    textAlign: 'center',
  },
});
