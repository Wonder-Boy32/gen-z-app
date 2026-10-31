import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius } from '../../theme';
import { useSheetPad } from '../../utils/useSheetPad';

export type TextLayer = {
  id: string;
  text: string;
  color: string;
  size: number; // font size
  bold: boolean;
  x: number; // absolute position on canvas
  y: number;
};

const COLORS = ['#FFFFFF', '#C13BFF', '#8B5CF6', '#34D399', '#FF5C7C', '#FCE123', '#000000'];
const SIZES = [
  { id: 's', label: 'S', size: 16 },
  { id: 'm', label: 'M', size: 26 },
  { id: 'l', label: 'L', size: 40 },
];

type Props = {
  visible: boolean;
  onClose: () => void;
  onAdd: (layer: TextLayer) => void;
};

export default function TextLayerEditor({ visible, onClose, onAdd }: Props) {
  const [text, setText] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [sizeId, setSizeId] = useState('m');
  const [bold, setBold] = useState(true);

  const sheetPad = useSheetPad(36);

  useEffect(() => {
    if (visible) {
      setText('');
      setColor(COLORS[0]);
      setSizeId('m');
      setBold(true);
    }
  }, [visible]);

  const add = () => {
    const t = text.trim();
    if (!t) return;
    const size = SIZES.find((s) => s.id === sizeId)?.size ?? 26;
    onAdd({
      id: `t-${Date.now()}`,
      text: t,
      color,
      size,
      bold,
      x: 40 + Math.random() * 80,
      y: 120 + Math.random() * 140,
    });
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: sheetPad }]}>
          <View style={styles.header}>
            <Text style={styles.title}>Aa Text</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Type something..."
            placeholderTextColor={colors.textFaint}
            value={text}
            onChangeText={setText}
            autoFocus
            maxLength={80}
          />

          <Text style={styles.label}>Color</Text>
          <View style={styles.colorRow}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]}
                onPress={() => setColor(c)}
              />
            ))}
          </View>

          <Text style={styles.label}>Size</Text>
          <View style={styles.row}>
            {SIZES.map((s) => (
              <Pressable
                key={s.id}
                style={[styles.sizeBtn, sizeId === s.id && styles.sizeBtnActive]}
                onPress={() => setSizeId(s.id)}
              >
                <Text style={[styles.sizeText, sizeId === s.id && styles.sizeTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
            <Pressable style={[styles.sizeBtn, bold && styles.sizeBtnActive]} onPress={() => setBold((b) => !b)}>
              <Text style={[styles.sizeText, bold && styles.sizeTextActive]}>B</Text>
            </Pressable>
          </View>

          <Pressable style={styles.addBtn} onPress={add}>
            <Text style={styles.addText}>Add text</Text>
          </Pressable>
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
    marginBottom: 12,
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
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: colors.text,
    fontSize: 16,
    marginBottom: 14,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  colorRow: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  swatch: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginRight: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchActive: {
    borderColor: colors.accent,
  },
  row: {
    flexDirection: 'row',
    marginBottom: 18,
  },
  sizeBtn: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    paddingVertical: 9,
    marginRight: 8,
    minWidth: 46,
    alignItems: 'center',
  },
  sizeBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  sizeText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  sizeTextActive: {
    color: colors.bg,
  },
  addBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 14,
    alignItems: 'center',
  },
  addText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '800',
  },
});
