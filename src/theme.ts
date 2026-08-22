// ============================================================
// Gen Z — Design System v2
// Midnight navy + electric orange + violet glow
// ============================================================

export const colors = {
  // backgrounds — deep midnight navy
  bg: '#060A16',
  bgDeep: '#04070F',
  surface: '#0D1426',
  surfaceAlt: '#141C33',
  surfaceInput: '#0A101F',

  // glass (soft glassmorphism — translucent + light border)
  glass: 'rgba(18, 25, 48, 0.78)',
  glassBorder: 'rgba(255,255,255,0.10)',

  // borders
  border: '#1E2A47',
  borderStrong: '#2C3B61',

  // text — white / light gray
  text: '#F4F6FB',
  textMuted: '#9AA5C0',
  textFaint: '#64708C',

  // brand accents — electric orange (from logo) + violet/blue glow
  accent: '#FF9D1F',
  accentStrong: '#FF7A00',
  accentSoft: 'rgba(255,157,31,0.15)',
  accentGlow: 'rgba(255,157,31,0.38)',
  violet: '#8B7BFF',
  glowBlue: '#5B8CFF',

  // supporting
  yellow: '#FCE123',
  cyan: '#A8E6F2',
  logoWhite: '#F8F8F8',

  // feedback
  success: '#34D399',
  danger: '#FF5C7C',

  // misc
  overlay: 'rgba(3,6,14,0.55)',
  shadow: '#000000',
};

// consistent spacing scale
export const spacing = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  xxl: 36,
};

// large rounded cards + pills
export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
};

// typography scale — premium, consistent
export const type = {
  hero: { fontSize: 30, fontWeight: '800' as const, letterSpacing: 1.2, lineHeight: 38 },
  title: { fontSize: 23, fontWeight: '700' as const, letterSpacing: 0.4, lineHeight: 30 },
  heading: { fontSize: 17, fontWeight: '700' as const, letterSpacing: 0.2 },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  caption: { fontSize: 13, fontWeight: '500' as const, letterSpacing: 0.2 },
  micro: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2 },
};

// shadows — depth + orange glow (Android: elevation, iOS: shadow*)
export const shadows = {
  sm: {
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  md: {
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  glow: {
    shadowColor: '#FF9D1F',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  glowViolet: {
    shadowColor: '#8B7BFF',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
};
