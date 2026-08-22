import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius } from '../theme';

const KEY = process.env.EXPO_PUBLIC_GIPHY_API_KEY ?? '';

type Gif = { id: string; images: { fixed_height: { url: string } } };

export default function GifPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchGifs = async (query: string) => {
    if (!KEY) return;
    setLoading(true);
    try {
      const url = query
        ? `https://api.giphy.com/v1/gifs/search?api_key=${KEY}&q=${encodeURIComponent(query)}&limit=24`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${KEY}&limit=24`;
      const res = await fetch(url);
      const json = await res.json();
      setGifs(json.data ?? []);
    } catch {
      setGifs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      setQ('');
      fetchGifs('');
    }
  }, [visible]);

  useEffect(() => {
    const t = setTimeout(() => fetchGifs(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>GIFs</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.search}
            placeholder="Search GIFs..."
            placeholderTextColor={colors.textFaint}
            value={q}
            onChangeText={setQ}
          />
          {!KEY ? (
            <Text style={styles.noKey}>
              Add a free Giphy API key to .env (EXPO_PUBLIC_GIPHY_API_KEY) to enable GIFs. Grab one at
              developers.giphy.com.
            </Text>
          ) : loading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <FlatList
              data={gifs}
              keyExtractor={(g) => g.id}
              numColumns={2}
              renderItem={({ item }) => (
                <Pressable style={styles.tile} onPress={() => onPick(item.images.fixed_height.url)}>
                  <Image source={{ uri: item.images.fixed_height.url }} style={styles.tileImage} />
                </Pressable>
              )}
              ListEmptyComponent={<Text style={styles.noKey}>No GIFs found.</Text>}
            />
          )}
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
    height: '75%',
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 16,
    paddingBottom: 30,
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
  search: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    marginBottom: 12,
  },
  loader: {
    marginTop: 30,
  },
  noKey: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 30,
    paddingHorizontal: 20,
    lineHeight: 19,
  },
  tile: {
    flex: 1 / 2,
    aspectRatio: 1,
    margin: 3,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
});
