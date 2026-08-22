import React, { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../../supabase/client';
import { colors, radius } from '../../theme';

type Sound = { id: string; name: string; artist: string | null; category: string; usage_count: number };

const CATEGORIES = ['Viral', 'Afrobeats', 'Amapiano', 'Hip-Hop', 'R&B', 'Pop', 'Chill', 'Original Sounds'];

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (sound: Sound) => void;
};

export default function SoundPickerModal({ visible, onClose, onSelect }: Props) {
  const [category, setCategory] = useState('Viral');
  const [query, setQuery] = useState('');
  const [sounds, setSounds] = useState<Sound[]>([]);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    load('Viral');
  }, [visible]);

  const load = async (cat: string, q = '') => {
    let query2 = supabase
      .from('sounds')
      .select('id, name, artist, category, usage_count')
      .eq('category', cat)
      .order('usage_count', { ascending: false });
    if (q.trim()) query2 = query2.or(`name.ilike.%${q.trim()}%,artist.ilike.%${q.trim()}%`);
    const { data } = await query2.limit(50);
    setSounds((data ?? []) as Sound[]);
  };

  const pickCategory = (cat: string) => {
    setCategory(cat);
    load(cat, query);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>🎵 Add Sound</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            placeholder="Search sounds..."
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={(q) => {
              setQuery(q);
              load(category, q);
            }}
          />

          <FlatList
            data={CATEGORIES}
            horizontal
            keyExtractor={(c) => c}
            showsHorizontalScrollIndicator={false}
            style={styles.catList}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.catChip, category === item && styles.catChipActive]}
                onPress={() => pickCategory(item)}
              >
                <Text style={[styles.catText, category === item && styles.catTextActive]}>{item}</Text>
              </Pressable>
            )}
          />

          <FlatList
            data={sounds}
            keyExtractor={(s) => s.id}
            style={styles.list}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={styles.info}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.artist}>
                    {item.artist ?? 'GEN Z'} · {item.usage_count} uses
                  </Text>
                </View>
                <Pressable style={styles.useBtn} onPress={() => onSelect(item)}>
                  <Text style={styles.useText}>Use this sound</Text>
                </Pressable>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>No sounds in this category yet.</Text>}
          />
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
    height: '80%',
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
    marginBottom: 10,
  },
  catList: {
    flexGrow: 0,
    marginBottom: 8,
  },
  catChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginRight: 8,
  },
  catChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  catText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  catTextActive: {
    color: colors.bg,
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  info: {
    flex: 1,
    marginRight: 10,
  },
  name: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  artist: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  useBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  useText: {
    color: colors.bg,
    fontSize: 12,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 30,
  },
});
