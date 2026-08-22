import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { presetById } from './presets';

// One avatar renderer for the whole app: photo URL, preset style, or initial letter.
export default function Avatar({
  url,
  name,
  size,
  ring,
}: {
  url: string | null | undefined;
  name: string;
  size: number;
  ring?: boolean;
}) {
  const preset = presetById(url);
  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  if (preset) {
    return (
      <View style={[circle, styles.preset, { backgroundColor: preset.bg }, ring && styles.ring]}>
        <Text style={{ fontSize: size * 0.5 }}>{preset.emoji}</Text>
      </View>
    );
  }

  if (url) {
    return <Image source={{ uri: url }} style={[circle, ring && styles.ring]} />;
  }

  return (
    <View style={[circle, styles.initial, ring && styles.ring]}>
      <Text style={[styles.initialText, { fontSize: size * 0.42 }]}>
        {(name || 'G').charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  preset: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialText: {
    color: colors.accent,
    fontWeight: '800',
  },
  ring: {
    borderWidth: 2,
    borderColor: colors.accent,
  },
});
