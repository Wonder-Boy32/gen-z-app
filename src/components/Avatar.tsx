import React, { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { presetById } from './presets';
import VerifiedBadge from './ui/VerifiedBadge';

// One avatar renderer for the whole app: photo URL, preset style, or initial
// letter. Pass verified=true to draw the small corner badge on the avatar.
export default function Avatar({
  url,
  name,
  size,
  ring,
  verified,
}: {
  url: string | null | undefined;
  name: string;
  size: number;
  ring?: boolean;
  verified?: boolean;
}) {
  const preset = presetById(url);
  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  let body: ReactNode;
  if (preset) {
    body = (
      <View style={[circle, styles.preset, { backgroundColor: preset.bg }, ring && styles.ring]}>
        <Text style={{ fontSize: size * 0.5 }}>{preset.emoji}</Text>
      </View>
    );
  } else if (url) {
    body = <Image source={{ uri: url }} style={[circle, ring && styles.ring]} />;
  } else {
    body = (
      <View style={[circle, styles.initial, ring && styles.ring]}>
        <Text style={[styles.initialText, { fontSize: size * 0.42 }]}>
          {(name || 'G').charAt(0).toUpperCase()}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      {body}
      {verified && (
        <View
          style={[
            styles.vBadge,
            {
              width: Math.max(12, Math.round(size * 0.46)),
              height: Math.max(12, Math.round(size * 0.46)),
            },
          ]}
          pointerEvents="none"
        >
          <VerifiedBadge size={Math.min(15, Math.max(10, Math.round(size * 0.38)))} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
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
  vBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
