import React, { useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';

// Draggable wrapper — PanResponder based, works anywhere.
export default function Draggable({
  x,
  y,
  children,
  onMove,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  onMove?: (x: number, y: number) => void;
}) {
  const pos = useRef(new Animated.ValueXY({ x, y })).current;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => {
        pos.setValue({ x: g.dx + x, y: g.dy + y });
      },
      onPanResponderRelease: (_, g) => {
        const nx = g.dx + x;
        const ny = g.dy + y;
        pos.setValue({ x: nx, y: ny });
        onMove?.(nx, ny);
      },
    })
  ).current;

  return (
    <Animated.View style={[styles.wrap, { transform: pos.getTranslateTransform() }]} {...pan.panHandlers}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
  },
});
