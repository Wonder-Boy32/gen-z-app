import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { colors, radius } from '../theme';
import Icon from './ui/Icon';
import AnonymousCard from './AnonymousCard';

export default function AnonymousCardModal({
  visible,
  username,
  message,
  kind,
  onClose,
  onPostToFeed,
}: {
  visible: boolean;
  username: string;
  message?: string | null;
  kind: 'link' | 'message';
  onClose: () => void;
  onPostToFeed: (uri: string) => void;
}) {
  const cardRef = useRef<View>(null);
  const [busy, setBusy] = useState(false);
  const link = `https://genz.app/anon/@${username}`;

  const capture = async (): Promise<string | null> => {
    if (!cardRef.current) return null;
    try {
      return await captureRef(cardRef.current, { format: 'png', quality: 0.92, result: 'tmpfile' });
    } catch (e) {
      console.warn('card capture failed', e);
      return null;
    }
  };

  const saveToDevice = async () => {
    setBusy(true);
    const uri = await capture();
    if (!uri) {
      setBusy(false);
      return;
    }
    try {
      // expo-media-library is a native module — available in builds that
      // include it. Guarded so older builds degrade gracefully.
      const MediaLibrary = require('expo-media-library');
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (perm.granted) {
        await MediaLibrary.createAssetAsync(uri);
        Alert.alert('Saved', 'Card saved to your gallery — post it anywhere 📸');
      } else {
        Alert.alert('Permission needed', 'Allow photo access to save the card to your device.');
      }
    } catch (e) {
      Alert.alert(
        'Not available yet',
        'Saving to the gallery needs the next app update — but you can post it to the feed right now.'
      );
    }
    setBusy(false);
  };

  const postToFeed = async () => {
    setBusy(true);
    const uri = await capture();
    setBusy(false);
    if (uri) {
      onPostToFeed(uri);
      onClose();
    }
  };

  const copyLink = () => {
    try {
      const C = require('expo-clipboard');
      C.setStringAsync?.(link).catch(() => {});
    } catch (e) {
      // clipboard module unavailable — the alert still shows the link
    }
    Alert.alert('Link copied', link);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.closeArea} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.cardWrap}>
            <AnonymousCard ref={cardRef} username={username} link={link} message={message} kind={kind} />
          </View>

          <Text style={styles.title}>
            {kind === 'link' ? 'Share your anonymous link' : 'Post this anonymous message'}
          </Text>
          <Text style={styles.sub}>
            Save the card as an image — post it on the feed, your status, or anywhere outside Gen Z.
          </Text>

          <View style={styles.actions}>
            <Pressable style={styles.actionBtn} onPress={saveToDevice} disabled={busy}>
              {busy ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <>
                  <Icon name="download-outline" size={16} color={colors.bg} />
                  <Text style={styles.actionText}>Save image</Text>
                </>
              )}
            </Pressable>
            <Pressable style={styles.actionBtnGhost} onPress={postToFeed} disabled={busy}>
              <Icon name="flame" size={16} color={colors.accent} />
              <Text style={styles.actionTextGhost}>Post to feed</Text>
            </Pressable>
            <Pressable style={styles.actionBtnGhost} onPress={copyLink} disabled={busy}>
              <Icon name="link-outline" size={16} color={colors.accent} />
              <Text style={styles.actionTextGhost}>Copy link</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  closeArea: { flex: 1 },
  sheet: {
    backgroundColor: '#0d1426',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 20,
    paddingBottom: 38,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  cardWrap: {
    width: 340,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,122,0,0.35)',
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '900', marginTop: 16 },
  sub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  actionBtnGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,122,0,0.45)',
    backgroundColor: 'rgba(255,122,0,0.08)',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  actionText: { color: colors.bg, fontSize: 13, fontWeight: '800' },
  actionTextGhost: { color: colors.accent, fontSize: 13, fontWeight: '800' },
});
