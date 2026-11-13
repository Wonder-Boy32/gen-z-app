/**
 * THE LOOK ENGINE
 *
 * One SkSL fragment shader does every colour and beauty look. It samples the
 * live camera texture, so what the user sees on the preview IS the result of
 * these pixel operations — not a tinted View layered on top of a preview.
 *
 * Why one shader with uniforms instead of twelve shaders:
 *   - Changing look while recording is just a uniform update. No recompile, no
 *     session restart, no dropped frames.
 *   - Every look is the same code path, so a look cannot silently be a no-op.
 *
 * The beauty passes are real filters, not names:
 *   - `smooth` is a 5-tap blur blended back by a mid-luminance mask. It is a
 *     blur-blend, not an edge-aware bilateral filter — honest description, and
 *     cheap enough for a mid-range GPU at 30fps. It visibly softens skin and
 *     keeps the result from turning to plastic.
 *   - `glow` blends toward `max(sharp, blur)`, which blooms highlights. That is
 *     a genuine bloom approximation rather than a white veil.
 *
 * If the shader fails to compile on a device, `LOOK_SHADER` is null and the UI
 * says so. It never pretends a look is applied when it is not.
 */

import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

export type LookId =
  | 'none'
  | 'natural'
  | 'smooth'
  | 'bright'
  | 'glow'
  | 'warm'
  | 'cool'
  | 'vintage'
  | 'cinematic'
  | 'mono'
  | 'golden'
  | 'pastel'
  | 'punch';

export interface LookValues {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  lift: number;
  gain: number;
  smooth: number;
  glow: number;
  vignette: number;
}

export interface Look {
  id: LookId;
  label: string;
  /** Swatch colour for the carousel, so the row reads before you try each one. */
  swatch: string;
  /** Beauty looks are grouped separately in the carousel. */
  group: 'none' | 'beauty' | 'color';
  values: LookValues;
}

/** Identity. Every look is a delta from this. */
const BASE: LookValues = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  lift: 0,
  gain: 1,
  smooth: 0,
  glow: 0,
  vignette: 0,
};

export const LOOKS: Look[] = [
  { id: 'none', label: 'None', swatch: '#1A1A22', group: 'none', values: { ...BASE } },

  // ---- Beauty ----
  {
    id: 'natural',
    label: 'Natural',
    swatch: '#E8CDB0',
    group: 'beauty',
    // A nudge, not a filter: enough to clean up a phone sensor without the
    // "beautified" tell.
    values: { ...BASE, smooth: 0.18, brightness: 0.02, contrast: 1.04, saturation: 1.04 },
  },
  {
    id: 'smooth',
    label: 'Smooth',
    swatch: '#F0D9C4',
    group: 'beauty',
    values: { ...BASE, smooth: 0.55, brightness: 0.03, saturation: 1.02 },
  },
  {
    id: 'bright',
    label: 'Bright',
    swatch: '#FFF1D6',
    group: 'beauty',
    values: { ...BASE, smooth: 0.22, brightness: 0.09, contrast: 1.02, lift: 0.02 },
  },
  {
    id: 'glow',
    label: 'Glow',
    swatch: '#FFE9F0',
    group: 'beauty',
    values: { ...BASE, smooth: 0.35, glow: 0.45, brightness: 0.05, lift: 0.03 },
  },

  // ---- Colour ----
  {
    id: 'warm',
    label: 'Warm',
    swatch: '#FF9F45',
    group: 'color',
    values: { ...BASE, temperature: 0.55, saturation: 1.06, contrast: 1.03 },
  },
  {
    id: 'cool',
    label: 'Cool',
    swatch: '#4F8BFF',
    group: 'color',
    values: { ...BASE, temperature: -0.5, tint: 0.12, saturation: 1.02 },
  },
  {
    id: 'vintage',
    label: 'Vintage',
    swatch: '#C8A15A',
    group: 'color',
    // Lifted blacks and pulled saturation is what makes it read as film rather
    // than "brown".
    values: { ...BASE, lift: 0.055, gain: 0.94, saturation: 0.78, contrast: 1.1, temperature: 0.22 },
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    swatch: '#1E4E8C',
    group: 'color',
    values: { ...BASE, contrast: 1.22, saturation: 0.92, temperature: -0.28, tint: 0.18, vignette: 0.38 },
  },
  {
    id: 'mono',
    label: 'B&W',
    swatch: '#9A9A9A',
    group: 'color',
    values: { ...BASE, saturation: 0, contrast: 1.14, brightness: 0.01 },
  },
  {
    id: 'golden',
    label: 'Golden',
    swatch: '#FFB02E',
    group: 'color',
    values: { ...BASE, temperature: 0.72, brightness: 0.03, glow: 0.22, saturation: 1.1 },
  },
  {
    id: 'pastel',
    label: 'Pastel',
    swatch: '#D9B7F0',
    group: 'color',
    values: { ...BASE, lift: 0.07, gain: 0.95, saturation: 0.86, tint: 0.16, contrast: 0.95 },
  },
  {
    id: 'punch',
    label: 'Punch',
    swatch: '#FF2E88',
    group: 'color',
    values: { ...BASE, contrast: 1.28, saturation: 1.3, brightness: 0.01 },
  },
];

