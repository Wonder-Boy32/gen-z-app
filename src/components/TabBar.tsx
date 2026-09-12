import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useInsets } from '../utils/useInsets';
import { colors } from '../theme';
import Icon, { IconName } from './ui/Icon';

export type Tab = 'feed' | 'discover' | 'post' | 'chat' | 'profile';

const ITEMS: { key: Tab; label: string; icon: IconName; iconActive: IconName }[] = [
  { key: 'feed', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { key: 'discover', label: 'Discover', icon: 'compass-outline', iconActive: 'compass' },
  { key: 'post', label: '', icon: 'add-circle-outline', iconActive: 'add-circle' },
  { key: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline', iconActive: 'chatbubble-ellipses' },
  { key: 'profile', label: 'Me', icon: 'person-outline', iconActive: 'person' },
];

export default function TabBar({
  tab,
  onChange,
  badges,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  badges?: Partial<Record<Tab, number>>;
}) {
  const insets = useInsets();
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
    <View style={[styles.bar, { paddingBottom: insets.bottom > 0 ? insets.bottom + 6 : 22 }]}>
      {ITEMS.map((item, index) => {
        const active = item.key === tab;
        return (
          <Pressable
            key={item.key}
            style={styles.item}
            onPress={() => onChange(item.key)}
          >
            <View style={styles.iconWrap}>
              <Icon
                name={active ? item.iconActive : item.icon}
                size={22}
                color={active ? colors.accent : colors.textFaint}
              />
              {!active && (badges?.[item.key] ?? 0) > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {(badges?.[item.key] ?? 0) > 99 ? '99+' : badges?.[item.key]}
                  </Text>
                </View>
              )}
            </View>
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
    paddingTop: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  iconWrap: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -12,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  badgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '800',
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
