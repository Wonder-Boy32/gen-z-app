import React from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../../theme';
import Icon from '../ui/Icon';

type Props = {
  visible: boolean;
  assets: ImagePicker.ImagePickerAsset[];
  onClose: () => void;
  onPicked: (assets: ImagePicker.ImagePickerAsset[]) => void;
};

export default function MediaPickerSheet({ visible, assets, onClose, onPicked }: Props) {
  const pickCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (!res.canceled) onPicked([...assets, ...res.assets]);
  };

  const pickGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 6,
      quality: 0.8,
    });
    if (!res.canceled) onPicked([...assets, ...res.assets].slice(0, 6));
  };

  const remove = (index: number) => {
    onPicked(assets.filter((_, i) => i !== index));
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...assets];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onPicked(next);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Add media</Text>

          <View style={styles.actionRow}>
            <Pressable style={styles.actionBtn} onPress={pickCamera}>
              <Text style={styles.actionIcon}>📷</Text>
              <Text style={styles.actionText}>Camera</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={pickGallery}>
              <Text style={styles.actionIcon}>🖼</Text>
              <Text style={styles.actionText}>Gallery</Text>
            </Pressable>
          </View>

          {assets.length > 0 && (
            <>
              <Text style={styles.subTitle}>Selected ({assets.length}/6) — tap to remove, use the arrows to reorder</Text>
              <View style={styles.thumbRow}>
                {assets.map((a, i) => (
                  <View key={i} style={styles.thumbWrap}>
                    <Pressable onPress={() => remove(i)}>
                      <Image source={{ uri: a.uri }} style={styles.thumb} />
                      <View style={styles.removeBadge}>
                        <Text style={styles.removeText}>✕</Text>
                      </View>
                    </Pressable>
                    <View style={styles.moveRow}>
                      <Pressable onPress={() => move(i, -1)} hitSlop={6}>
                        <Icon name="chevron-back" size={16} color={colors.textMuted} />
                      </Pressable>
                      <Pressable onPress={() => move(i, 1)} hitSlop={6}>
                        <Icon name="chevron-forward" size={16} color={colors.textMuted} />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          <Pressable style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneText}>Done — continue to editor</Text>
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
    padding: 22,
    paddingBottom: 36,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 16,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 12,
  },
  actionBtn: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingVertical: 14,
    width: '46%',
  },
  actionIcon: {
    fontSize: 26,
  },
  actionText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  subTitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 8,
  },
  thumbRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  thumbWrap: {
    margin: 4,
  },
  thumb: {
    width: 72,
    height: 96,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  removeBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: colors.danger,
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: {
    color: colors.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  moveRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    marginTop: 2,
  },
  moveText: {
    color: colors.accent,
    fontSize: 13,
  },
  doneBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 14,
  },
  doneText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '700',
  },
});
