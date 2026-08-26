import React from 'react';
import { Ionicons } from '@expo/vector-icons';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  style?: any;
};

/**
 * Single icon source for the whole app — modern vector icons (Ionicons)
 * instead of emoji glyphs. Keep user content (reactions, stickers,
 * captions) as emoji; use this for all UI indicators.
 */
export default function Icon({ name, size = 22, color = '#fff', style }: Props) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
}
