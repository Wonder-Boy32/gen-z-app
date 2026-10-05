import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors, radius } from '../theme';
import Avatar from './Avatar';
import Button from './Button';
import { PRESETS } from './presets';
import { uploadMedia } from '../utils/upload';
import { supabase } from '../supabase/client';
import { friendlyError } from '../utils/friendlyError';

type Props = {
  visible: boolean;
  current: string | null | undefined;
  name: string;
  onClose: () => void;
  onSaved: (avatarUrl: string | null) => void; // called AFTER the avatar is saved to the profile
};

export default function AvatarPickerModal({ visible, current, name, onClose, onSaved }: Props) {
  // selected: null = removed, 'preset:<id>', a public URL, or undefined = unchanged
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], cameraType: ImagePicker.CameraType.front, quality: 0.8 });
    if (res.canceled || !res.assets[0]) return;
    await uploadPicked(res.assets[0].uri);
  };

  const pickGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (res.canceled || !res.assets[0]) return;
    await uploadPicked(res.assets[0].uri);
  };

  const uploadPicked = async (uri: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const url = await uploadMedia(`avatars/${user.id}/avatar-${Date.now()}.jpg`, uri, 'image/jpeg');
      setSelected(url);
    } catch (e: any) {
      setError(friendlyError(e, 'Upload failed — try again'));
    } finally {
      setBusy(false);
    }
  };

  const changed = selected !== undefined;

  const save = async () => {
    if (selected === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in');
      const { error: upErr } = await supabase
        .from('profiles')
        .update({ avatar_url: selected })
        .eq('id', user.id);
      if (upErr) throw new Error(upErr.message);
      onSaved(selected);
      onClose();
    } catch (e: any) {
      setError(friendlyError(e, 'Could not save avatar'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Your avatar</Text>

          <View style={styles.previewRow}>
            <Avatar
              url={selected === undefined ? current : selected}
              name={name}
              size={112}
              ring
            />
          </View>

          <View style={styles.actionRow}>
            <Pressable style={styles.actionBtn} onPress={pickCamera} disabled={busy}>
              <Text style={styles.actionIcon}>📷</Text>
              <Text style={styles.actionText}>Camera</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={pickGallery} disabled={busy}>
              <Text style={styles.actionIcon}>🖼</Text>
              <Text style={styles.actionText}>Gallery</Text>
            </Pressable>
            {!!current && (
              <Pressable style={styles.actionBtn} onPress={() => setSelected(null)} disabled={busy}>
                <Text style={styles.actionIcon}>🗑</Text>
                <Text style={[styles.actionText, styles.removeText]}>Remove</Text>
              </Pressable>
            )}
          </View>

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <Text style={styles.presetTitle}>Pick a vibe</Text>
          <View style={styles.presetGrid}>
            {PRESETS.map((p) => {
              const active = selected === `preset:${p.id}`;
              return (
                <Pressable
                  key={p.id}
                  style={[styles.presetItem, active && styles.presetActive]}
                  onPress={() => setSelected(`preset:${p.id}`)}
                >
                  <View style={[styles.presetCircle, { backgroundColor: p.bg }]}>
                    <Text style={styles.presetEmoji}>{p.emoji}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <Button title="Save avatar" onPress={save} disabled={!changed || busy} loading={busy} />
          <Pressable style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
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
  },
  previewRow: {
    alignItems: 'center',
    marginVertical: 16,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
  },
  actionBtn: {
    alignItems: 'center',
    padding: 10,
  },
  actionIcon: {
    fontSize: 24,
  },
  actionText: {
    color: colors.text,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  removeText: {
    color: colors.danger,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  presetTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 18,
  },
  presetItem: {
    margin: 5,
    borderRadius: 26,
    padding: 2,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  presetActive: {
    borderColor: colors.accent,
  },
  presetCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetEmoji: {
    fontSize: 22,
  },
  cancel: {
    alignItems: 'center',
    marginTop: 12,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 14,
  },
});
