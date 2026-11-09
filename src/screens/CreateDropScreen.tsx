import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { VideoView, useVideoPlayer } from 'expo-video';
import { captureRef } from 'react-native-view-shot';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import { screenTextError } from '../utils/contentFilter';
import Icon, { IconName } from '../components/ui/Icon';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/ui/VerifiedBadge';
import Button from '../components/Button';
import Draggable from '../components/create/Draggable';
import MediaPickerSheet from '../components/create/MediaPickerSheet';
import SoundPickerModal from '../components/create/SoundPickerModal';
import SoundTrack from '../components/SoundTrack';
import FilterCarousel, { getFilterLabel, getFilterTint } from '../components/create/FilterCarousel';
import StickerPicker from '../components/create/StickerPicker';
import TextLayerEditor, { TextLayer } from '../components/create/TextLayerEditor';
import VoiceoverRecorder from '../components/create/VoiceoverRecorder';
import PhotoEditorModal from '../components/create/PhotoEditorModal';
import CaptureScreen, { type CapturedAsset } from './CaptureScreen';
import { uploadMediaWithProgress } from '../utils/upload';
import { startUploadJob, type UploadReport } from '../utils/uploadManager';
import { extractVideoCover, hasNativeFFmpeg, processDropVideo } from '../utils/videoProcessor';
import { useAndroidBack } from '../utils/useAndroidBack';
import {
  adoptDraft,
  clearDraft,
  draftAge,
  hydrateDraft,
  writeDraft,
  type Draft,
} from '../utils/draftStore';

// ============================================================
// GEN Z — ADVANCED UPLOAD / CREATE
// CREATE → SELECT MEDIA → EDIT → PREVIEW → PUBLISH → DROP IT
// One posts row. expires_at = created_at + 7 days (DB-enforced, immutable).
// Drafts live in `drafts` and NEVER start the expiry timer.
// ============================================================

type Sound = {
  id: string;
  name: string;
  artist: string | null;
  category: string;
  usage_count: number;
  url?: string | null;
  start?: number;
  end?: number;
};
type Sticker = { id: string; emoji: string; x: number; y: number; size: number };
type Drop = { id: string; prompt: string; status: string; ends_at: string };
type Mode = 'media' | 'text';
type Step = 'hub' | 'create' | 'editor' | 'preview';
type Visibility = 'everyone' | 'followers' | 'only_me';

/**
 * How long a Drop lives, in ms — used ONLY to render the "Vanishes <day> at
 * <time>" label, which turns the rule into a concrete date.
 *
 * It must stay equal to the server rule in supabase/seven_day_expiry.sql
 * (`created_at + interval '7 days'`). Renamed from H48: the old name hardcoded
 * the duration into its own identifier, so changing the rule silently left the
 * label saying the wrong day.
 */
const DROP_LIFETIME_MS = 7 * 24 * 3600 * 1000;

const EFFECTS: { id: string; label: string; tint: string }[] = [
  { id: 'none', label: 'None', tint: 'rgba(0,0,0,0)' },
  { id: 'bloom', label: 'Bloom', tint: 'rgba(255,255,255,0.12)' },
  { id: 'neon', label: 'Neon', tint: 'rgba(255,45,220,0.16)' },
  { id: 'vhs', label: 'VHS', tint: 'rgba(90,220,160,0.14)' },
  { id: 'bw', label: 'B&W', tint: 'rgba(96,102,118,0.45)' },
  { id: 'glow', label: 'Glow', tint: 'rgba(139,123,255,0.24)' },
];
const SPEEDS = [0.5, 1, 1.5, 2];
const RATIOS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'original', label: 'Original', ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
];
const TEXT_DROP_COLORS = ['#0C1030', '#FF9A2E', '#8B5CF6', '#FF5C7C', '#34D399', '#1E2466'];

// ---- Create hub ----------------------------------------------------------
// Templates are recipes over state this screen ALREADY has (mode, collage,
// picker), so every card does something real instead of being decoration.
type HubIconName = React.ComponentProps<typeof Icon>['name'];

type HubTemplate = {
  id: string;
  group: string;
  title: string;
  sub: string;
  accent: string;
  icon: HubIconName;
  mode: Mode;
  collage?: string;
  openPicker?: boolean;
};

const HUB_FILTERS = ['For you', 'Text', 'Photos', 'Video'];
type HubFilter = (typeof HUB_FILTERS)[number];

const HUB_TEMPLATES: HubTemplate[] = [
  {
    id: 'quick',
    group: 'For you',
    title: 'Quick drop',
    sub: 'Pick media and go',
    accent: '#FF9A2E',
    icon: 'flash-outline',
    mode: 'media',
    openPicker: true,
  },
  {
    id: 'campus',
    group: 'For you',
    title: 'Campus moment',
    sub: 'One photo, short caption',
    accent: '#4DD8FF',
    icon: 'school-outline',
    mode: 'media',
    openPicker: true,
  },
  {
    id: 'textcard',
    group: 'Text',
    title: 'Text card',
    sub: 'A line worth reading',
    accent: '#8B5CF6',
    icon: 'create-outline',
    mode: 'text',
  },
  {
    id: 'statement',
    group: 'Text',
    title: 'Bold statement',
    sub: 'Big words, dark card',
    accent: '#FF5C7C',
    icon: 'chatbox-ellipses-outline',
    mode: 'text',
  },
  {
    id: 'duo',
    group: 'Photos',
    title: 'Duo',
    sub: 'Two photos, side by side',
    accent: '#34D399',
    icon: 'copy-outline',
    mode: 'media',
    collage: 'duo',
    openPicker: true,
  },
  {
    id: 'dump',
    group: 'Photos',
    title: 'Photo dump',
    sub: 'Up to four in a grid',
    accent: '#22D3EE',
    icon: 'grid-outline',
    mode: 'media',
    collage: 'grid',
    openPicker: true,
  },
  {
    id: 'video',
    group: 'Video',
    title: 'Video drop',
    sub: 'Trim, filter, add sound',
    accent: '#5B8CFF',
    icon: 'videocam-outline',
    mode: 'media',
    openPicker: true,
  },
];

type EditorOverlay =
  | 'trim'
  | 'sound'
  | 'effects'
  | 'text'
  | 'stickers'
  | 'filters'
  | 'cover'
  | 'voiceover'
  | 'speed'
  | 'crop'
  | 'rotate'
  | null;

const TOOLS: { id: EditorOverlay; icon: IconName; color: string; label: string }[] = [
  { id: 'trim', icon: 'cut-outline', color: '#FFFFFF', label: 'Trim' },
  { id: 'cover', icon: 'film-outline', color: '#FFFFFF', label: 'Cover' },
  { id: 'sound', icon: 'musical-note', color: '#4DD8FF', label: 'Sound' },
  { id: 'effects', icon: 'sparkles', color: '#8B5CF6', label: 'Effects' },
  { id: 'text', icon: 'text', color: '#FFFFFF', label: 'Text' },
  { id: 'stickers', icon: 'pricetag', color: '#FF9A2E', label: 'Stickers' },
  { id: 'filters', icon: 'color-palette', color: '#FF9A2E', label: 'Filters' },
  { id: 'voiceover', icon: 'mic', color: '#4DD8FF', label: 'Voiceover' },
  { id: 'speed', icon: 'flash', color: '#FF9A2E', label: 'Speed' },
  { id: 'crop', icon: 'scan', color: '#FFFFFF', label: 'Crop' },
  { id: 'rotate', icon: 'sync', color: '#4DD8FF', label: 'Rotate' },
];

// ============================================================
// CREATE HUB — VISUAL PRIMITIVES
//
// Gradients and glow are COMPOSED FROM VIEWS on purpose: expo-linear-gradient
// is not a dependency of this app, and adding a native module would mean
// another native rebuild. Everything below is plain JSX + StyleSheet, so it
// renders correctly on the APK that is already installed.
// ============================================================

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const raw = hex.replace('#', '').trim();
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

const rgbaOf = (c: Rgb, alpha: number) => `rgba(${c.r},${c.g},${c.b},${alpha})`;

// absolute fill, spelled out — this RN version's typings do not expose
// FILL, and a plain object also spreads cleanly
const FILL = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 };

/**
 * A real linear gradient assembled from `steps` stacked views.
 * Keep `steps` low when the two colours are close — banding is invisible at
 * low contrast, and each band is a view.
 */
function GradientFill({
  from,
  to,
  steps = 14,
  horizontal,
  alphaFrom = 1,
  alphaTo = 1,
  style,
}: {
  from: string;
  to: string;
  steps?: number;
  horizontal?: boolean;
  alphaFrom?: number;
  alphaTo?: number;
  style?: any;
}) {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const bands: React.ReactNode[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 0 : i / (steps - 1);
    bands.push(
      <View
        key={i}
        style={{
          flex: 1,
          backgroundColor: rgbaOf(mixRgb(start, end, t), alphaFrom + (alphaTo - alphaFrom) * t),
        }}
      />
    );
  }
  return (
    <View pointerEvents="none" style={[{ flexDirection: horizontal ? 'row' : 'column' }, style]}>
      {bands}
    </View>
  );
}

/** Soft radial falloff, approximated with concentric translucent circles. */
function Glow({
  color,
  size,
  strength = 0.18,
  style,
}: {
  color: string;
  size: number;
  strength?: number;
  style?: any;
}) {
  const base = hexToRgb(color);
  const rings = [
    { scale: 1, alpha: 0.3 },
    { scale: 0.66, alpha: 0.6 },
    { scale: 0.36, alpha: 1 },
  ];
  return (
    <View
      pointerEvents="none"
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      {rings.map((r) => {
        const d = Math.round(size * r.scale);
        return (
          <View
            key={r.scale}
            style={{
              position: 'absolute',
              width: d,
              height: d,
              borderRadius: d / 2,
              backgroundColor: rgbaOf(base, strength * r.alpha),
            }}
          />
        );
      })}
    </View>
  );
}

/**
 * Press feedback — a small scale + opacity dip.
 * `containerStyle` goes on the Pressable (use it for flex/margins so the item
 * lays out correctly inside a row); `style` goes on the animated surface.
 */
function Press({
  onPress,
  style,
  containerStyle,
  children,
  shrink = 0.97,
}: {
  onPress?: () => void;
  style?: any;
  containerStyle?: any;
  children: React.ReactNode;
  shrink?: number;
}) {
  const v = useRef(new Animated.Value(0)).current;
  const to = (n: number) =>
    Animated.spring(v, { toValue: n, useNativeDriver: true, speed: 42, bounciness: 0 }).start();

  return (
    <Pressable
      style={containerStyle}
      onPress={onPress}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
    >
      <Animated.View
        style={[
          style,
          {
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, shrink] }) }],
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] }),
          },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

/** Template category pill — the selection crossfades instead of snapping. */
function FilterPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(v, {
      toValue: active ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [active, v]);

  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Animated.View
        style={[
          styles.hbPill,
          active && styles.hbPillGlow,
          {
            backgroundColor: v.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(21,26,70,1)', 'rgba(193,59,255,0.15)'],
            }),
            borderColor: v.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(47,55,152,1)', 'rgba(193,59,255,1)'],
            }),
          },
        ]}
      >
        <Animated.Text
          style={[
            styles.hbPillText,
            {
              color: v.interpolate({
                inputRange: [0, 1],
                outputRange: [colors.textMuted, colors.accent],
              }),
            },
          ]}
        >
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * Template artwork. Photo templates render a miniature of the layout they
 * produce (two tiles for Duo, a 2x2 for Photo dump) instead of a generic icon,
 * so the card previews what you actually get.
 */
function TemplateArt({ t, width }: { t: HubTemplate; width: number }) {
  const accent = t.accent;
  const height = Math.round(width * 0.68);

  return (
    <View style={[styles.hbTplArt, { height }]}>
      <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={12} style={FILL} />
      <GradientFill
        from={accent}
        to={accent}
        steps={9}
        horizontal
        alphaFrom={0.34}
        alphaTo={0}
        style={FILL}
      />
      <Glow
        color={accent}
        size={Math.round(height * 1.5)}
        strength={0.16}
        style={{ position: 'absolute', top: -Math.round(height * 0.5), right: -Math.round(height * 0.35) }}
      />
      <View style={styles.hbTplArtCenter}>
        {t.collage === 'duo' ? (
          <View style={styles.hbMiniDuo}>
            <View style={[styles.hbMiniTile, { backgroundColor: rgbaOf(hexToRgb(accent), 0.55) }]} />
            <View style={[styles.hbMiniTile, { backgroundColor: rgbaOf(hexToRgb(accent), 0.28) }]} />
          </View>
        ) : t.collage === 'grid' ? (
          <View style={styles.hbMiniGrid}>
            {[0.55, 0.32, 0.4, 0.2].map((a, i) => (
              <View
                key={i}
                style={[styles.hbMiniGridTile, { backgroundColor: rgbaOf(hexToRgb(accent), a) }]}
              />
            ))}
          </View>
        ) : (
          <View style={[styles.hbTplIconChip, { borderColor: rgbaOf(hexToRgb(accent), 0.4) }]}>
            <Icon name={t.icon} size={20} color={colors.text} />
          </View>
        )}
      </View>
    </View>
  );
}

// ============================================================
// CREATE STUDIO — VISUALS
// Same rule as the hub: gradients and glow are composed from views, because
// expo-linear-gradient is not a dependency of this app and pulling in a native
// module would force another native rebuild.
// ============================================================

