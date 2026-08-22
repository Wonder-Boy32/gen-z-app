import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';

export const STICKERS = ['🔥', '💀', '😭', '✨', '👀', '🚀', '💯', '🎯', '👑', '🧠', '🫶', '🤪', '🥶', '😤', '🙏', '🕶'];

type Props = {
  visible: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
};

export default function StickerPicker({ visible, onClose, onPick }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>🏷 Stickers</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Tap a sticker — it lands on your drop. Drag to move, tap ✕ to remove.</Text>
          <View style={styles.grid}>
            {STICKERS.map((s) => (
              <Pressable
                key={s}
                style={styles.cell}
                onPress={() => {
                  onPick(s);
                  onClose();
                }}
              >
                <Text style={styles.emoji}>{s}</Text>
              </Pressable>
            ))}
          </View>
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  cell: {
    width: '23%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    marginBottom: 10,
  },
  emoji: {
    fontSize: 30,
  },
});
