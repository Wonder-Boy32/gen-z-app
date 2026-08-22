import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export type Tab = 'feed' | 'discover' | 'post' | 'chat' | 'profile';

const ITEMS: { key: Tab; label: string; glyph: string }[] = [
  { key: 'feed', label: 'Feed', glyph: '▶' },
  { key: 'discover', label: 'Discover', glyph: '✦' },
  { key: 'post', label: '', glyph: '✚' },
  { key: 'chat', label: 'Chat', glyph: '✉' },
  { key: 'profile', label: 'Me', glyph: '◉' },
];

export default function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const activeIndex = Math.max(0, ITEMS.findIndex((i) => i.key === tab));
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(glow, {
      toValue: activeIndex,
      friction: 6,
      tension: 120,
      useNativeDriver: false,
    }).start();
  }, [activeIndex]);

  return (
    <View style={styles.bar}>
      {ITEMS.map((item, index) => {
        const active = item.key === tab;
        return (
          <Pressable
            key={item.key}
            style={styles.item}
            onPress={() => onChange(item.key)}
          >
            <Text style={[styles.glyph, active && styles.glyphActive]}>{item.glyph}</Text>
            {item.label !== '' && (
              <Text style={[styles.label, active && styles.labelActive]}>{item.label}</Text>
            )}
            {item.key === 'post' && active && <View style={styles.postDot} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    paddingBottom: 22,
    paddingTop: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  glyph: {
    color: colors.textFaint,
    fontSize: 20,
  },
  glyphActive: {
    color: colors.accent,
  },
  label: {
    color: colors.textFaint,
    fontSize: 11,
    marginTop: 3,
  },
  labelActive: {
    color: colors.accent,
    fontWeight: '600',
  },
  postDot: {
    position: 'absolute',
    top: 0,
    width: 22,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
});