/**
 * Uniform declaration order is load-bearing: `makeShaderWithChildren` takes a
 * flat number array that is read in exactly this sequence. Reordering the
 * declarations without reordering `uniformsFor` silently gives every look the
 * wrong values — the kind of bug that looks like "filters do nothing".
 */
const SHADER_SOURCE = `
uniform shader src;

uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float temperature;
uniform float tint;
uniform float lift;
uniform float gain;
uniform float smoothAmount;
uniform float glow;
uniform float vignette;
uniform float sizeX;
uniform float sizeY;

half4 main(float2 xy) {
  half4 base = src.eval(xy);

  // 5-tap cross blur. Cheap enough for a mid-range GPU, wide enough to matter.
  half4 blur = base * 0.40
    + src.eval(xy + float2(3.0, 0.0)) * 0.15
    + src.eval(xy - float2(3.0, 0.0)) * 0.15
    + src.eval(xy + float2(0.0, 3.0)) * 0.15
    + src.eval(xy - float2(0.0, 3.0)) * 0.15;

  half3 c = base.rgb;

  // ---- beauty: smoothing, masked by luminance so eyes and lips keep detail
  half lum = dot(c, half3(0.299, 0.587, 0.114));
  half mask = smoothstep(0.15, 0.75, lum) * (1.0 - smoothstep(0.75, 1.0, lum));
  c = mix(c, blur.rgb, clamp(smoothAmount, 0.0, 1.0) * (0.35 + 0.65 * mask));

  // ---- beauty: bloom on highlights only
  c = mix(c, max(c, blur.rgb), clamp(glow, 0.0, 1.0));

  // ---- colour
  c = (c - 0.5) * contrast + 0.5;
  c = c + brightness;

  half grey = dot(c, half3(0.299, 0.587, 0.114));
  c = mix(half3(grey), c, saturation);

  c.r = c.r + temperature * 0.12;
  c.b = c.b - temperature * 0.12;
  c.g = c.g - tint * 0.08;

  c = c * gain + lift;

  // ---- vignette, measured from the frame centre
  float2 uv = xy / float2(max(sizeX, 1.0), max(sizeY, 1.0));
  float d = distance(uv, float2(0.5, 0.5));
  c = c * (1.0 - vignette * smoothstep(0.35, 0.85, d) * 1.4);

  return half4(clamp(c, 0.0, 1.0), base.a);
}
`;

/**
 * Compiled once at module load. `null` means this device's Skia rejected the
 * shader; callers must check and surface that rather than render an unfiltered
 * preview and call it a filter.
 */
export const LOOK_SHADER: SkRuntimeEffect | null = (() => {
  try {
    return Skia.RuntimeEffect.Make(SHADER_SOURCE) ?? null;
  } catch {
    return null;
  }
})();

/** Flat uniform block, in the exact order declared in SHADER_SOURCE. */
export function uniformsFor(look: Look, width: number, height: number): number[] {
  const v = look.values;
  return [
    v.brightness,
    v.contrast,
    v.saturation,
    v.temperature,
    v.tint,
    v.lift,
    v.gain,
    v.smooth,
    v.glow,
    v.vignette,
    width,
    height,
  ];
}

export function findLook(id: LookId): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0];
}