/** HUD corner brackets — the "scanner frame" around a drop zone. */
function CornerBrackets({
  color,
  size = 20,
  inset = 10,
}: {
  color: string;
  size?: number;
  inset?: number;
}) {
  const base = { position: 'absolute' as const, width: size, height: size, borderColor: color };
  return (
    <>
      <View
        pointerEvents="none"
        style={[base, { top: inset, left: inset, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { top: inset, right: inset, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { bottom: inset, left: inset, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 12 }]}
      />
      <View
        pointerEvents="none"
        style={[base, { bottom: inset, right: inset, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 12 }]}
      />
    </>
  );
}

/** Media | Text switch with a sliding gradient pill. */
function Segmented({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const [w, setW] = useState(0);
  const v = useRef(new Animated.Value(value === 'media' ? 0 : 1)).current;

  useEffect(() => {
    Animated.spring(v, {
      toValue: value === 'media' ? 0 : 1,
      useNativeDriver: true,
      speed: 16,
      bounciness: 7,
    }).start();
  }, [value, v]);

  const half = w > 0 ? (w - 8) / 2 : 0;
  const items: { key: Mode; label: string; icon: IconName }[] = [
    { key: 'media', label: 'Media', icon: 'videocam-outline' },
    { key: 'text', label: 'Text', icon: 'create-outline' },
  ];

  return (
    <View style={styles.cvSeg} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {half > 0 && (
        <Animated.View
          style={[
            styles.cvSegPill,
            {
              width: half,
              transform: [
                { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, half] }) },
              ],
            },
          ]}
        >
          <GradientFill from={colors.accent} to={colors.accentStrong} steps={10} horizontal style={FILL} />
        </Animated.View>
      )}
      {items.map((it) => {
        const active = value === it.key;
        return (
          <Pressable key={it.key} style={styles.cvSegItem} onPress={() => onChange(it.key)} hitSlop={4}>
            <Icon name={it.icon} size={15} color={active ? colors.bg : colors.textMuted} />
            <Text style={[styles.cvSegText, active && styles.cvSegTextActive]}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const TEXT_STARTERS = [
  'Unpopular opinion: ',
  'Hot take: ',
  'POV: ',
  'Nobody talks about ',
  'Reminder: ',
  'Confession: ',
];

  /** "Vanishes Sun at 07:00" — the real 7-day rule, made concrete. No backend change. */
function vanishLabel(ms: number): string {
  const d = new Date(Date.now() + ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Vanishes ${d.toLocaleDateString([], { weekday: 'short' })} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Generic animated single-choice row — shared by the mode and visibility switches. */
function ChoiceRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; icon: IconName }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.findIndex((o) => o.id === value));
  const v = useRef(new Animated.Value(idx)).current;

  useEffect(() => {
    Animated.spring(v, { toValue: idx, useNativeDriver: true, speed: 16, bounciness: 7 }).start();
  }, [idx, v]);

  const seg = w > 0 ? (w - 8) / options.length : 0;

  return (
    <View style={styles.cvSeg} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {seg > 0 && (
        <Animated.View
          style={[
            styles.cvSegPill,
            {
              width: seg,
              transform: [
                {
                  translateX: v.interpolate({
                    inputRange: options.map((_, i) => i),
                    outputRange: options.map((_, i) => i * seg),
                  }),
                },
              ],
            },
          ]}
        >
          <GradientFill from={colors.accent} to={colors.accentStrong} steps={10} horizontal style={FILL} />
        </Animated.View>
      )}
      {options.map((o) => {
        const active = value === o.id;
        return (
          <Pressable key={o.id} style={styles.cvSegItem} onPress={() => onChange(o.id)} hitSlop={4}>
            <Icon name={o.icon} size={14} color={active ? colors.bg : colors.textMuted} />
            <Text style={[styles.cvSegText, active && styles.cvSegTextActive]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function CreateDropScreen({
  onPosted,
  initialSound = null,
  replyToDropId = null,
  initialMediaUri = null,
  initialStep,
  initialCapture = null,
  initialText = null,
  openOnMount = null,
  resumeDraft = false,
  onExit,
}: {
  onPosted: () => void;
  initialSound?: string | null;
  replyToDropId?: string | null;
  initialMediaUri?: string | null;
  /**
   * Which step to open on. The create flow always passes 'create' — the old
   * 'hub' is now the launcher sheet in src/create/, so landing here at 'hub'
   * would mean two hubs. The prop stays optional so nothing else breaks.
   */
  initialStep?: Step;
  /** media handed over by the create flow's camera, or a shared file */
  initialCapture?: CapturedAsset | null;
  /** text written on the "Create a Drop" page */
  initialText?: string | null;
  /** a sheet to open as soon as this mounts (the camera's gallery / sound tools) */
  openOnMount?: 'gallery' | 'sound' | null;
  /** restore the saved draft and land in the composer */
  resumeDraft?: boolean;
  /**
   * Leave the composer. In the new flow this returns to the camera, because the
   * camera is the root of the flow — not the hub, and not the tab host.
   */
  onExit?: () => void;
}) {
  // land on the hub, unless we were opened with an intent (sound pick,
  // reply-with-drop, shared media) in which case go straight to creating
  const [step, setStep] = useState<Step>(
    initialStep ??
      (replyToDropId || initialMediaUri || initialSound || initialCapture || initialText
        ? 'create'
        : 'hub')
  );

  // The Android back control is wired further down, to stepBack() — the same
  // function the on-screen back arrows call, so the two can never disagree
  // about what "back" means. See the note there.
  const [mode, setMode] = useState<Mode>('media');
  const [assets, setAssets] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [caption, setCaption] = useState('');
  const [content, setContent] = useState('');
  const [textColor, setTextColor] = useState(TEXT_DROP_COLORS[0]);
  const [parentDropId, setParentDropId] = useState<string | null>(replyToDropId);

  // editor state
  const [sound, setSound] = useState<Sound | null>(null);
  const [filter, setFilter] = useState('original');
  const [effect, setEffect] = useState('none');
  const [speed, setSpeed] = useState(1);
  const [ratio, setRatio] = useState('original');
  const [rotation, setRotation] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimActive, setTrimActive] = useState(false);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  // Did WE choose this cover, or did the creator? Drives the "Auto" tag and
  // lets a re-pick replace an automatic choice without ever replacing a
  // deliberate one.
  const [coverAuto, setCoverAuto] = useState(false);
  // Bumped every time a new video is picked, so a slow pick for the previous
  // clip cannot land on the new one's panel.
  const coverGenRef = useRef(0);
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [collage, setCollage] = useState('single');
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(null);
  const [voiceoverMs, setVoiceoverMs] = useState(0);
  const [overlay, setOverlay] = useState<EditorOverlay>(null);

  // preview / publish state
  const [location, setLocation] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<{ id: string; username: string }[]>([]);
  const [visibility, setVisibility] = useState<Visibility>('everyone');
  const [allowLikes, setAllowLikes] = useState(true);
  const [allowComments, setAllowComments] = useState(true);
  const [allowShares, setAllowShares] = useState(true);
  const [allowReposts, setAllowReposts] = useState(true);
  const [allowDownloads, setAllowDownloads] = useState(true);
  const [allowMentions, setAllowMentions] = useState(true);
  const [postToDrop, setPostToDrop] = useState(false);
  const [liveDrop, setLiveDrop] = useState<Drop | null>(null);

  // ui state
  const [pickerOpen, setPickerOpen] = useState(false);
  // the in-app camera. Its own surface, because a capture is not a file pick.
  const [cameraOpen, setCameraOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [trimSound, setTrimSound] = useState<Sound | null>(null);
  const [textLayerOpen, setTextLayerOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  // The draft is no longer a "did you remember to save?" question — it is
  // written as you work. These are the bookkeeping pieces.
  const [draft, setDraft] = useState<Draft | null>(null);
  /** false until the stored draft has been read: writing before that would
   *  overwrite real work with the empty initial state */
  const draftReadyRef = useRef(false);
  /** the last payload written, so an unmount does not re-save identical bytes */
  const lastSigRef = useRef('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** throttles the cloud mirror; the local write is on every change */
  const cloudAtRef = useRef(0);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [draftSavedAt, setDraftSavedAt] = useState(0);
  /** false once this component is unmounted, so the final save stops touching state */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubFilter, setHubFilter] = useState<HubFilter>('For you');
  /** templates moved off screen 1 into their own sheet */
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [tagIdeas, setTagIdeas] = useState<{ tag: string; count: number }[]>([]);

  // template cards scale with the device instead of a hardcoded width, so they
  // never overflow a narrow Android screen or look lost on a large one
  const { width: winW } = useWindowDimensions();
  const tplW = Math.max(132, Math.min(158, Math.round(winW * 0.4)));

  // focus the text composer after inserting a starter prompt
  const textInputRef = useRef<TextInput>(null);

  // the poster's own identity, so the preview shows the real thing.
  // Read-only, one small select — nothing here is written back.
  const [me, setMe] = useState<{
    username: string;
    avatar_url: string | null;
    verified: boolean | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        if (!auth?.user) return;
        const { data } = await supabase
          .from('profiles')
          .select('username, avatar_url, verified')
          .eq('id', auth.user.id)
          .maybeSingle();
        const row = data as {
          username: string;
          avatar_url: string | null;
          verified: boolean | null;
        } | null;
        if (alive && row) setMe(row);
      } catch {
        // the preview just falls back to a neutral placeholder
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Android camera captures often report mimeType: null — detect video by
  // file extension as a fallback so recorded clips get a cover + correct type
  const isVideoAsset = (a: any): boolean =>
    (a?.mimeType?.startsWith('video') ?? false) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(a?.fileName ?? a?.uri ?? '');

  const firstIsVideo = assets.length > 0 && isVideoAsset(assets[0]);
  const firstVideoUri = firstIsVideo ? assets[0].uri : null;
  const coverSource = firstVideoUri; // what the hidden cover-capture player plays
  const player = useVideoPlayer(firstVideoUri ? { uri: firstVideoUri } : null, (p) => {
    p.loop = true;
    p.playbackRate = 1;
  });

  // Is the picked video actually running right now?
  //
  // Needed because the chosen sound has to start and stop with it. Subscribed
  // rather than polled: this fires on transitions only, so it never re-renders
  // the editor while a clip is playing.
  const [videoPlaying, setVideoPlaying] = useState(false);
  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('playingChange', (e: any) => setVideoPlaying(!!e.isPlaying));
    return () => sub.remove();
  }, [player]);

  // A chosen sound REPLACES the video's own audio — here, not only after
  // publishing.
  //
  // This was the reported bug: you pick a sound, hit play to check it, and
  // hear the original TikTok audio instead. The preview drew a bare <VideoView>
  // and nothing ever muted it, so the chosen track was invisible until the post
  // reached the feed. Silencing the video the moment a sound exists makes what
  // you hear while editing the same thing you will hear after.
  useEffect(() => {
    try {
      player.muted = !!sound?.url;
    } catch {
      // player disposed mid-swap
    }
  }, [player, sound?.url]);

  // trim loop — seek back to trimStart when the playhead crosses trimEnd
  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('timeUpdate', ({ currentTime }: { currentTime: number }) => {
      if (trimActive && trimEnd > trimStart && currentTime >= trimEnd) {
        player.currentTime = trimStart;
      }
    });
    return () => sub.remove();
  }, [player, trimActive, trimStart, trimEnd]);

  // re-target the player when a different video is picked
  useEffect(() => {
    if (player && firstVideoUri) {
      try {
        player.replace({ uri: firstVideoUri });
      } catch {
        // ignore — player replaces on next mount
      }
    }
  }, [player, firstVideoUri]);

  // ---- auto cover: hidden MUTED player + view-shot capture ----
  //
  // This player must never run on its own. It previously took `coverSource`
  // (= the same uri as the visible preview), was unmuted, and called play() both
  // in its initializer and in an effect — so picking a video started a SECOND
  // decoder of the same file, audible at the same time as the preview. That is
  // the "one video plays twice" bug: two plays, doubled audio, two decoders.
  //
  // It is now created with no source, muted, and the source is attached only
  // inside captureCoverNow() — i.e. only while a cover frame is actually being
  // grabbed. It has no reason to produce sound even then: it exists purely to
  // render a frame for the screenshot.
  const coverCaptureRef = useRef<View>(null);
  const capturePlayer = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.muted = true;
  });

  const captureCoverNow = useCallback(async (): Promise<string | null> => {
    if (!coverCaptureRef.current || !capturePlayer || !coverSource) return null;
    try {
      // attach the source only now, and stay silent — nothing else is decoding
      // this file for us at this point
      capturePlayer.muted = true;
      capturePlayer.replace({ uri: coverSource });
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      // ignore — grab() below reports failure by returning null
    }
    const grab = async (at: number): Promise<string | null> => {
      capturePlayer.pause();
      capturePlayer.currentTime = at; // a real frame — not the (often black) first frame
      await new Promise((r) => setTimeout(r, 300)); // let the seek land
      capturePlayer.play();
      // wait until the frame is actually decoded (with a safety timeout)
      const start = Date.now();
      while (capturePlayer.currentTime < at + 0.05 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // let the texture finish drawing before the screenshot
      await new Promise((r) => setTimeout(r, 700));
      capturePlayer.pause();
      return captureRef(coverCaptureRef.current, {
        format: 'jpg',
        quality: 0.85,
        result: 'tmpfile',
      });
    };
    try {
      const first = await grab(0.5);
      if (first) return first;
      // retry at a later frame in case the first was black/still decoding
      return await grab(1.5);
    } catch {
      return null;
    }
  }, [capturePlayer, coverSource]);

  /**
   * Choose a cover without being asked.
   *
   * Two engines, best first:
   *   1. Native builds — ffmpeg scans several windows of the clip and scores
   *      the candidate frames, so the cover is the most representative,
   *      best-exposed one rather than whatever was on screen at 0.5s.
   *   2. Expo Go / an ffmpeg failure — the frame-aware view-shot still beats
   *      leaving the tile empty.
   *
   * Returns null only when both routes fail, which is the one case where the
   * caller must not clear whatever cover is already there.
   */
  const autoPickCover = useCallback(async (): Promise<string | null> => {
    if (!coverSource) return null;
    setCoverBusy(true);
    try {
      if (hasNativeFFmpeg()) {
        try {
          const best = await extractVideoCover(coverSource, 'cover', {
            durationSec: player?.duration ?? 0,
          });
          if (best) return best;
        } catch (e: any) {
          console.warn('[cover] best-frame pick failed', e?.message);
        }
      }
      return await captureCoverNow();
    } finally {
      setCoverBusy(false);
    }
  }, [coverSource, player, captureCoverNow]);

  // Nobody should have to remember to pick a cover.
  //
  // This runs the moment a video is attached, in the background, and puts the
  // result straight into the Cover panel — so the automatic choice is visible
  // and overridable instead of being a silent promise made at publish time.
  // It deliberately does NOT run when a cover already exists: resuming a draft
  // must not discard the frame the creator chose for it.
  useEffect(() => {
    if (!coverSource) return;
    if (coverUri) return;

    const gen = ++coverGenRef.current;
    void (async () => {
      // Let the player above open the file first. Scoring three windows means
      // decoding roughly three seconds of video, and starting that in the same
      // frame as the preview's own decoder is how you get a stuttering first
      // play of the clip you just picked.
      await new Promise((r) => setTimeout(r, 600));
      const best = await autoPickCover();
      // A newer clip was attached while this one was being scored. Its run owns
      // the panel now; writing here would put the previous video's frame on it.
      if (gen !== coverGenRef.current) return;
      if (best) {
        setCoverUri(best);
        setCoverAuto(true);
      }
    })();
    // coverUri is intentionally read once, at attach time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverSource]);

  // create-intent: reply-to-drop chain link
  useEffect(() => {
    if (replyToDropId) setParentDropId(replyToDropId);
  }, [replyToDropId]);

  // create-intent: a pre-captured image (e.g. anonymous-message card)
  useEffect(() => {
    if (!initialMediaUri || assets.length) return;
    setMode('media');
    setAssets([
      {
        uri: initialMediaUri,
        mimeType: 'image/png',
        fileName: 'anonymous-card.png',
        width: 1080,
        height: 1460,
      } as ImagePicker.ImagePickerAsset,
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMediaUri]);

  // create-intent: sound preselected from the Sound page
  useEffect(() => {
    if (!initialSound || sound) return;
    (async () => {
      const { data } = await supabase.from('sounds').select('*').eq('name', initialSound).maybeSingle();
      if (data) setSound(data as Sound);
      else setSound({ id: 'preset', name: initialSound, artist: null, category: 'Viral', usage_count: 0 } as Sound);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSound]);

  // live drop fetch + draft on mount
  //
  // The draft comes from the local store first — synchronously-ish, offline, and
  // it is the copy the auto-save writes. The `drafts` row is only consulted when
  // this device has none (fresh install), because a stored payload is a list of
  // `file://` URIs that mean nothing on another phone anyway.
  useEffect(() => {
    (async () => {
      const local = await hydrateDraft();
      if (local) {
        setDraft(local);
        draftReadyRef.current = true;
      }

      const [{ data: dropRows }, { data: draftRows }] = await Promise.all([
        supabase.from('drops').select('*').eq('status', 'live').order('ends_at', { ascending: true }).limit(1),
        local
          ? Promise.resolve({ data: null })
          : supabase.from('drafts').select('updated_at, payload').order('updated_at', { ascending: false }).limit(1),
      ]);

      const drop = (dropRows?.[0] as Drop) ?? null;
      setLiveDrop(drop);
      setPostToDrop(!!drop);

      if (!local) {
        const row = draftRows?.[0] as { updated_at: string; payload: any } | undefined;
        if (row?.payload) {
          const adopted: Draft = {
            meta: {
              updatedAt: Date.parse(row.updated_at) || Date.now(),
              mode: row.payload.mode === 'text' ? 'text' : 'media',
              mediaCount: Array.isArray(row.payload.assets) ? row.payload.assets.length : 0,
              thumb: row.payload.coverUri ?? row.payload.assets?.[0]?.uri ?? null,
              caption: String(row.payload.caption ?? row.payload.content ?? '').slice(0, 80),
            },
            payload: row.payload,
          };
          adoptDraft(adopted);
          setDraft(adopted);
        }
      }
      // Only now may the auto-save write: before this point the state is empty
      // and would overwrite the very draft we are about to offer.
      draftReadyRef.current = true;
    })();
  }, []);

  // mention search
  useEffect(() => {
    if (!mentionQuery.trim()) {
      setMentionResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username')
        .ilike('username', `%${mentionQuery.trim().replace('@', '')}%`)
        .limit(6);
      setMentionResults((data ?? []) as { id: string; username: string }[]);
    }, 250);
    return () => clearTimeout(t);
  }, [mentionQuery]);

  const hasMedia = assets.length > 0;
  const imagesOnly = assets.every((a) => !isVideoAsset(a));
  const hasAnyContent = hasMedia || content.trim().length > 0 || caption.trim().length > 0;

  const ratioOf = RATIOS.find((r) => r.id === ratio)?.ratio ?? null;

  const resetAll = () => {
    setMode('media');
    setAssets([]);
    setCaption('');
    setContent('');
    setCoverUri(null);
    setCoverAuto(false);
    setSound(null);
    setFilter('original');
    setEffect('none');
    setSpeed(1);
    setRatio('original');
    setRotation(0);
    setTrimStart(0);
    setTrimEnd(0);
    setTrimActive(false);
    setTextLayers([]);
    setStickers([]);
    setCollage('single');
    setVoiceoverUrl(null);
    setVoiceoverMs(0);
    setLocation('');
    setMentions([]);
    setMentionQuery('');
    setVisibility('everyone');
    setAllowLikes(true);
    setAllowComments(true);
    setAllowShares(true);
    setAllowReposts(true);
    setAllowDownloads(true);
    setAllowMentions(true);
    setError(null);
  };

  const goEditor = () => {
    if (!hasMedia) return;
    // initialize trim range from the video duration
    if (firstIsVideo) {
      const dur = player?.duration ?? 0;
      setTrimStart(0);
      setTrimEnd(Math.max(1, dur));
    }
    setStep('editor');
    player?.play();
  };

  const goPreview = () => {
    if (mode === 'media' && !hasMedia) return;
    if (mode === 'text' && !content.trim()) return;
    player?.pause();
    setStep('preview');
  };

  // ---- drafts ----
  const draftPayload = () => ({
    mode,
    assets: assets.map((a) => ({ uri: a.uri, mimeType: a.mimeType, fileName: a.fileName, width: a.width, height: a.height })),
    caption,
    content,
    textColor,
    sound,
    coverUri,
    coverAuto,
    filter,
    effect,
    speed,
    ratio,
    rotation,
    trimStart,
    trimEnd,
    trimActive,
    textLayers,
    stickers,
    collage,
    voiceoverUrl,
    voiceoverMs,
    location,
    mentions,
    visibility,
    allowLikes,
    allowComments,
    allowShares,
    allowReposts,
    allowDownloads,
    allowMentions,
  });

  // The save runs from timers, an AppState listener and an unmount cleanup —
  // none of which are inside this render — so it reads the newest state through
  // refs rather than closed-over values that would be one keystroke stale.
  const draftPayloadRef = useRef(draftPayload);
  draftPayloadRef.current = draftPayload;
  const hasContentRef = useRef(false);
  hasContentRef.current = hasAnyContent;
  const uploadingRef = useRef(false);
  uploadingRef.current = uploading;

  /**
   * Write the draft that is on screen right now.
   *
   * Called from a 1.2s idle debounce, on app background, on leaving the editor,
   * and on unmount. It never navigates and never shows a dialog — that is the
   * whole point: the save is not an event the user has to attend to.
   *
   * `quiet` skips the "Saving…/Saved" pill, for the saves that happen while
   * nothing is on screen to show it (background, unmount).
   */
  const persistDraft = useCallback(
    async (quiet = false) => {
      if (!draftReadyRef.current) return;
      if (uploadingRef.current) return; // the post is on its way; a draft would be resurrected
      if (!hasContentRef.current) return; // nothing to keep

      const payload = draftPayloadRef.current();
      const sig = JSON.stringify(payload);
      if (sig === lastSigRef.current) return;
      lastSigRef.current = sig;

      if (!quiet) setDraftStatus('saving');

      const next = await writeDraft(payload, {
        mode: payload.mode === 'text' ? 'text' : 'media',
        mediaCount: Array.isArray(payload.assets) ? payload.assets.length : 0,
        thumb: (payload.coverUri as string) ?? (payload.assets as any[])?.[0]?.uri ?? null,
        caption: String(payload.caption || payload.content || '').slice(0, 80),
      });

      // The unmount save runs when this component is already gone; touching
      // state there would be pointless.
      if (aliveRef.current) {
        setDraft(next);
        if (!quiet) {
          setDraftStatus('saved');
          setDraftSavedAt(next.meta.updatedAt);
        }
      }

      // Best-effort cloud mirror, throttled. The local write above is the one
      // that matters; this keeps the `drafts` row roughly current for anything
      // reading it server-side, and costs one request per 20s at most.
      const now = Date.now();
      if (now - cloudAtRef.current > 20_000) {
        cloudAtRef.current = now;
        void (async () => {
          try {
            const { data: auth } = await supabase.auth.getUser();
            if (!auth?.user) return;
            await supabase
              .from('drafts')
              .upsert({ user_id: auth.user.id, payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
          } catch {
            // offline, or the table is unavailable: the local draft stands
          }
        })();
      }
    },
    []
  );

  /** run a save right now, cancelling any pending debounce */
  const flushDraft = useCallback(
    (quiet = false) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void persistDraft(quiet);
    },
    [persistDraft]
  );

  // ---- when the save happens ----------------------------------------------
  //
  // Nothing here is a button. The four triggers below are the four ways work
  // used to be lost:
  //
  //   1. you pause typing                  -> 1.2s idle debounce
  //   2. something comes up (call, lock)   -> AppState background/inactive
  //   3. you leave the create tab          -> unmount (the tab unmounts!)
  //   4. you tap ✕ in the editor/preview   -> leaveDrafting()

  // Leaving the editor or the preview no longer asks "save as draft?".
  //
  // The draft has been saved the whole time you were typing. A dialog there
  // would be asking the user to confirm something already true, and it used to
  // be the ONLY way work survived leaving the tab. Now it saves, and drops you
  // on the hub where the draft is visible.
  const leaveDrafting = () => {
    flushDraft();
    player?.pause();
    // Inside the create flow there is no hub to fall back to — the launcher
    // sheet replaced it. Exiting returns to the camera, and the draft is
    // already on disk, so the dock's dot is what tells the user it survived.
    if (onExit) {
      onExit();
      return;
    }
    setStep('hub');
  };

  /**
   * One level back, and nothing else.
   *
   * THIS IS THE FIX FOR "I'm in the caption and I can't go back".
   *
   * The ✕ in the editor and the preview both went straight to the hub, from
   * every level. So a creator who reached the caption step, remembered they
   * wanted a sound, and pressed it did not go back a step — they lost their
   * place entirely and had to walk the whole wizard again. The hardware back
   * button walked correctly, but nothing on screen did, so in practice the
   * flow looked like a dead end.
   *
   * preview → editor → create → hub, one level at a time, flushing the draft
   * on the way out so leaving a step never costs work. Tapping ✕ to abandon
   * the whole thing is still available on the preview and the hub.
   */
  const stepBack = useCallback(() => {
    if (step === 'hub') {
      // entry level inside the composer
      if (onExit) {
        onExit();
        return true;
      }
      return false; // standalone: let the host decide
    }
    flushDraft();
    player?.pause();
    if (step === 'create') {
      // Behind 'create' sits the camera in the flow, and the hub only when this
      // component is used on its own. Same answer every time you press back.
      if (onExit) {
        onExit();
        return true;
      }
      setStep('hub');
      return true;
    }
    setStep(step === 'preview' ? 'editor' : 'create');
    return true;
  }, [step, flushDraft, player, onExit]);

  // Android back runs through the same function as the on-screen arrows.
  useAndroidBack(stepBack);

  useEffect(() => {
    if (!draftReadyRef.current) return;
    if (!hasAnyContent || uploading) return;

    const sig = JSON.stringify(draftPayload());
    if (sig === lastSigRef.current) return;

    setDraftStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft();
    }, 1200);
    // No dependency array on purpose: this has to see every state change, and
    // the signature comparison is what makes it cheap. It is the same reason
    // the payload is serialised here rather than in a useMemo — a dependency
    // list that misses one of thirty fields fails silently.
  });

  useEffect(() => {
    // A phone call, a lock, the user swiping away: Android may never run another
    // frame, so this cannot wait for the debounce.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') flushDraft(true);
    });
    return () => sub.remove();
  }, [flushDraft]);

  useEffect(() => {
    // The create tab is lazy-mounted — `{tab === 'post' && <CreateDropScreen/>}`
    // — so switching tabs UNMOUNTS this whole component. Without this cleanup the
    // draft would be gone at exactly the moment the user glanced away.
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void persistDraft(true);
    };
    // persistDraft is stable and reads live state through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDraft = async () => {
    // Local first: it is the copy the auto-save keeps current. Fall back to the
    // stored row only if this device has nothing.
    const local = draft ?? (await hydrateDraft());
    let p: any = local?.payload ?? null;
    if (!p) {
      const { data } = await supabase
        .from('drafts')
        .select('payload')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      p = (data?.payload as any) ?? null;
    }
    if (!p) return;
    setMode(p.mode ?? 'media');
    setAssets((p.assets ?? []).map((a: any) => ({ uri: a.uri, mimeType: a.mimeType, fileName: a.fileName, width: a.width, height: a.height })));
    setCaption(p.caption ?? '');
    setContent(p.content ?? '');
    setTextColor(p.textColor ?? TEXT_DROP_COLORS[0]);
    setSound(p.sound ?? null);
    setCoverUri(p.coverUri ?? null);
    setCoverAuto(!!p.coverAuto);
    setFilter(p.filter ?? 'original');
    setEffect(p.effect ?? 'none');
    setSpeed(p.speed ?? 1);
    setRatio(p.ratio ?? 'original');
    setRotation(p.rotation ?? 0);
    setTrimStart(p.trimStart ?? 0);
    setTrimEnd(p.trimEnd ?? 0);
    setTextLayers(p.textLayers ?? []);
    setStickers(p.stickers ?? []);
    setCollage(p.collage ?? 'single');
    setVoiceoverUrl(p.voiceoverUrl ?? null);
    setVoiceoverMs(p.voiceoverMs ?? 0);
    setLocation(p.location ?? '');
    setMentions(p.mentions ?? []);
    setVisibility(p.visibility ?? 'everyone');
    setAllowLikes(p.allowLikes ?? true);
    setAllowComments(p.allowComments ?? true);
    setAllowShares(p.allowShares ?? true);
    setAllowReposts(p.allowReposts ?? true);
    setAllowDownloads(p.allowDownloads ?? true);
    setAllowMentions(p.allowMentions ?? true);
    setTrimActive(!!p.trimActive);

    // The draft stays in the store while it is being worked on — it IS the work.
    // Resuming used to clear it, which made the banner vanish and the dock dot
    // go out the moment you picked a draft back up.
    draftReadyRef.current = true;
    // Land on the create step, not the hub: a resumed draft that leaves you on a
    // menu looks like it did not load. Not the editor either — its trim range is
    // taken from the video's duration, which has not been measured yet at this
    // point, so opening there could restore a window the file cannot reach.
    setStep('create');
    if (local) setDraft(local);
    setDraftStatus('saved');
    setDraftSavedAt(local?.meta.updatedAt ?? Date.now());
  };

  // "Continue your draft" from the launcher.
  //
  // The hub used to hold the only button that called loadDraft(). The launcher
  // sheet replaced the hub, so the sheet now calls it — through this prop —
  // otherwise a draft would be saved, announced by the dock's dot, and then
  // impossible to open.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!resumeDraft || resumedRef.current) return;
    resumedRef.current = true;
    void loadDraft();
    // mount-only: loadDraft restores state, and re-running it would overwrite
    // whatever the user has typed since
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const discardDraft = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // Tell the auto-save to stand down BEFORE resetAll() empties the state, or
    // the empty state itself becomes the next save.
    draftReadyRef.current = false;
    lastSigRef.current = '';
    await clearDraft();
    setDraft(null);
    setDraftStatus('idle');
    resetAll();
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (auth?.user) await supabase.from('drafts').delete().eq('user_id', auth.user.id);
    } catch {
      // the local copy is gone, which is what the user asked for
    }
    draftReadyRef.current = true;
  };

  // ---- publish ----
  //
  // Posting no longer holds the user here. The heavy work — ffmpeg bake, uploads,
  // the row insert — is handed to uploadManager and this wizard closes straight
  // away, so the user lands back on the feed instead of watching a spinner. The
  // job then reports itself: an ambient bar at the bottom of the app with the
  // percentage still to go, and a notification when the post is live.
  //
  // runPublish() deliberately closes over THIS render's state rather than
  // rebuilding a payload object. It is called after this component unmounts, so
  // it must never touch component state — everything it needs is already captured.
  const publish = () => {
    if (uploading) return;
    if (mode === 'media' && !hasMedia) return;
    if (mode === 'text' && !content.trim()) return;

    // Screen BEFORE any work starts. A Drop is public, so this is the highest-
    // reach place for objectionable text to enter the app — and checking here
    // means a blocked post never begins uploading, rather than being caught
    // after the upload and leaving an orphaned file behind.
    const captionCheck = screenTextError(mode === 'text' ? content : caption);
    if (captionCheck) {
      setError(captionCheck);
      return;
    }

    setUploading(true);
    setError(null);

    // Capture the auto cover NOW, while the preview is still mounted.
    //
    // captureCoverNow() is a view-shot of the editor's preview view. The job runs
    // after this screen unmounts, so a capture started later would silently
    // return nothing — a video would post with no cover and look broken in the
    // feed. Starting the promise here, but not awaiting it, keeps the hand-off
    // instant while still reading a view that exists.
    const eagerCover: Promise<string | null> =
      mode === 'media' && coverUri ? Promise.resolve(coverUri) : captureCoverNow().catch(() => null);

    startUploadJob({
      label: mode === 'media' ? 'post' : 'text post',
      work: (report) => runPublish(report, eagerCover),
      doneTitle: 'Post successfully uploaded',
      doneBody: 'Your drop is live — go see it.',
    });

    onPosted(); // straight back to the feed; nothing to wait for
  };

  const runPublish = async (report: UploadReport, eagerCover: Promise<string | null>) => {
    report(0, 'Preparing…');
    {
      // getSession(), not getUser(): getUser() is an authoritative network check
      // and the SDK deletes the stored session if the server says it is not
      // active. A post upload must never be able to sign the user out.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      if (!user) throw new Error('Not logged in — sign in again to post.');

      const row: any = { user_id: user.id };
      let bakedVideo = false;

      if (mode === 'media') {
        const items: { url: string; type: string }[] = [];

        // Progress is measured in steps: one per asset, one for the cover when
        // the first item is a video, and one for the insert. Within a step the
        // real byte fraction of the transfer is what moves the bar.
        const hasVideoFirst = assets.length > 0 && isVideoAsset(assets[0]);
        const steps = assets.length + (hasVideoFirst ? 1 : 0) + 1;
        let stepBase = 0;
        const reportStep = (within: number, detail?: string) =>
          report((stepBase + Math.min(1, Math.max(0, within))) / steps, detail);

        for (let i = 0; i < assets.length; i++) {
          reportStep(0, `Uploading ${i + 1} of ${assets.length}`);
          const asset = assets[i];
          const isVideo = isVideoAsset(asset);
          let uri = asset.uri;

          // Native builds: bake trim/speed/rotation/filter/voiceover into the
          // actual file with ffmpeg. Expo Go has no ffmpeg → metadata-only path.
          if (isVideo && i === 0 && hasNativeFFmpeg()) {
            let voLocal: string | null = null;
            if (voiceoverUrl) {
              try {
                const fs: any = await import('expo-file-system/legacy');
                voLocal = `${fs.cacheDirectory}vo-${Date.now()}.m4a`;
                await fs.downloadAsync(voiceoverUrl, voLocal);
              } catch {
                voLocal = null;
              }
            }
            try {
              uri = await processDropVideo(asset.uri, {
                trim: trimActive && trimEnd > trimStart ? { start: trimStart, end: trimEnd } : null,
                speed,
                rotation,
                filter,
                voiceoverUri: voLocal,
              });
              bakedVideo = true;
            } catch {
              // fall back to playback-time metadata (still looks right)
            }
          }

          const ext = asset.fileName?.split('.').pop() ?? (isVideo ? 'mp4' : 'jpg');
          const publicUrl = await uploadMediaWithProgress(
            `${user.id}/drop-${Date.now()}-${i}.${ext}`,
            uri,
            asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
            (f) => reportStep(f)
          );
          items.push({ url: publicUrl, type: isVideo ? 'video' : 'image' });
          stepBase += 1;
          reportStep(
            0,
            i + 1 < assets.length ? `Uploading ${i + 2} of ${assets.length}` : 'Finishing up…'
          );

          // cover: user-picked, else auto-capture a frame (view-shot, works
          // everywhere), else ffmpeg frame in native builds. Failures are
          // logged (never silent) so missing covers are diagnosable.
          if (isVideo && i === 0) {
            let coverSrc: string | null = coverUri;
            if (!coverSrc) {
              // native builds: ffmpeg extracts a perfect frame; Expo Go:
              // frame-aware view-shot (skips black first frames)
              if (hasNativeFFmpeg()) {
                try {
                  coverSrc = await extractVideoCover(asset.uri);
                } catch (e: any) {
                  console.warn('[cover] ffmpeg frame failed', e?.message);
                }
              }
              if (!coverSrc) {
                // Already captured in publish() while the preview was mounted —
                // this screen is gone by now, so a fresh view-shot would be empty.
                coverSrc = await eagerCover;
              }
            }
            if (coverSrc) {
              try {
                row.cover_url = await uploadMediaWithProgress(
                  `${user.id}/cover-${Date.now()}.jpg`,
                  coverSrc,
                  'image/jpeg',
                  (f) => reportStep(f)
                );
              } catch (e: any) {
                console.warn('[cover] cover upload failed', e?.message);
              }
            } else {
              console.warn('[cover] NO cover produced — video tile will use placeholder');
            }
            stepBase += 1;
            reportStep(0);
          }
        }
        row.media_url = items[0].url;
        row.media_type = items[0].type;
        if (items.length > 1) row.media_items = items;
        row.caption = caption.trim() || null;
      } else {
        row.content = content.trim();
        row.text_bg = textColor;
        row.text_color = ['#0C1030', '#1E2466'].includes(textColor) ? '#FFFFFF' : '#0C1030';
      }

      row.sound = sound?.name ?? null;
      row.audio = sound?.name ?? null; // feed chip + audio mode read `audio`
      row.sound_artist = sound?.artist ?? null;
      row.sound_url = sound?.url ?? null;
      // The sound window, stored in seconds.
      //
      // The feed plays [sound_start, sound_end] and wraps back to the start when
      // it gets there, so the sound covers the whole video however long the post
      // runs.
      //
      // This window is a property of the TRACK, not of the video, and that is
      // the fix: it used to be capped to the video's length. A cue picked at
      // 0:20 for a 12s clip was reset to 0:00, and a 30s window on a 12s clip
      // became 0–12. Picking "the exact part of the song" silently turned into
      // "pick from the top" — which is exactly what was reported. Where in the
      // song you start has nothing to do with how long your clip is.
      //
      // Only the stored value's playability is checked here: start >= 0, end
      // after start, and a window too short to hear is widened to the rest of
      // the track instead of looping every fifth of a second. Clamping to the
      // REAL file length cannot happen here — the file has not been measured at
      // this point, and the length changes when the picker re-trims — so it
       // lives in SoundTrack, which does measure it.
       //
       // The old cap existed to keep the sound's loop and the video's loop on the
       // same span. That trade was the wrong way round: it bought a seam that
       // only lined up when the window happened to equal the clip length, and it
       // paid for that with the cue the user picked. The sound is a bed under the
       // picture, so a periodic seam of its own is acceptable; losing the chosen
       // part of the song is not.
       const round1 = (n: number) => Math.round(n * 10) / 10;
      if (sound) {
        const s = Math.max(0, sound.start ?? 0);
        const e = sound.end != null && sound.end - s >= 0.5 ? sound.end : null;
        row.sound_start = round1(s);
        row.sound_end = e == null ? null : round1(e);
      } else {
        row.sound_start = 0;
        row.sound_end = null;
      }
      row.visibility = visibility;
      row.allow_likes = allowLikes;
      row.allow_comments = allowComments;
      row.allow_shares = allowShares;
      row.allow_reposts = allowReposts;
      row.allow_downloads = allowDownloads;
      row.allow_mentions = allowMentions;
      row.text_layers = textLayers.length ? textLayers : null;
      row.stickers = stickers.length ? stickers : null;
      // when ffmpeg baked the edits into the file, drop them from metadata
      // (text layers + stickers stay — they're UI overlays even on TikTok)
      row.filters = bakedVideo ? null : [{ id: filter, label: getFilterLabel(filter) }];
      row.effects = bakedVideo
        ? { effect: null, speed: 1, ratio, rotation: 0, trim: null, collage: imagesOnly && assets.length > 1 ? collage : null }
        : {
            effect,
            speed,
            ratio,
            rotation,
            trim: trimActive && trimEnd > trimStart ? { start: trimStart, end: trimEnd } : null,
            collage: imagesOnly && assets.length > 1 ? collage : null,
          };
      row.voiceover_url = bakedVideo ? null : voiceoverUrl;
      row.location = location.trim() || null;
      row.mentions = mentions.length ? mentions : null;
      if (postToDrop && liveDrop) row.drop_id = liveDrop.id;
      if (parentDropId) row.parent_drop_id = parentDropId;

      // expires_at is NOT sent — the DB sets created_at and expires_at (+7 days)
      report(0.97, 'Publishing…');
      const { error: err } = await supabase.from('posts').insert(row);
      if (err) throw new Error(err.message);
      report(1);

      // The work is a post now, so it stops being a draft — locally AND in the
      // mirror. This also stands the auto-save down: without the flag the
      // unmount cleanup would write the draft straight back, and the user would
      // see a banner for a drop they just published.
      draftReadyRef.current = false;
      lastSigRef.current = '';
      await clearDraft();
      await supabase.from('drafts').delete().eq('user_id', user.id);

      // No 'live' step and no animation any more: this screen is already gone and
      // the user is on the feed. uploadManager reports completion from there.
      //
      // Errors are deliberately NOT caught here. This component is unmounted, so
      // it must not touch state — throwing lets uploadManager surface the failure
      // in the ambient bar, where the user actually is.
    }
  };

  const addSticker = (emoji: string) => {
    setStickers((s) => [
      ...s,
      { id: `s-${Date.now()}`, emoji, x: 60 + Math.random() * 140, y: 140 + Math.random() * 200, size: 52 },
    ]);
  };

  // an incoming intent must never land behind the hub
  useEffect(() => {
    if (initialText) {
      setMode('text');
      setContent(initialText);
      setStep('create');
      return;
    }
    if (replyToDropId || initialMediaUri || initialSound) setStep('create');
  }, [replyToDropId, initialMediaUri, initialSound, initialText]);

  // Trending tags are the community's own: any #tag anyone posts is
  // auto-indexed into hashtags by sync_hashtags(), so this list is live.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('hashtags')
        .select('tag, count')
        .order('count', { ascending: false })
        .limit(10);
      if (alive) setTagIdeas((data ?? []) as { tag: string; count: number }[]);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- hashtags: live suggestions for the token being typed ----
  //
  // The chips further down are the community's TOP tags. These are the ones that
  // actually match what you're typing, and — critically — the counts come from
  // hashtag_suggest()/hashtag_count(), which count LIVE posts only (not expired,
  // not removed). The old chips read hashtags.count, a counter that only ever
  // went up because the expiry purge deleted posts without recomputing it, so they
  // were advertising tags from posts that no longer existed.
  const activeTagToken = useMemo(() => {
    // The token must be the LAST thing in the caption — that's what "currently
    // typing" means. Editing mid-text won't pop the list open, deliberately:
    // a dropdown appearing while you fix a typo three words back is worse than
    // no dropdown.
    const m = /(?:^|\s)#([A-Za-z0-9_]{1,40})$/.exec(caption);
    return m ? m[1].toLowerCase() : null;
  }, [caption]);

  const [tagSuggestions, setTagSuggestions] = useState<{ tag: string; post_count: number }[]>([]);
  // undefined = still checking, number = a real count, null = couldn't check.
  // The three states matter: if the RPC fails (the migration not run yet, say) the
  // count row hides itself rather than sitting on "Checking…" forever, and rather
  // than claiming zero — which would be a lie the user might act on.
  const [tagExactCount, setTagExactCount] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    if (!activeTagToken) {
      setTagSuggestions([]);
      setTagExactCount(undefined);
      return;
    }
    let alive = true;
    // Debounced. Typing "#a #ab #abc" otherwise fires three overlapping requests
    // that can land out of order and repaint the list with stale results.
    const t = setTimeout(async () => {
      const [sug, cnt] = await Promise.all([
        supabase.rpc('hashtag_suggest', { p_prefix: activeTagToken, p_limit: 8 }),
        supabase.rpc('hashtag_count', { p_tag: activeTagToken }),
      ]);
      if (!alive) return;
      setTagSuggestions((sug.data ?? []) as { tag: string; post_count: number }[]);
      setTagExactCount(cnt.error ? null : typeof cnt.data === 'number' ? cnt.data : 0);
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [activeTagToken]);

  /** Finish the #token being typed, preserving whatever whitespace preceded it. */
  const completeTag = (tag: string) => {
    setCaption((c) => c.replace(/(^|\s)#[A-Za-z0-9_]{1,40}$/, `$1#${tag} `));
  };

  // ---- location ----
  //
  // Two ways in, both genuinely real: your device's GPS, reverse-geocoded to a
  // place name; or a location the community has actually posted from. There is no
  // external gazetteer wired into this app, so arbitrary typed text cannot be
  // validated against a world places database — and these controls don't pretend
  // to. What they DO give you is availability: whether anything is already posted
  // there, and how much.
  //
  // Matching is case- and whitespace-insensitive server-side, so "Lagos", "lagos"
  // and " Lagos " are one place rather than three. Picking a suggestion stores the
  // spelling most posts already use, so using the feature tidies the data.
  const [locSuggestions, setLocSuggestions] = useState<{ location: string; post_count: number }[]>([]);
  // Same three states as the tag count, for the same reason.
  const [locExactCount, setLocExactCount] = useState<number | null | undefined>(undefined);
  const [locBusy, setLocBusy] = useState(false);
  const [locNotice, setLocNotice] = useState<string | null>(null);

  useEffect(() => {
    const q = location.trim();
    if (!q) {
      setLocSuggestions([]);
      setLocExactCount(undefined);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const [sug, cnt] = await Promise.all([
        supabase.rpc('location_suggest', { p_prefix: q, p_limit: 8 }),
        supabase.rpc('location_count', { p_location: q }),
      ]);
      if (!alive) return;
      setLocSuggestions((sug.data ?? []) as { location: string; post_count: number }[]);
      setLocExactCount(cnt.error ? null : typeof cnt.data === 'number' ? cnt.data : 0);
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [location]);

  const useMyLocation = async () => {
    setLocBusy(true);
    setLocNotice(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setLocNotice('Location permission is off. You can type a place instead.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const places = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      const p = places[0];
      // "City, Country" — the shape people type by hand, so a GPS place and a
      // typed place end up looking the same in the feed instead of one being
      // "Lagos, Nigeria" and the other a raw coordinate string.
      const parts = [p?.city ?? p?.subregion ?? p?.region, p?.country].filter(Boolean);
      if (!p || parts.length === 0) {
        setLocNotice("Couldn't work out where you are. Try typing it instead.");
        return;
      }
      setLocation(parts.join(', '));
    } catch {
      setLocNotice('Could not get your location. Check that GPS is on.');
    } finally {
      setLocBusy(false);
    }
  };

  const startFresh = (m: Mode) => {
    setMode(m);
    setStep('create');
  };

  const applyTemplate = (t: HubTemplate) => {
    setMode(t.mode);
    if (t.collage) setCollage(t.collage);
    setStep('create');
    if (t.openPicker) setTimeout(() => setPickerOpen(true), 240);
  };

  /**
   * A capture comes back as a bare uri. Everything downstream — cover
   * extraction, video detection, the uploader's mime handling — expects an
   * ImagePicker asset, so the missing fields are filled here rather than
   * scattered through four call sites.
   */
  const handleCaptured = (a: CapturedAsset) => {
    const asset = {
      uri: a.uri,
      width: a.width,
      height: a.height,
      type: a.type,
      fileName: a.fileName,
      mimeType: a.mimeType,
      duration: a.durationMs != null ? Math.round(a.durationMs / 1000) : null,
      assetId: null,
      base64: null,
      exif: null,
      fileSize: undefined,
      file: undefined,
      pairedVideoAsset: null,
    } as unknown as ImagePicker.ImagePickerAsset;

    setMode('media');
    setCameraOpen(false);
    if (a.type === 'video') {
      // One clip only — the app does not mix a video with photos — and go
      // straight to the editor, because a fresh recording always needs trim.
      setAssets([asset]);
      setStep('editor');
    } else {
      setAssets((prev) => [...prev, asset].slice(0, 6));
    }
  };

  // A capture from the flow's own camera arrives as a prop instead of as a
  // callback, but it has to land through the same door: a video must reach the
  // editor and a photo must join the strip, and the cover picker must see it.
  // Two entry points, one implementation.
  const ingestedRef = useRef(false);
  useEffect(() => {
    if (!initialCapture || ingestedRef.current) return;
    ingestedRef.current = true;
    handleCaptured(initialCapture);
    // mount-only on purpose: a re-render must not re-ingest the same file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The entry camera's gallery and sound tools land here, because this is the
  // only place that owns those sheets. The delay clears the camera's own Modal
  // dismissal; two Modals crossing mid-animation is what used to leave the
  // picker behind the camera on Android.
  useEffect(() => {
    if (!openOnMount) return;
    const t = setTimeout(() => {
      if (openOnMount === 'sound') setSoundOpen(true);
      else setPickerOpen(true);
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addTagToCaption = (tag: string) => {
    setCaption((c) => {
      if (c.includes(`#${tag}`)) return c;
      const sep = c.length > 0 && !c.endsWith(' ') ? ' ' : '';
      return `${c}${sep}#${tag} `;
    });
  };

  const addIdeaToCaption = (text: string) => {
    setCaption((c) => (c.trim().length > 0 ? c : text));
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  // "Saving…" / "Saved just now" — shown in the header of each working step.
  // The save is automatic, so it says so quietly; it is a status, not a button.
  const draftChip =
    hasAnyContent && draftStatus !== 'idle' ? (
      <View style={styles.draftChip}>
        <Icon
          name={draftStatus === 'saving' ? 'cloud-upload-outline' : 'checkmark-circle'}
          size={11}
          color={draftStatus === 'saving' ? colors.textMuted : colors.accent}
        />
        <Text style={styles.draftChipText}>
          {draftStatus === 'saving' ? 'Saving draft…' : `Draft saved · ${draftAge(draftSavedAt)}`}
        </Text>
      </View>
    ) : null;

  return (
    <View style={styles.container}>
      {step === 'hub' && (
        <>
        <ScrollView contentContainerStyle={styles.hubContent} showsVerticalScrollIndicator={false}>
          {/* ambient corner light — barely there, just enough to lift the header */}
          <Glow color={colors.accent} size={230} strength={0.05} style={styles.hbAmbient} />

          {/* ---------- header ---------- */}
          <View style={styles.hbHeadRow}>
            <View style={styles.hbMark}>
              <Image source={require('../../assets/icon-navy.png')} style={styles.hbMarkImg} />
            </View>
            <Text style={styles.hbWordmark}>GEN Z</Text>
          </View>
          <Text style={styles.hbTitle}>
            Create a <Text style={styles.hbTitleAccent}>moment</Text>
          </Text>
          <Text style={styles.hbSub}>Share what's happening right now.</Text>

          {/* ---------- hero: new drop ---------- */}
          <Press containerStyle={styles.hbHeroWrap} style={styles.hbHero} onPress={() => startFresh('media')} shrink={0.985}>
            {/* theme tokens, not literals: the copy inside this card reads
                colors.text, so the panel behind it has to invert with the same
                palette or White mode gets near-black text on navy */}
            <GradientFill from={colors.heroFrom} to={colors.heroTo} steps={16} style={FILL} />
            <GradientFill
              from={colors.accent}
              to={colors.accentStrong}
              steps={12}
              horizontal
              alphaFrom={0}
              alphaTo={0.22}
              style={FILL}
            />
            <Glow color={colors.accent} size={190} strength={0.2} style={styles.hbHeroGlow} />
            <View style={styles.hbHeroRow}>
              <View style={styles.hbHeroText}>
                <Text style={styles.hbHeroEyebrow}>CREATE A MOMENT</Text>
                <Text style={styles.hbHeroTitle}>Capture what's happening right now</Text>
                <View style={styles.hbHeroMeta}>
                  <Icon name="hourglass-outline" size={12} color={colors.accent} />
                  <Text style={styles.hbHeroMetaText}>Live for 7 days</Text>
                </View>
              </View>
              {/* The + was decorative. It shoots now: the card says "capture
                  what's happening right now", so that is what its button does. */}
              <Pressable
                style={styles.hbHeroBtn}
                onPress={() => setCameraOpen(true)}
                accessibilityLabel="Open camera"
              >
                <GradientFill
                  from={colors.accent}
                  to={colors.accentStrong}
                  steps={10}
                  style={FILL}
                />
                <Icon name="camera" size={24} color={colors.bg} />
              </Pressable>
            </View>
          </Press>

          {/* ---------- drafts | text ---------- */}
          <View style={styles.hbRow}>
            <Press
              containerStyle={styles.hbRowItem}
              style={styles.hbAction}
              onPress={() => (draft ? loadDraft() : startFresh('media'))}
            >
              <GradientFill
                from={colors.accent}
                to={colors.accent}
                steps={6}
                horizontal
                alphaFrom={0.13}
                alphaTo={0}
                style={FILL}
              />
              <View
                style={[
                  styles.hbActionIcon,
                  { backgroundColor: colors.accentSoft, borderColor: 'rgba(193,59,255,0.28)' },
                ]}
              >
                <Icon name="albums-outline" size={17} color={colors.accent} />
              </View>
              <Text style={styles.hbActionTitle}>Drafts</Text>
              <Text style={styles.hbActionSub} numberOfLines={2}>
                {draft
                  ? `Pick up where you left off · ${draftAge(draft.meta.updatedAt)}`
                  : 'Edits save themselves as you go'}
              </Text>
            </Press>

            <Press
              containerStyle={styles.hbRowItem}
              style={styles.hbAction}
              onPress={() => startFresh('text')}
            >
              <GradientFill
                from={colors.violet}
                to={colors.violet}
                steps={6}
                horizontal
                alphaFrom={0.13}
                alphaTo={0}
                style={FILL}
              />
              <View
                style={[
                  styles.hbActionIcon,
                  { backgroundColor: 'rgba(139,123,255,0.15)', borderColor: 'rgba(139,123,255,0.28)' },
                ]}
              >
                <Icon name="create-outline" size={17} color={colors.violet} />
              </View>
              <Text style={styles.hbActionTitle}>Text</Text>
              <Text style={styles.hbActionSub} numberOfLines={2}>
                Say it in words
              </Text>
            </Press>
          </View>

          {/* ---------- templates: demoted, not deleted ----------
              This was a full marketplace sitting on screen one: a 4-pill filter
              row plus a template carousel, competing with the main action.

              A template is a SHORTCUT, not a first decision. Screen one now
              answers exactly one question — "What do I want to create?" — whose
              answer is "a Moment". Templates live one step deeper, behind this
              link, and every template is still reachable.
          --------------------------------------------------------------- */}
          <Press style={styles.hbTplLink} onPress={() => setTemplatesOpen(true)} shrink={0.98}>
            <Icon name="grid-outline" size={15} color={colors.violet} />
            <Text style={styles.hbTplLinkText}>Use a template</Text>
            <Text style={styles.hbTplLinkHint}>Create faster</Text>
            <Icon name="chevron-forward" size={15} color={colors.textFaint} />
          </Press>
        </ScrollView>

        {/* ---------- template sheet ---------- */}
        <Modal
          visible={templatesOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setTemplatesOpen(false)}
        >
          <Pressable style={styles.hbSheetBackdrop} onPress={() => setTemplatesOpen(false)}>
            {/* inner Pressable swallows taps so the sheet itself does not close */}
            <Pressable style={styles.hbSheetCard} onPress={() => undefined}>
              <View style={styles.hbSheetGrab} />
              <Text style={styles.hbSheetTitle}>Create faster</Text>
              <Text style={styles.hbSheetSub}>Start from a template, then make it yours.</Text>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hbPills}>
                {HUB_FILTERS.map((f) => (
                  <FilterPill
                    key={f}
                    label={f}
                    active={hubFilter === f}
                    onPress={() => setHubFilter(f as HubFilter)}
                  />
                ))}
              </ScrollView>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hbTplRow}>
                {HUB_TEMPLATES.filter((t) => t.group === hubFilter).map((t) => (
                  <Press
                    key={t.id}
                    style={[styles.hbTpl, { width: tplW }]}
                    onPress={() => {
                      setTemplatesOpen(false);
                      applyTemplate(t);
                    }}
                  >
                    <TemplateArt t={t} width={tplW} />
                    <View style={styles.hbTplBody}>
                      <Text style={styles.hbTplTitle} numberOfLines={1}>
                        {t.title}
                      </Text>
                      <Text style={styles.hbTplSub} numberOfLines={2}>
                        {t.sub}
                      </Text>
                    </View>
                  </Press>
                ))}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
        </>
      )}

      {step === 'create' && (
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <ScrollView
            contentContainerStyle={styles.createContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* ---------- studio top bar ---------- */}
            <View style={styles.cvTopBar}>
              <Pressable style={styles.hubBack} onPress={() => setStep('hub')} hitSlop={8}>
                <Icon name="chevron-back" size={17} color={colors.textMuted} />
                <Text style={styles.hubBackText}>Templates</Text>
              </Pressable>
              <View style={styles.cvLivePill}>
                <View style={styles.cvLiveDot} />
                <Text style={styles.cvLiveText}>STUDIO</Text>
              </View>
            </View>

            <Text style={styles.cvHeadline}>
              {mode === 'media' ? 'Drop your moment' : 'Say it out loud'}
            </Text>
            <Text style={styles.cvSub}>
              {mode === 'media'
                ? 'Photos or one video. It goes live the moment you post.'
                  : 'One thought, no edits. It lives for 7 days.'}
            </Text>

            {!!draftChip && <View style={styles.draftChipRow}>{draftChip}</View>}

            {parentDropId && (
              <View style={styles.replyBanner}>
                <Text style={styles.replyBannerText}>
                  Replying to a Drop — this links back to the original and gets its own 7 days.
                </Text>
              </View>
            )}

            <Segmented value={mode} onChange={setMode} />

            {/* The draft, always visible on the hub: what is in it, when it was
                last written, and the way back into it. No "save as draft"
                button anywhere — this is just where the saved work is shown. */}
            {draft && (
              <View style={styles.draftBanner}>
                {draft.meta.thumb ? (
                  draft.meta.mode === 'text' ? (
                    <View style={[styles.draftThumb, styles.draftThumbPh]}>
                      <Icon name="text" size={15} color={colors.accent} />
                    </View>
                  ) : (
                    <Image source={{ uri: draft.meta.thumb }} style={styles.draftThumb} />
                  )
                ) : (
                  <View style={[styles.draftThumb, styles.draftThumbPh]}>
                    <Icon name="bookmark-outline" size={15} color={colors.accent} />
                  </View>
                )}

                {/* flex must be on containerStyle: Press puts containerStyle on
                    the Pressable and `style` on the inner Animated.View */}
                <Press containerStyle={styles.draftBannerBody} onPress={loadDraft} shrink={0.99}>
                  <Text style={styles.draftBannerTitle} numberOfLines={1}>
                    {draft.meta.caption?.trim() ? draft.meta.caption.trim() : 'Untitled draft'}
                  </Text>
                  <Text style={styles.draftBannerText} numberOfLines={1}>
                    {draft.meta.mode === 'text'
                      ? 'Text drop'
                      : draft.meta.mediaCount > 1
                        ? `${draft.meta.mediaCount} clips`
                        : '1 clip'}
                    {' · saved '}
                    {draftAge(draft.meta.updatedAt)}
                  </Text>
                </Press>

                <Press style={styles.draftBannerResume} onPress={loadDraft} shrink={0.96}>
                  <Text style={styles.draftBannerCta}>Resume</Text>
                </Press>

                <Press style={styles.draftBannerX} onPress={discardDraft} shrink={0.9}>
                  <Icon name="close" size={15} color={colors.textFaint} />
                </Press>
              </View>
            )}

            {mode === 'media' ? (
              <>
                {/* ---------- studio drop zone ---------- */}
                <Press style={styles.cvZone} onPress={() => setPickerOpen(true)} shrink={0.99}>
                  <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={16} style={FILL} />
                  <Glow color={colors.accent} size={300} strength={0.12} style={styles.cvZoneGlow} />
                  <CornerBrackets color="rgba(193,59,255,0.5)" size={22} inset={12} />

                  {hasMedia ? (
                    <View style={styles.cvZoneMedia}>
                      {firstIsVideo ? (
                        <VideoView player={player} style={styles.cvZoneVideo} contentFit="cover" />
                      ) : (
                        <CollageView
                          assets={assets}
                          collage={assets.length > 1 ? collage : 'single'}
                          style={styles.cvZoneVideo}
                        />
                      )}
                      <View style={styles.cvCountBadge}>
                        <Icon name="albums-outline" size={12} color={colors.bg} />
                        <Text style={styles.cvCountText}>{assets.length} of 6</Text>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.cvZoneEmpty}>
                      <View style={styles.cvAddRing}>
                        <Glow color={colors.accent} size={130} strength={0.24} style={styles.cvAddGlow} />
                        <View style={styles.cvAddBtn}>
                          <GradientFill from={colors.accent} to={colors.accentStrong} steps={10} style={FILL} />
                          <Icon name="add" size={30} color={colors.bg} />
                        </View>
                      </View>
                      <Text style={styles.cvZoneTitle}>Add your media</Text>
                      <Text style={styles.cvZoneHint}>Shoot it now, or pick up to 6 photos</Text>
                    </View>
                  )}
                </Press>

                {hasMedia && (
                  <>
                    {/* what you picked, at a glance — tap to manage */}
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.cvRail}
                    >
                      {assets.slice(0, 6).map((a, i) => (
                        <Pressable
                          key={`${a.uri}-${i}`}
                          style={styles.cvThumb}
                          onPress={() => setPickerOpen(true)}
                        >
                          {isVideoAsset(a) ? (
                            <View style={[styles.cvThumbInner, styles.cvThumbVideo]}>
                              <Icon name="videocam" size={18} color={colors.text} />
                            </View>
                          ) : (
                            <Image source={{ uri: a.uri }} style={styles.cvThumbInner} />
                          )}
                        </Pressable>
                      ))}
                      {assets.length < 6 && (
                        <Pressable
                          style={[styles.cvThumb, styles.cvThumbAdd]}
                          onPress={() => setPickerOpen(true)}
                        >
                          <Icon name="add" size={20} color={colors.accent} />
                        </Pressable>
                      )}
                    </ScrollView>

                    <View style={styles.cvStatusRow}>
                      <View style={styles.cvStatusPill}>
                        <Icon name="checkmark-circle" size={13} color={colors.success} />
                        <Text style={styles.cvStatusText}>
                          Ready · {assets.length} {assets.length === 1 ? 'item' : 'items'}
                          {imagesOnly && assets.length > 1 ? ` · ${collage}` : ''}
                        </Text>
                      </View>
                      {imagesOnly && assets.length > 1 && (
                        <Pressable
                          style={styles.cvMiniBtn}
                          onPress={() => setPhotoEditorOpen(true)}
                          hitSlop={6}
                        >
                          <Icon name="grid-outline" size={13} color={colors.accent} />
                          <Text style={styles.cvMiniBtnText}>Layout</Text>
                        </Pressable>
                      )}
                    </View>
                  </>
                )}

                {/* The passive "Photos / Video / Camera" chips that used to sit
                    inside the drop zone looked like actions and were not. The
                    camera is a real surface now, so it gets a real button, and
                    picking an existing file keeps its own. */}
                <Button
                  title="Open camera"
                  onPress={() => setCameraOpen(true)}
                  style={{ marginTop: 14 }}
                />
                <Button
                  variant="secondary"
                  title={hasMedia ? 'Change / add media' : 'Choose from gallery'}
                  onPress={() => setPickerOpen(true)}
                  style={{ marginTop: 10 }}
                />

                {hasMedia && (
                  <Button title="Continue → editor" onPress={goEditor} style={{ marginTop: 12 }} />
                )}
              </>
            ) : (
              <>
                {/* ---------- text composer ---------- */}
                <View style={[styles.cvTextCard, { backgroundColor: textColor }]}>
                  <GradientFill
                    from="#FFFFFF"
                    to="#FFFFFF"
                    steps={8}
                    alphaFrom={0.1}
                    alphaTo={0}
                    style={FILL}
                  />
                  <CornerBrackets color="rgba(255,255,255,0.32)" size={16} inset={9} />
                  <TextInput
                    ref={textInputRef}
                    style={[
                      styles.cvTextInput,
                      {
                        color:
                          textColor === '#0C1030' || textColor === '#1E2466'
                            ? colors.text
                            : colors.bg,
                      },
                    ]}
                    placeholder="Say something worth seeing..."
                    placeholderTextColor="rgba(255,255,255,0.45)"
                    multiline
                    maxLength={220}
                    value={content}
                    onChangeText={setContent}
                  />
                  <View style={styles.cvMeterRow}>
                    <View style={styles.cvMeterTrack}>
                      <View
                        style={[
                          styles.cvMeterFill,
                          { width: `${Math.min(100, (content.length / 220) * 100)}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.cvMeterText}>{content.length}/220</Text>
                  </View>
                </View>

                {/* colour */}
                <View style={styles.cvSwatchRow}>
                  {TEXT_DROP_COLORS.map((c) => {
                    const active = textColor === c;
                    return (
                      <Pressable key={c} onPress={() => setTextColor(c)} hitSlop={4}>
                        <View style={[styles.cvSwatchOuter, active && styles.cvSwatchOuterActive]}>
                          <View style={[styles.cvSwatch, { backgroundColor: c }]} />
                        </View>
                      </Pressable>
                    );
                  })}
                </View>

                {/* starters — insert only, nothing persisted */}
                <Text style={styles.cvSectionLabel}>START A THOUGHT</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.cvStarters}
                >
                  {TEXT_STARTERS.map((s) => (
                    <Pressable
                      key={s}
                      style={styles.cvStarter}
                      onPress={() => {
                        setContent((c) => (c.trim().length > 0 ? `${c}${s}` : s));
                        textInputRef.current?.focus();
                      }}
                    >
                      <Text style={styles.cvStarterText}>{s.trim()}</Text>
                    </Pressable>
                  ))}
                </ScrollView>

                {content.trim().length > 0 && (
                  <Button title="Continue → preview" onPress={goPreview} style={{ marginTop: 12 }} />
                )}
              </>
            )}

            {!!error && <Text style={styles.error}>{error}</Text>}
            <View style={styles.footer48Row}>
              <Icon name="hourglass-outline" size={12} color={colors.accent} />
              <Text style={styles.footer48}>{vanishLabel(DROP_LIFETIME_MS)}</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {step === 'editor' && (
        <View style={styles.flex}>
          <View style={styles.editorTop}>
            {/* Back, not close. This used to be a ✕ that jumped to the hub,
                so there was no way to return to the media step and swap the
                clip — the same dead end the preview had. */}
            <Pressable
              onPress={stepBack}
              hitSlop={10}
              style={styles.editorTopBtn}
              accessibilityLabel="Back to media"
            >
              <Icon name="chevron-back" size={20} color={colors.text} />
            </Pressable>
            <View style={styles.editorCenter}>
              <Text style={styles.editorTitle}>Edit drop</Text>
              {draftChip}
            </View>
            <Pressable onPress={goPreview} hitSlop={8} style={styles.editorTopBtn}>
              <Text style={styles.nextText}>NEXT →</Text>
            </Pressable>
          </View>

          <View style={[ratioOf ? [styles.canvas, { aspectRatio: ratioOf }] : [styles.canvas, styles.canvasFlex]]}>
            <View style={[StyleSheet.absoluteFill, rotation !== 0 ? { transform: [{ rotate: `${rotation}deg` }] } : null]}>
              {firstIsVideo ? (
                <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : (
                <CollageView assets={assets} collage={assets.length > 1 ? collage : 'single'} style={StyleSheet.absoluteFill} />
              )}
              {/* effect + filter tints */}
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: EFFECTS.find((e) => e.id === effect)?.tint ?? 'transparent' }]} />
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, getFilterTint(filter) ? { backgroundColor: getFilterTint(filter)! } : null]} />
            </View>
            {/* text layers */}
            {textLayers.map((l) => (
              <Draggable key={l.id} x={l.x} y={l.y} onMove={(x, y) => moveLayer(l.id, x, y)}>
                <View style={styles.layerWrap}>
                  <Text style={{ color: l.color, fontSize: l.size, fontWeight: l.bold ? '800' : '400' }}>{l.text}</Text>
                  <Pressable style={styles.layerX} onPress={() => setTextLayers((t) => t.filter((x) => x.id !== l.id))} hitSlop={6}>
                    <Text style={styles.layerXText}>✕</Text>
                  </Pressable>
                </View>
              </Draggable>
            ))}
            {/* stickers */}
            {stickers.map((s) => (
              <Draggable key={s.id} x={s.x} y={s.y} onMove={(x, y) => moveSticker(s.id, x, y)}>
                <View style={styles.layerWrap}>
                  <Text style={{ fontSize: s.size }}>{s.emoji}</Text>
                  <Pressable style={styles.layerX} onPress={() => setStickers((t) => t.filter((x) => x.id !== s.id))} hitSlop={6}>
                    <Text style={styles.layerXText}>✕</Text>
                  </Pressable>
                </View>
              </Draggable>
            ))}
            {trimActive && (
              <View pointerEvents="none" style={styles.trimBadge}>
                <Icon name="cut-outline" size={12} color={colors.accent} />
                <Text style={styles.trimBadgeText}>{fmtTime(trimStart)} – {fmtTime(trimEnd)}</Text>
              </View>
            )}
            {sound && (
              <View pointerEvents="none" style={styles.soundBadge}>
                <Icon name="musical-note" size={11} color={colors.cyan} />
                <Text style={styles.soundBadgeText}>{sound.name}</Text>
              </View>
            )}
          </View>

          {/* toolbar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolbar} contentContainerStyle={styles.toolbarRow}>
            {TOOLS.map((t) => (
              <Pressable
                key={t.id}
                style={[styles.toolBtn, overlay === t.id && styles.toolBtnActive]}
                onPress={() => {
                  setOverlay(overlay === t.id ? null : t.id);
                  if (t.id === 'trim') setTrimActive(true);
                }}
              >
                <Icon name={t.icon as IconName} size={18} color={t.color} />
                <Text style={[styles.toolLabel, overlay === t.id && styles.toolLabelActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* active tool panel */}
          <View style={styles.panel}>
            {overlay === 'trim' && (
              <View style={styles.panelRow}>
                <View style={styles.trimCol}>
                  <Text style={styles.panelLabel}>Start</Text>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => setTrimStart(Math.max(0, trimStart - 1))}><Text style={styles.stepText}>−1s</Text></Pressable>
                    <Text style={styles.stepVal}>{fmtTime(trimStart)}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => setTrimStart(Math.min(trimEnd - 1, trimStart + 1))}><Text style={styles.stepText}>+1s</Text></Pressable>
                  </View>
                </View>
                <View style={styles.trimCol}>
                  <Text style={styles.panelLabel}>End</Text>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => setTrimEnd(Math.max(trimStart + 1, trimEnd - 1))}><Text style={styles.stepText}>−1s</Text></Pressable>
                    <Text style={styles.stepVal}>{fmtTime(trimEnd)}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => setTrimEnd(trimEnd + 1)}><Text style={styles.stepText}>+1s</Text></Pressable>
                  </View>
                </View>
                <Pressable style={styles.resetBtn} onPress={() => setTrimActive(false)}>
                  <Text style={styles.resetText}>✕ Off</Text>
                </Pressable>
              </View>
            )}
            {overlay === 'sound' && (
              <View style={styles.panelRow}>
                {sound ? (
                  <>
                    <View style={styles.soundInfo}>
                      <View style={styles.statRow}>
                        <Icon name="musical-note" size={13} color={colors.cyan} />
                        <Text style={styles.panelVal} numberOfLines={1}>
                          {sound.name} · {sound.artist ?? 'GEN Z'}
                        </Text>
                      </View>
                      {typeof sound.start === 'number' && typeof sound.end === 'number' && (
                        <Text style={styles.soundTrim}>
                          Plays {fmtTime(sound.start)} – {fmtTime(sound.end)}
                        </Text>
                      )}
                    </View>
                    <Pressable
                      style={styles.soundAction}
                      onPress={() => {
                        // Opening the sheet is the whole point: setTrimSound only
                        // seeds SoundPickerModal's `initial`, and that modal is
                        // gated on soundOpen. Without this line the button set a
                        // value nothing rendered and the sheet stayed shut, so
                        // Trim was silently a no-op — the reported "I can't trim
                        // the sound from the place I want it to play".
                        setTrimSound(sound);
                        setSoundOpen(true);
                      }}
                    >
                      <Icon name="cut-outline" size={13} color={colors.accent} />
                      <Text style={styles.soundActionText}>Trim</Text>
                    </Pressable>
                    <Pressable style={styles.resetBtn} onPress={() => setSound(null)}><Text style={styles.resetText}>✕ Remove</Text></Pressable>
                  </>
                ) : (
                  <Button variant="secondary" title="Browse sounds" onPress={() => setSoundOpen(true)} />
                )}
              </View>
            )}
            {overlay === 'effects' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {EFFECTS.map((e) => (
                  <Pressable key={e.id} style={[styles.chip, effect === e.id && styles.chipActive]} onPress={() => setEffect(e.id)}>
                    <Text style={[styles.chipText, effect === e.id && styles.chipTextActive]}>{e.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {overlay === 'text' && (
              <View style={styles.panelRow}>
                <Button variant="secondary" title="Aa Add text" onPress={() => setTextLayerOpen(true)} />
              </View>
            )}
            {overlay === 'stickers' && (
              <View style={styles.panelRow}>
                <Button variant="secondary" title="Add sticker" onPress={() => setStickerOpen(true)} />
              </View>
            )}
            {overlay === 'filters' && <FilterCarousel value={filter} onChange={setFilter} />}
            {overlay === 'cover' && (
              <View style={styles.panelColumn}>
                <Text style={styles.panelHint}>
                  {coverAuto
                    ? 'We picked this frame for you — the clearest, most representative one in the clip. Change it if you want to.'
                    : 'This still is what shows on your profile grid and everywhere the Drop is listed.'}
                </Text>

                {coverUri ? (
                  <View style={styles.coverPreviewRow}>
                    <View style={styles.coverThumbWrap}>
                      <Image source={{ uri: coverUri }} style={styles.coverPreview} />
                      {coverAuto && (
                        <View style={styles.coverAutoTag}>
                          <Text style={styles.coverAutoTagText}>AUTO</Text>
                        </View>
                      )}
                    </View>
                    <Pressable
                      onPress={async () => {
                        // Another automatic frame, never an empty slot: a video
                        // with no cover renders as a broken tile in every grid
                        // it appears in, so there is no "none" to go back to.
                        const better = await autoPickCover();
                        if (better) {
                          setCoverUri(better);
                          setCoverAuto(true);
                        }
                      }}
                      hitSlop={8}
                      disabled={coverBusy}
                    >
                      <Text style={styles.coverRemove}>
                        {coverBusy ? 'Looking…' : '↻ Try another frame'}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {/* Always available, cover or no cover: the point is that
                    choosing one is optional, so "change it" has to be exactly
                    as easy to reach as "pick it" was. */}
                <View style={styles.panelRow}>
                  <Button
                    variant="secondary"
                    title="📁 Pick from gallery"
                    disabled={coverBusy}
                    onPress={async () => {
                      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                      if (!perm.granted) return;
                      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
                      if (res.canceled || !res.assets[0]) return;
                      setCoverUri(res.assets[0].uri);
                      // A deliberate choice outranks ours from here on.
                      setCoverAuto(false);
                    }}
                  />
                  <Button
                    variant="secondary"
                    title={coverBusy ? 'Choosing…' : coverUri ? '↻ Best frame' : 'Auto (best frame)'}
                    disabled={coverBusy}
                    onPress={async () => {
                      const better = await autoPickCover();
                      if (better) {
                        setCoverUri(better);
                        setCoverAuto(true);
                      }
                    }}
                  />
                </View>

                {!coverUri && !coverBusy && (
                  <Text style={styles.panelHint}>
                    Nothing chosen yet — we pick the best frame for you either way, so you cannot end
                    up without one.
                  </Text>
                )}
              </View>
            )}
            {overlay === 'voiceover' && (
              <VoiceoverRecorder url={voiceoverUrl} durationMs={voiceoverMs} onRecorded={(u, ms) => { setVoiceoverUrl(u); setVoiceoverMs(ms); }} onRemove={() => { setVoiceoverUrl(null); setVoiceoverMs(0); }} />
            )}
            {overlay === 'speed' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {SPEEDS.map((s) => (
                  <Pressable key={s} style={[styles.chip, speed === s && styles.chipActive]} onPress={() => { setSpeed(s); if (player) player.playbackRate = s; }}>
                    <Text style={[styles.chipText, speed === s && styles.chipTextActive]}>{s}x</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {overlay === 'crop' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {RATIOS.map((r) => (
                  <Pressable key={r.id} style={[styles.chip, ratio === r.id && styles.chipActive]} onPress={() => setRatio(r.id)}>
                    <Text style={[styles.chipText, ratio === r.id && styles.chipTextActive]}>{r.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {overlay === 'rotate' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {[0, 90, 180, 270].map((r) => (
                  <Pressable key={r} style={[styles.chip, rotation === r && styles.chipActive]} onPress={() => setRotation(r)}>
                    <Text style={[styles.chipText, rotation === r && styles.chipTextActive]}>{r === 0 ? '0°' : `${r}°`}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* preview
          behavior must be 'padding' on Android too: with `undefined` RN's
          KeyboardAvoidingView hits its `default:` branch and renders a plain
          View that does nothing, which left the caption input behind the
          keyboard. 'padding' is self-correcting — it pads only by the measured
          overlap, so a resizing window would add nothing. */}
      {step === 'preview' && (
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
          <ScrollView contentContainerStyle={styles.previewContent} keyboardShouldPersistTaps="handled">
            {/* ---------- top bar ---------- */}
            <View style={styles.pvTop}>
              {/* Back to the editor — the reported dead end. Being on the
                  caption step is not the same as being finished with the post,
                  and there was no way to return to sound, trim or filters. */}
              <Pressable
                onPress={stepBack}
                hitSlop={10}
                style={styles.pvClose}
                accessibilityLabel="Back to editor"
              >
                <Icon name="chevron-back" size={18} color={colors.text} />
              </Pressable>
              <Text style={styles.pvTitle}>Preview</Text>
              <View style={styles.pvTopRight}>
                <View style={styles.pvBadge}>
                  <Icon name="hourglass-outline" size={11} color={colors.accent} />
                  <Text style={styles.pvBadgeText}>7D</Text>
                </View>
                <Pressable
                  onPress={leaveDrafting}
                  hitSlop={10}
                  style={styles.pvClose}
                  accessibilityLabel="Close and keep the draft"
                >
                  <Icon name="close" size={15} color={colors.text} />
                </Pressable>
              </View>
            </View>
            <Text style={styles.pvHint}>This is exactly how it lands in the feed.</Text>
            {!!draftChip && <View style={styles.draftChipRow}>{draftChip}</View>}

            {/* ---------- live post preview ---------- */}
            <View style={styles.pvCard}>
              <GradientFill from={colors.gradFrom} to={colors.gradTo} steps={14} style={FILL} />
              <CornerBrackets color="rgba(193,59,255,0.35)" size={18} inset={10} />

              <View style={styles.pvHead}>
                <Avatar
                  url={me?.avatar_url ?? null}
                  name={me?.username ?? 'you'}
                  size={34}
                  ring
                  verified={!!me?.verified}
                />
                <View style={styles.pvWho}>
                  <View style={styles.pvNameRow}>
                    <Text style={styles.pvName} numberOfLines={1}>
                      @{me?.username ?? 'you'}
                    </Text>
                    {!!me?.verified && <VerifiedBadge size={12} glow={false} />}
                  </View>
                  <Text style={styles.pvMeta} numberOfLines={1}>
                    {location.trim() ? location.trim() : 'just now'} · 7d
                  </Text>
                </View>
              </View>

              <View style={styles.pvMediaWrap}>
                {mode === 'text' ? (
                  <View style={[styles.pvTextCard, { backgroundColor: textColor }]}>
                    <Text
                      style={[
                        styles.pvTextBody,
                        {
                          color:
                            textColor === '#0C1030' || textColor === '#1E2466'
                              ? colors.text
                              : colors.bg,
                        },
                      ]}
                      numberOfLines={7}
                    >
                      {content.trim() || 'Your text drop'}
                    </Text>
                  </View>
                ) : firstIsVideo ? (
                  <VideoView player={player} style={styles.pvMedia} contentFit="cover" />
                ) : hasMedia ? (
                  <CollageView
                    assets={assets}
                    collage={assets.length > 1 ? collage : 'single'}
                    style={styles.pvMedia}
                  />
                ) : (
                  <View style={styles.pvMediaEmpty}>
                    <Icon name="image-outline" size={22} color={colors.textFaint} />
                    <Text style={styles.pvMediaEmptyText}>Nothing picked yet</Text>
                  </View>
                )}
              </View>

              {caption.trim().length > 0 && (
                <Text style={styles.pvCaptionText} numberOfLines={4}>
                  {caption.trim()}
                </Text>
              )}

              <View style={styles.pvActions}>
                <View style={styles.pvAction}>
                  <Icon name="heart-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.pvActionText}>0</Text>
                </View>
                <View style={styles.pvAction}>
                  <Icon name="chatbubble-outline" size={15} color={colors.textMuted} />
                  <Text style={styles.pvActionText}>0</Text>
                </View>
                <View style={styles.pvAction}>
                  <Icon name="repeat-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.pvActionText}>0</Text>
                </View>
                <View style={styles.pvExpiry}>
                  <Icon name="hourglass-outline" size={11} color={colors.accent} />
                  <Text style={styles.pvExpiryText}>Gone in 7 days</Text>
                </View>
              </View>
            </View>

            {/* ---------- sound ----------
                The other half of the reported dead end. The example the user
                gave was "I forgot to put a sound", and the only way to fix it
                used to be walking all the way back. Now it is one tap from
                here, in the step where you notice the problem. */}
            {mode === 'media' && (
              <Press
                containerStyle={styles.pvSoundRow}
                onPress={() => setSoundOpen(true)}
                shrink={0.99}
              >
                <View style={styles.pvSoundIcon}>
                  <Icon name="musical-notes" size={15} color={colors.accent} />
                </View>
                <View style={styles.pvSoundBody}>
                  <Text style={styles.pvSoundTitle} numberOfLines={1}>
                    {sound?.name ?? 'Add a sound'}
                  </Text>
                  <Text style={styles.pvSoundSub} numberOfLines={1}>
                    {sound?.name
                      ? sound.artist || 'Your chosen track'
                      : 'Nothing chosen — the video keeps its own audio'}
                  </Text>
                </View>
                <Text style={styles.pvSoundCta}>{sound ? 'Change' : 'Add'}</Text>
              </Press>
            )}

            {/* ---------- caption ---------- */}
            <Text style={styles.pvSection}>Caption</Text>
            <TextInput
              style={styles.input}
              placeholder={mode === 'media' ? 'Write a caption... #hashtags @mentions' : 'Add a caption (optional)...'}
              placeholderTextColor={colors.textFaint}
              multiline
              value={caption}
              onChangeText={setCaption}
            />

            {/* Live count + suggestions for the hashtag being typed. The count is
                the honest one — hashtag_count() counts live posts, so "0" really
                means nobody, which is what makes "you'd be the first" true. */}
            {!!activeTagToken && tagExactCount !== null && (
              <View style={styles.acWrap}>
                <View style={styles.acCountRow}>
                  <Icon name="pricetag" size={12} color={colors.accent} />
                  <Text style={styles.acCountText}>
                    {tagExactCount === undefined
                      ? `Checking #${activeTagToken}…`
                      : tagExactCount === 0
                      ? `No live posts use #${activeTagToken} yet — you'd be the first`
                      : `${tagExactCount} live post${tagExactCount === 1 ? '' : 's'} use #${activeTagToken}`}
                  </Text>
                </View>

                {tagSuggestions.length > 0 && (
                  <View style={styles.acList}>
                    {tagSuggestions.map((s) => (
                      <Pressable
                        key={s.tag}
                        style={styles.acRow}
                        onPress={() => completeTag(s.tag)}
                      >
                        <Text style={styles.acMain} numberOfLines={1}>#{s.tag}</Text>
                        <Text style={styles.acCount}>
                          {s.post_count} post{s.post_count === 1 ? '' : 's'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Real suggestions: the live Drop prompt, plus tags the community
                has actually been posting (auto-indexed by sync_hashtags). */}
            {(!!liveDrop || tagIdeas.length > 0) && (
              <View style={styles.ideaWrap}>
                <View style={styles.statRow}>
                  <Icon name="bulb-outline" size={13} color={colors.accent} />
                  <Text style={styles.ideaLabel}>
                    {liveDrop ? 'Ideas for this drop' : 'Tags people are using'}
                  </Text>
                </View>

                {liveDrop && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.ideaChips}
                  >
                    <Pressable
                      style={styles.ideaChip}
                      onPress={() => addIdeaToCaption(liveDrop.prompt)}
                    >
                      <Text style={styles.ideaChipText} numberOfLines={1}>
                        {liveDrop.prompt}
                      </Text>
                    </Pressable>
                  </ScrollView>
                )}

                {tagIdeas.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.ideaChips}
                  >
                    {tagIdeas.map((t) => {
                      const on = caption.includes(`#${t.tag}`);
                      return (
                        <Pressable
                          key={t.tag}
                          style={[styles.tagChip, on && styles.tagChipOn]}
                          onPress={() => addTagToCaption(t.tag)}
                        >
                          <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>
                            #{t.tag}
                          </Text>
                          <Text style={styles.tagChipCount}>{t.count}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
            )}

            {/* ---------- location ---------- */}
            <View style={styles.locWrap}>
              <View style={styles.locRow}>
                <TextInput
                  style={[styles.input, styles.locInput]}
                  placeholder="Add location (optional)"
                  placeholderTextColor={colors.textFaint}
                  value={location}
                  onChangeText={(t) => {
                    setLocation(t);
                    setLocNotice(null);
                  }}
                />
                <Pressable
                  style={styles.locGpsBtn}
                  onPress={useMyLocation}
                  disabled={locBusy}
                  hitSlop={6}
                  accessibilityLabel="Use my current location"
                >
                  {locBusy ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Icon name="navigate-outline" size={17} color={colors.accent} />
                  )}
                </Pressable>
              </View>

              {/* Availability: how many live posts are already here. */}
              {!!location.trim() && locExactCount !== null && (
                <Text style={styles.locStatus}>
                  {locExactCount === undefined
                    ? 'Checking this location…'
                    : locExactCount === 0
                    ? 'Nothing posted from here yet — you would be the first'
                    : `${locExactCount} live post${locExactCount === 1 ? '' : 's'} from here`}
                </Text>
              )}

              {locSuggestions.length > 0 && (
                <View style={styles.acList}>
                  {locSuggestions.map((s) => (
                    <Pressable
                      key={s.location}
                      style={styles.acRow}
                      onPress={() => {
                        // Store the spelling most posts already use, so picking a
                        // suggestion normalises the data instead of adding a variant.
                        setLocation(s.location);
                        setLocNotice(null);
                      }}
                    >
                      <Text style={styles.acMain} numberOfLines={1}>{s.location}</Text>
                      <Text style={styles.acCount}>
                        {s.post_count} post{s.post_count === 1 ? '' : 's'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {!!locNotice && <Text style={styles.locNotice}>{locNotice}</Text>}
            </View>

            {/* mentions */}
            <View style={styles.mentionWrap}>
              {mentions.length > 0 && (
                <View style={styles.mentionChips}>
                  {mentions.map((m) => (
                    <Pressable key={m} style={styles.mentionChip} onPress={() => setMentions((x) => x.filter((y) => y !== m))}>
                      <Text style={styles.mentionChipText}>@{m} ✕</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <TextInput
                style={styles.input}
                placeholder="Mention people (type @username)"
                placeholderTextColor={colors.textFaint}
                value={mentionQuery}
                onChangeText={(q) => {
                  setMentionQuery(q);
                  if (q.trim() && !q.includes(' ')) {
                    const name = q.trim().replace('@', '');
                    if (name.length >= 2) {
                      const hit = mentionResults.find((r) => r.username === name);
                      if (hit && !mentions.includes(hit.username)) {
                        setMentions((x) => [...x, hit.username]);
                        setMentionQuery('');
                        setMentionResults([]);
                      }
                    }
                  }
                }}
              />
              {mentionResults.length > 0 && (
                <View style={styles.mentionResults}>
                  {mentionResults.map((r) => (
                    <Pressable
                      key={r.id}
                      style={styles.mentionResult}
                      onPress={() => {
                        if (!mentions.includes(r.username)) setMentions((x) => [...x, r.username]);
                        setMentionQuery('');
                        setMentionResults([]);
                      }}
                    >
                      <Text style={styles.mentionResultText}>@{r.username}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {liveDrop && (
              <Pressable style={[styles.dropToggle, postToDrop && styles.dropToggleOn]} onPress={() => setPostToDrop((v) => !v)}>
                <View style={styles.statRow}>
                  <Icon name="cube-outline" size={15} color={colors.accent} />
                  <Text style={styles.dropToggleTitle}>{postToDrop ? 'Posting to the LIVE drop' : 'Post to the live drop'}</Text>
                </View>
                <Text style={styles.dropTogglePrompt} numberOfLines={2}>“{liveDrop.prompt}”</Text>
              </Pressable>
            )}

            {/* privacy */}
            <Text style={styles.pvSection}>Who can see this</Text>
            <ChoiceRow
              options={[
                { id: 'everyone' as Visibility, label: 'Everyone', icon: 'globe-outline' },
                { id: 'followers' as Visibility, label: 'Followers', icon: 'people-outline' },
                { id: 'only_me' as Visibility, label: 'Only me', icon: 'lock-closed-outline' },
              ]}
              value={visibility}
              onChange={setVisibility}
            />

            {/* interactions */}
            <Text style={[styles.pvSection, { marginTop: 24 }]}>Interaction settings</Text>
            <ToggleRow label="Likes" value={allowLikes} onChange={setAllowLikes} />
            <ToggleRow label="Comments" value={allowComments} onChange={setAllowComments} />
            <ToggleRow label="Shares" value={allowShares} onChange={setAllowShares} />
            <ToggleRow label="Reposts" value={allowReposts} onChange={setAllowReposts} />
            <ToggleRow label="Downloads" value={allowDownloads} onChange={setAllowDownloads} />
            <ToggleRow label="Mentions" value={allowMentions} onChange={setAllowMentions} />

            {/* 7-day confirmation */}
            <View style={styles.fortyEight}>
              <Icon name="hourglass-outline" size={26} color={colors.accent} />
              <View style={styles.fortyEightBody}>
                <Text style={styles.fortyEightTitle}>This Drop disappears in 7 days</Text>
                <Text style={styles.fortyEightSub}>
                  It goes live the moment you tap DROP IT. No edits, no resets — after 7 days it's gone forever.
                </Text>
              </View>
            </View>

            {!!error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.pvDrop, uploading && styles.pvDropDisabled]}
              onPress={publish}
              disabled={uploading}
            >
              <GradientFill from={colors.accent} to={colors.accentStrong} steps={12} horizontal style={FILL} />
              {uploading ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <View style={styles.statRow}>
                  <Icon name="flame" size={20} color={colors.bg} />
                  <Text style={styles.pvDropText}>DROP IT</Text>
                </View>
              )}
            </Pressable>
            <Text style={styles.footer48}>{vanishLabel(DROP_LIFETIME_MS)} · make it count.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* The "DROP LIVE" celebration that used to render here is gone with the
          'live' step. Posting is handed to uploadManager and this wizard closes
          immediately, so there is no waiting screen left to celebrate on — the
          user is already back on the feed when the drop goes live. */}

      {/* modals & sheets */}
      <MediaPickerSheet
        visible={pickerOpen}
        assets={assets}
        onClose={() => setPickerOpen(false)}
        onPicked={(a) => setAssets(a)}
      />
      {/* The chosen sound, playing over the video you are editing — the same
          component the feed uses, so the window and the loop behave identically
          before and after publishing. Renders nothing. */}
      <SoundTrack
        url={sound?.url ?? null}
        start={sound?.start ?? 0}
        end={sound?.end ?? null}
        active={!!sound?.url && videoPlaying}
      />

      {/* The camera. Rendered at the root of the wizard, not inside a step, so
          it survives the step changes that a capture triggers. */}
      <CaptureScreen
        visible={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCaptured={handleCaptured}
        onAddSound={() => {
          // The sound sheet is a sibling Modal; Android stacks them by render
          // order, so the camera has to step aside rather than fight it.
          setCameraOpen(false);
          setSoundOpen(true);
        }}
        soundName={sound?.name ?? null}
        onOpenGallery={() => {
          setCameraOpen(false);
          setPickerOpen(true);
        }}
        onTextMode={() => {
          setCameraOpen(false);
          setMode('text');
          setStep('create');
        }}
      />

      <SoundPickerModal
        visible={soundOpen}
        onClose={() => setSoundOpen(false)}
        initial={
          trimSound
            ? {
                id: trimSound.id,
                name: trimSound.name,
                artist: trimSound.artist,
                url: trimSound.url ?? null,
                start: trimSound.start ?? 0,
                end: trimSound.end ?? 30,
              }
            : null
        }
        onSelect={(s) => {
          setSound({
            id: s.id,
            name: s.name,
            artist: s.artist,
            category: 'music',
            usage_count: 0,
            url: s.url,
            start: s.start,
            end: s.end,
          });
          setTrimSound(null);
          setSoundOpen(false);
        }}
      />
      <TextLayerEditor
        visible={textLayerOpen}
        onClose={() => setTextLayerOpen(false)}
        onAdd={(layer) => setTextLayers((t) => [...t, layer])}
      />
      <StickerPicker visible={stickerOpen} onClose={() => setStickerOpen(false)} onPick={addSticker} />
      <PhotoEditorModal visible={photoEditorOpen} images={assets.filter((a) => !(a.mimeType?.startsWith('video') ?? false))} value={collage} onChange={setCollage} onClose={() => setPhotoEditorOpen(false)} />

      {/* hidden video frame for auto cover capture */}
      {coverSource && (
        <View
          ref={coverCaptureRef}
          collapsable={false}
          style={styles.coverCapture}
          pointerEvents="none"
        >
          <VideoView player={capturePlayer} style={styles.coverCaptureVideo} surfaceType="textureView" />
        </View>
      )}

      {/* The "Save as draft?" dialog that used to live here is gone with the
          manual save it belongs to. Work is saved as it happens, and every way
          out of a step — the ‹ in the editor and preview, the ✕ on the preview,
          the hardware back button — flushes before it moves. A dialog asking
          whether to keep work would now be asking about something already
          done, and its Discard button was the only way to lose a draft, which
          the hub banner does better. */}
    </View>
  );

  // helpers used inside JSX above
  function moveLayer(id: string, x: number, y: number) {
    setTextLayers((t) => t.map((l) => (l.id === id ? { ...l, x, y } : l)));
  }
  function moveSticker(id: string, x: number, y: number) {
    setStickers((t) => t.map((s) => (s.id === id ? { ...s, x, y } : s)));
  }
}

// ------------------------------------------------------------
// CollageView — renders N images in the chosen layout
// ------------------------------------------------------------
function CollageView({
  assets,
  collage,
  style,
}: {
  assets: ImagePicker.ImagePickerAsset[];
  collage: string;
  style?: any;
}) {
  if (assets.length === 0) return null;
  const imgs = assets.filter((a) => !(a.mimeType?.startsWith('video') ?? false));
  const pics = imgs.length > 0 ? imgs : assets;
  const n = pics.length;

  if (collage === 'duo' && n >= 2) {
    return (
      <View style={[styles.collage, style]}>
        <Image source={{ uri: pics[0].uri }} style={styles.collageHalf} resizeMode="cover" />
        <Image source={{ uri: pics[1].uri }} style={styles.collageHalf} resizeMode="cover" />
      </View>
    );
  }
  if (collage === 'trio' && n >= 3) {
    return (
      <View style={[styles.collage, style]}>
        <Image source={{ uri: pics[0].uri }} style={styles.collageTrioBig} resizeMode="cover" />
        <View style={styles.collageTrioCol}>
          <Image source={{ uri: pics[1].uri }} style={styles.collageTrioSmall} resizeMode="cover" />
          <Image source={{ uri: pics[2].uri }} style={styles.collageTrioSmall} resizeMode="cover" />
        </View>
      </View>
    );
  }
  if (collage === 'grid' && n >= 4) {
    return (
      <View style={[styles.collage, style, styles.collageGrid]}>
        {pics.slice(0, 6).map((p, i) => (
          <Image key={i} source={{ uri: p.uri }} style={styles.collageGridCell} resizeMode="cover" />
        ))}
      </View>
    );
  }
  return (
    <View style={[styles.collage, style]}>
      <Image source={{ uri: pics[0].uri }} style={styles.collageSingle} resizeMode="cover" />
    </View>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.toggleTrack, value && styles.toggleTrackOn]}>
        <View style={[styles.toggleThumb, value && styles.toggleThumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  // the auto-save status chip — inline in each step's header rather than
  // floating, because every edge of this screen already has a control on it
  draftChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 3,
  },
  draftChipRow: { flexDirection: 'row', marginTop: 8, marginBottom: 2 },
  draftChipText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700' },
  editorCenter: { alignItems: 'center' },
  flex: { flex: 1 },
  createContent: { padding: 20, paddingTop: TOP_INSET + 14, paddingBottom: 40 },

  // ---- create studio (redesigned) ----
  cvTopBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cvLivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.35)',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  cvLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  cvLiveText: { color: colors.accent, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.4 },
  cvHeadline: {
    color: colors.text,
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.5,
    lineHeight: 31,
    marginTop: 10,
  },
  cvSub: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 5 },

  // segmented control
  cvSeg: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginTop: 16,
    marginBottom: 4,
  },
  cvSegPill: {
    position: 'absolute',
    top: 4,
    left: 4,
    bottom: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  cvSegItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  cvSegText: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  cvSegTextActive: { color: colors.bg },

  // drop zone
  cvZone: {
    width: '100%',
    minHeight: 330,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.22)',
    backgroundColor: colors.surface,
    overflow: 'hidden',
    justifyContent: 'center',
    marginTop: 14,
    shadowColor: colors.accent,
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  cvZoneGlow: { position: 'absolute', top: -70, left: -60 },
  cvZoneEmpty: { alignItems: 'center', paddingVertical: 34, paddingHorizontal: 20 },
  cvZoneMedia: { flex: 1, width: '100%' },
  cvZoneVideo: { width: '100%', height: 330 },
  cvAddRing: { alignItems: 'center', justifyContent: 'center' },
  cvAddGlow: { position: 'absolute' },
  cvAddBtn: {
    width: 68,
    height: 68,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: colors.accentStrong,
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  cvZoneTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 18 },
  cvZoneHint: { color: colors.textMuted, fontSize: 12.5, marginTop: 5 },
  cvCountBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    ...shadows.glow,
  },
  cvCountText: { color: colors.bg, fontSize: 11, fontWeight: '800' },

  // selection rail
  cvRail: { gap: 9, paddingTop: 14, paddingRight: 6 },
  cvThumb: {
    width: 62,
    height: 62,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cvThumbInner: { width: '100%', height: '100%' },
  cvThumbVideo: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  cvThumbAdd: {
    alignItems: 'center',
    justifyContent: 'center',
    borderStyle: 'dashed',
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },

  // readiness
  cvStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 10,
  },
  cvStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    backgroundColor: 'rgba(52,211,153,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.35)',
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  cvStatusText: { color: colors.text, fontSize: 11.5, fontWeight: '700' },
  cvMiniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  cvMiniBtnText: { color: colors.accent, fontSize: 11.5, fontWeight: '800' },

  // text composer
  cvTextCard: {
    borderRadius: radius.xl,
    minHeight: 250,
    padding: 20,
    marginTop: 14,
    overflow: 'hidden',
    justifyContent: 'space-between',
    ...shadows.md,
  },
  cvTextInput: {
    fontSize: 25,
    fontWeight: '800',
    minHeight: 150,
    textAlignVertical: 'top',
    letterSpacing: -0.3,
  },
  cvMeterRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 10 },
  cvMeterTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  cvMeterFill: { height: '100%', borderRadius: 2, backgroundColor: colors.accent },
  cvMeterText: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700' },
  cvSwatchRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 16 },
  cvSwatchOuter: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cvSwatchOuterActive: {
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  cvSwatch: { width: 32, height: 32, borderRadius: 16 },
  cvSectionLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginTop: 22,
    marginBottom: 2,
  },
  cvStarters: { gap: 8, paddingVertical: 10, paddingRight: 6 },
  cvStarter: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  cvStarterText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  panelColumn: {
    gap: 10,
    paddingVertical: 4,
  },
  panelHint: {
    color: colors.textMuted,
    fontSize: 11.5,
    lineHeight: 16,
  },
  coverPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  coverPreview: {
    width: 72,
    height: 100,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  // the thumbnail and its AUTO tag share one box, so the tag sits on the corner
  // of the frame rather than beside it
  coverThumbWrap: { position: 'relative' },
  coverAutoTag: {
    position: 'absolute',
    left: 5,
    bottom: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(7,6,26,0.78)',
  },
  coverAutoTagText: { color: colors.accent, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.8 },
  coverRemove: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  coverCapture: {
    position: 'absolute',
    left: -2000,
    top: 0,
    width: 270,
    height: 480,
    backgroundColor: '#000',
  },
  coverCaptureVideo: {
    width: '100%',
    height: '100%',
  },
  replyBanner: {
    backgroundColor: 'rgba(139,123,255,0.14)',
    borderWidth: 1,
    borderColor: colors.violet,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 12,
  },
  replyBannerText: {
    color: colors.violet,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  draftBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
    marginBottom: 4,
  },
  draftThumb: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceInput,
  },
  draftThumbPh: { alignItems: 'center', justifyContent: 'center' },
  draftBannerBody: { flex: 1 },
  draftBannerTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  draftBannerText: { color: colors.textMuted, fontSize: 11.5 },
  draftBannerResume: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  draftBannerCta: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  draftBannerX: { padding: 4 },
  textDropCardSm: { borderRadius: radius.lg, padding: 18, minHeight: 130, ...shadows.md },
  textDropBody: { fontSize: 20, fontWeight: '800' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  footer48Row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  footer48: { color: colors.textFaint, fontSize: 12, textAlign: 'center', fontWeight: '600' },
  // ---- create hub (redesigned) ----
  // paddingTop uses the real status-bar height; the previous hub had none, so
  // its header rendered underneath the status bar
  hubContent: { padding: 18, paddingTop: TOP_INSET + 14, paddingBottom: 36 },
  hubBack: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 4 },
  hubBackText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },

  // header — mark + wordmark, then a two-line greeting
  hbHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 15 },
  hbMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  hbMarkImg: { width: 30, height: 30 },
  hbWordmark: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 2.4 },
  hbTitle: {
    color: colors.text,
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: -0.6,
    lineHeight: 33,
  },
  hbTitleAccent: { color: colors.accent },
  hbSub: { color: colors.textMuted, fontSize: 13.5, marginTop: 5, lineHeight: 19 },
  hbAmbient: { position: 'absolute', top: -52, right: -72 },

  // hero — navy depth, a warm bloom entering from the right, and the only
  // saturated orange surface on the screen (the round + button)
  hbHeroWrap: { marginTop: 20 },
  hbHero: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.22)',
    backgroundColor: colors.surface,
    padding: 18,
    overflow: 'hidden',
    shadowColor: colors.accent,
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  hbHeroGlow: { position: 'absolute', right: -46, top: -34 },
  hbHeroRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  hbHeroText: { flex: 1 },
  hbHeroEyebrow: { color: colors.accent, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6 },
  hbHeroTitle: { color: colors.text, fontSize: 19, fontWeight: '800', lineHeight: 25, marginTop: 7 },
  hbHeroMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 11 },
  hbHeroMetaText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600' },
  hbHeroBtn: {
    width: 52,
    height: 52,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: colors.accentStrong,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },

  // secondary actions
  hbRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  hbRowItem: { flex: 1 },
  hbAction: {
    // Slimmed from 106 so the two secondaries read as secondary. The hero must
    // be the only thing that looks like THE action.
    minHeight: 78,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    overflow: 'hidden',
    ...shadows.sm,
  },
  hbActionIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hbActionTitle: { color: colors.text, fontSize: 14.5, fontWeight: '800', marginTop: 12 },
  hbActionSub: {
    color: colors.textFaint,
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: 3,
    lineHeight: 16,
  },

  // templates link — the demoted entry point that replaced the marketplace
  hbTplLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 15,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  hbTplLinkText: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
  hbTplLinkHint: { flex: 1, textAlign: 'right', color: colors.textFaint, fontSize: 11.5, fontWeight: '600' },

  // template sheet
  hbSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,7,18,0.62)',
    justifyContent: 'flex-end',
  },
  hbSheetCard: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: 10,
    paddingBottom: 24,
  },
  hbSheetGrab: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 12,
  },
  hbSheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', paddingHorizontal: 18 },
  hbSheetSub: { color: colors.textMuted, fontSize: 12.5, marginTop: 3, paddingHorizontal: 18 },

  // templates
  hbTplHead: { marginTop: 30 },
  hbTplHeadTitle: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  hbTplHeadSub: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginTop: 3 },
  hbPills: { gap: 8, paddingVertical: 14, paddingRight: 6 },
  hbPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1 },
  hbPillGlow: {
    shadowColor: colors.accent,
    shadowOpacity: 0.3,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  hbPillText: { fontSize: 12.5, fontWeight: '700' },
  hbTplRow: { gap: 12, paddingBottom: 10, paddingRight: 6 },
  hbTpl: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    ...shadows.sm,
  },
  hbTplArt: { width: '100%', overflow: 'hidden' },
  hbTplArtCenter: {
    ...FILL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hbTplIconChip: {
    width: 40,
    height: 40,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6,10,22,0.34)',
  },
  hbMiniDuo: { flexDirection: 'row', gap: 5 },
  hbMiniTile: { width: 24, height: 32, borderRadius: 7 },
  hbMiniGrid: { width: 53, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  hbMiniGridTile: { width: 24, height: 24, borderRadius: 7 },
  hbTplBody: { padding: 12 },
  hbTplTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  hbTplSub: { color: colors.textFaint, fontSize: 11, fontWeight: '600', marginTop: 3, lineHeight: 15 },
  ideaWrap: { marginTop: 12 },
  ideaLabel: { color: colors.accent, fontSize: 12, fontWeight: '800', marginLeft: 6 },
  ideaChips: { gap: 8, paddingVertical: 8, paddingRight: 6 },
  ideaChip: {
    maxWidth: 260,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  ideaChipText: { color: colors.text, fontSize: 12.5, fontWeight: '600' },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  tagChipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  tagChipText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '700' },
  tagChipTextOn: { color: colors.accent },
  tagChipCount: { color: colors.textFaint, fontSize: 11, fontWeight: '700' },
  // ---- autocomplete (shared by hashtags and locations) ----
  acWrap: { marginTop: 10 },
  acCountRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 7 },
  acCountText: { color: colors.accent, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  acList: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  acRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  acMain: { color: colors.text, fontSize: 13.5, fontWeight: '700', flexShrink: 1 },
  acCount: { color: colors.textFaint, fontSize: 11.5, fontWeight: '700', marginLeft: 10 },
  // ---- location ----
  locWrap: { marginTop: 12 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // styles.input carries its own marginTop; the row owns the spacing instead.
  locInput: { flex: 1, marginTop: 0 },
  locGpsBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  locStatus: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginTop: 8 },
  locNotice: { color: colors.danger, fontSize: 12, fontWeight: '600', marginTop: 8 },
  editorTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 12,
  },
  editorTopBtn: { padding: 6 },
  editorTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  nextText: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  canvas: { alignSelf: 'stretch', marginHorizontal: 12, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
  canvasFlex: { flex: 1 },
  layerWrap: { alignItems: 'center' },
  layerX: {
    position: 'absolute',
    top: -10,
    right: -14,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 9,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  layerXText: { color: colors.text, fontSize: 10, fontWeight: '800' },
  trimBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  trimBadgeText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  soundBadge: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  soundBadgeText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  toolbar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.border },
  toolbarRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  toolBtn: { alignItems: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, minWidth: 64 },
  toolBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  toolIcon: { fontSize: 17 },
  toolLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', marginTop: 4 },
  toolLabelActive: { color: colors.accent },
  panel: { minHeight: 72, borderTopWidth: 1, borderTopColor: colors.border, justifyContent: 'center' },
  panelRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, flexWrap: 'wrap', gap: 10 },
  panelLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  panelVal: { color: colors.text, fontSize: 13, fontWeight: '600', flex: 1 },
  trimCol: { marginRight: 14 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  stepBtn: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  stepText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  stepVal: { color: colors.text, fontSize: 14, fontWeight: '800', minWidth: 44, textAlign: 'center' },
  resetBtn: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  resetText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  chip: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  previewContent: { padding: 22, paddingTop: TOP_INSET + 10, paddingBottom: 48 },
  previewTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  previewBack: { color: colors.text, fontSize: 18 },
  previewTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },

  // ---- preview (redesigned) ----
  pvTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pvClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pvTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  // badge + close share the right-hand slot so the title stays centred between
  // the back arrow and this pair
  pvTopRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pvBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.35)',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  pvBadgeText: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  pvHint: { color: colors.textMuted, fontSize: 12.5, marginTop: 10, marginBottom: 4 },

  // sound row on the preview — reachable in the step where you notice it
  pvSoundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pvSoundIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  pvSoundBody: { flex: 1, minWidth: 0 },
  pvSoundTitle: { color: colors.text, fontSize: 13.5, fontWeight: '800' },
  pvSoundSub: { color: colors.textMuted, fontSize: 11.5, marginTop: 2 },
  pvSoundCta: { color: colors.accent, fontSize: 12, fontWeight: '800' },

  // the live post card
  pvCard: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.2)',
    backgroundColor: colors.surface,
    padding: 14,
    overflow: 'hidden',
    marginTop: 10,
    ...shadows.md,
  },
  pvHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pvWho: { flex: 1 },
  pvNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pvName: { color: colors.text, fontSize: 13.5, fontWeight: '800', flexShrink: 1 },
  pvMeta: { color: colors.textFaint, fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  pvMediaWrap: {
    marginTop: 12,
    borderRadius: radius.lg,
    overflow: 'hidden',
    // a surface, not a media well: while empty it holds pvMediaEmptyText, which
    // reads colors.textFaint and would be grey-on-navy if this stayed dark
    backgroundColor: colors.surfaceAlt,
    height: 250,
  },
  pvMedia: { width: '100%', height: '100%' },
  pvMediaEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  pvMediaEmptyText: { color: colors.textFaint, fontSize: 12, fontWeight: '600' },
  pvTextCard: { flex: 1, padding: 18, justifyContent: 'center' },
  pvTextBody: { fontSize: 20, fontWeight: '800', lineHeight: 26 },
  pvCaptionText: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 11 },
  pvActions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12 },
  pvAction: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pvActionText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  pvExpiry: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(193,59,255,0.3)',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pvExpiryText: { color: colors.accent, fontSize: 10.5, fontWeight: '800' },
  pvSection: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 24,
    marginBottom: 10,
  },

  // publish
  pvDrop: {
    marginTop: 20,
    borderRadius: radius.pill,
    paddingVertical: 17,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: colors.accentStrong,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  pvDropDisabled: { opacity: 0.6 },
  pvDropText: { color: colors.bg, fontSize: 16, fontWeight: '900', letterSpacing: 1.4 },
  previewMediaBox: { height: 220, borderRadius: radius.lg, overflow: 'hidden', marginBottom: 14, ...shadows.md },
  previewMediaSm: { width: '100%', height: '100%' },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    minHeight: 52,
    marginTop: 12,
  },
  mentionWrap: { marginTop: 0 },
  mentionChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  mentionChip: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  mentionChipText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  mentionResults: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, marginTop: 6, overflow: 'hidden' },
  mentionResult: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  mentionResultText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  dropToggle: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 14,
  },
  dropToggleOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  dropToggleTitle: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  dropTogglePrompt: { color: colors.text, fontSize: 13, marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: 20, marginBottom: 4 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: 0.5, borderBottomColor: colors.border },
  toggleLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  toggleTrack: { width: 46, height: 26, borderRadius: 13, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong, justifyContent: 'center', padding: 2 },
  toggleTrackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.textMuted },
  toggleThumbOn: { backgroundColor: colors.bg, alignSelf: 'flex-end' },
  fortyEight: {
    flexDirection: 'row',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    padding: 16,
    marginTop: 22,
  },
  fortyEightIcon: { fontSize: 26, marginRight: 12 },
  fortyEightBody: { flex: 1 },
  fortyEightTitle: { color: colors.accent, fontSize: 15, fontWeight: '800' },
  fortyEightSub: { color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  dropBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 22,
    overflow: 'hidden',
    ...shadows.glow,
  },
  dropBtnDisabled: { opacity: 0.6 },
  dropBtnText: { color: colors.bg, fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  soundInfo: { flex: 1, marginRight: 8 },
  soundTrim: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
  soundAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
  },
  soundActionText: { color: colors.accent, fontSize: 11, fontWeight: '800' },

  collage: { flexDirection: 'row', overflow: 'hidden' },
  collageSingle: { flex: 1, width: '100%', height: '100%' },
  collageHalf: { flex: 1, width: '50%', height: '100%' },
  collageTrioBig: { flex: 1.4, height: '100%' },
  collageTrioCol: { flex: 1 },
  collageTrioSmall: { flex: 1, width: '100%' },
  collageGrid: { flexWrap: 'wrap' },
  collageGridCell: { width: '33.33%', height: '50%' },
  exitOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: 28 },
  exitSheet: { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: radius.xl, padding: 22 },
  exitTitle: { color: colors.text, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  exitSub: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  exitCancel: { alignItems: 'center', marginTop: 14 },
  exitCancelText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
});
