// ============================================================
// Chat theme presets — bubble colors + wallpapers the user can
// pick per chat ("Chat color & wallpaper" in the ⋮ menu).
// ============================================================

export type ChatPalette = {
  key: string;
  label: string;
  myBg: string;      // outgoing bubble background
  myText: string;    // outgoing bubble text
  myTime: string;    // outgoing timestamp (on colored bg)
  theirBg: string;   // incoming bubble background
  tailMine: string;  // outgoing tail color
  tailTheirs: string;
};

export const CHAT_COLORS: ChatPalette[] = [
  { key: 'orange', label: 'Orange', myBg: '#FF9A2E', myText: '#0A0F1E', myTime: 'rgba(10,15,30,0.72)', theirBg: '#1D2740', tailMine: '#FF9A2E', tailTheirs: '#1D2740' },
  { key: 'teal', label: 'Teal', myBg: '#2BC5B4', myText: '#04140F', myTime: 'rgba(4,20,15,0.70)', theirBg: '#12302C', tailMine: '#2BC5B4', tailTheirs: '#12302C' },
  { key: 'purple', label: 'Violet', myBg: '#8B5CF6', myText: '#0B081F', myTime: 'rgba(11,8,31,0.70)', theirBg: '#231C45', tailMine: '#8B5CF6', tailTheirs: '#231C45' },
  { key: 'pink', label: 'Pink', myBg: '#FF6B9D', myText: '#1F0510', myTime: 'rgba(31,5,16,0.70)', theirBg: '#3A1B2E', tailMine: '#FF6B9D', tailTheirs: '#3A1B2E' },
  { key: 'blue', label: 'Blue', myBg: '#5B8CFF', myText: '#06102A', myTime: 'rgba(6,16,42,0.70)', theirBg: '#15264A', tailMine: '#5B8CFF', tailTheirs: '#15264A' },
  { key: 'green', label: 'Green', myBg: '#34D399', myText: '#04150D', myTime: 'rgba(4,21,13,0.70)', theirBg: '#123A2C', tailMine: '#34D399', tailTheirs: '#123A2C' },
  { key: 'red', label: 'Crimson', myBg: '#FF5C7C', myText: '#1F050C', myTime: 'rgba(31,5,12,0.70)', theirBg: '#3A1622', tailMine: '#FF5C7C', tailTheirs: '#3A1622' },
];

export function resolveChatPalette(key: string | null | undefined): ChatPalette {
  return CHAT_COLORS.find((c) => c.key === key) ?? CHAT_COLORS[0];
}

// ---- wallpaper presets --------------------------------------
// Each preset paints the chat background with soft color glows.
// 'custom:https://…' = user's own photo (rendered as an image).

export type WallpaperDef = {
  key: string;
  label: string;
  base: string;          // background base color
  glows: { w: number; h: number; top: `${number}%`; left?: number; right?: number; color: string }[];
};

export const WALLPAPERS: WallpaperDef[] = [
  {
    key: 'glow',
    label: 'Ember',
    base: 'transparent',
    glows: [
      { w: 340, h: 340, top: '28%', left: -150, color: 'rgba(255,122,26,0.05)' },
      { w: 300, h: 300, top: '18%', right: -130, color: 'rgba(99,102,241,0.06)' },
      { w: 220, h: 220, top: '4%', right: -90, color: 'rgba(56,189,248,0.05)' },
    ],
  },
  {
    key: 'night',
    label: 'Night',
    base: '#05070F',
    glows: [
      { w: 380, h: 380, top: '20%', left: -170, color: 'rgba(59,73,138,0.10)' },
      { w: 280, h: 280, top: '55%', right: -140, color: 'rgba(40,52,104,0.08)' },
    ],
  },
  {
    key: 'ocean',
    label: 'Ocean',
    base: '#04121A',
    glows: [
      { w: 360, h: 360, top: '25%', left: -160, color: 'rgba(56,189,248,0.09)' },
      { w: 300, h: 300, top: '60%', right: -150, color: 'rgba(45,212,191,0.07)' },
    ],
  },
  {
    key: 'sunset',
    label: 'Sunset',
    base: '#170A14',
    glows: [
      { w: 360, h: 360, top: '20%', right: -160, color: 'rgba(255,109,124,0.09)' },
      { w: 320, h: 320, top: '58%', left: -170, color: 'rgba(193,59,255,0.07)' },
    ],
  },
  {
    key: 'forest',
    label: 'Forest',
    base: '#07130B',
    glows: [
      { w: 360, h: 360, top: '26%', left: -160, color: 'rgba(52,211,153,0.08)' },
      { w: 280, h: 280, top: '62%', right: -140, color: 'rgba(16,185,129,0.06)' },
    ],
  },
  {
    key: 'violet',
    label: 'Violet',
    base: '#0B0818',
    glows: [
      { w: 360, h: 360, top: '24%', left: -160, color: 'rgba(139,123,255,0.10)' },
      { w: 300, h: 300, top: '60%', right: -150, color: 'rgba(99,102,241,0.08)' },
    ],
  },
];

export function isCustomWallpaper(w: string): boolean {
  return w.startsWith('custom:');
}

export function customWallpaperUri(w: string): string {
  return w.replace(/^custom:/, '');
}
