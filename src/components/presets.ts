// Preset avatar styles — stored in avatar_url as "preset:<id>" (no upload needed).
export type Preset = { id: string; emoji: string; bg: string };

export const PRESETS: Preset[] = [
  { id: 'lion', emoji: '🦁', bg: '#F59E0B' },
  { id: 'star', emoji: '🌟', bg: '#8B5CF6' },
  { id: 'crown', emoji: '👑', bg: '#EC4899' },
  { id: 'bolt', emoji: '⚡', bg: '#F97316' },
  { id: 'fire', emoji: '🔥', bg: '#DC2626' },
  { id: 'moon', emoji: '🌙', bg: '#0EA5E9' },
  { id: 'rocket', emoji: '🚀', bg: '#10B981' },
  { id: 'heart', emoji: '💜', bg: '#A855F7' },
  { id: 'alien', emoji: '👾', bg: '#22D3EE' },
  { id: 'skull', emoji: '💀', bg: '#64748B' },
  { id: 'pizza', emoji: '🍕', bg: '#EF4444' },
  { id: 'hundred', emoji: '💯', bg: '#16A34A' },
];

export function isPreset(url: string | null | undefined): boolean {
  return !!url && url.startsWith('preset:');
}

export function presetById(url: string | null | undefined): Preset | null {
  if (!isPreset(url)) return null;
  return PRESETS.find((p) => p.id === url.slice(7)) ?? null;
}
