import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { VideoView, useVideoPlayer } from 'expo-video';
import { captureRef } from 'react-native-view-shot';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import { TOP_INSET } from '../utils/useInsets';
import LogoHeader from '../components/LogoHeader';
import Button from '../components/Button';
import Draggable from '../components/create/Draggable';
import MediaPickerSheet from '../components/create/MediaPickerSheet';
import SoundPickerModal from '../components/create/SoundPickerModal';
import FilterCarousel, { getFilterLabel, getFilterTint } from '../components/create/FilterCarousel';
import StickerPicker from '../components/create/StickerPicker';
import TextLayerEditor, { TextLayer } from '../components/create/TextLayerEditor';
import VoiceoverRecorder from '../components/create/VoiceoverRecorder';
import PhotoEditorModal from '../components/create/PhotoEditorModal';
import { uploadMedia } from '../utils/upload';
import { extractVideoCover, hasNativeFFmpeg, processDropVideo } from '../utils/videoProcessor';

// ============================================================
// GEN Z — ADVANCED UPLOAD / CREATE
// CREATE → SELECT MEDIA → EDIT → PREVIEW → PUBLISH → 🔥 DROP IT
// One posts row. expires_at = created_at + 48h (DB default, immutable).
// Drafts live in `drafts` and NEVER start the 48h timer.
// ============================================================

type Sound = { id: string; name: string; artist: string | null; category: string; usage_count: number };
type Sticker = { id: string; emoji: string; x: number; y: number; size: number };
type Drop = { id: string; prompt: string; status: string; ends_at: string };
type Mode = 'media' | 'text';
type Step = 'create' | 'editor' | 'preview' | 'live';
type Visibility = 'everyone' | 'followers' | 'only_me';

const H48 = 48 * 3600 * 1000;

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
const TEXT_DROP_COLORS = ['#0D1426', '#FF7A00', '#8B7BFF', '#FF5C7C', '#34D399', '#1E2A47'];

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

const TOOLS: { id: EditorOverlay; icon: string; label: string }[] = [
  { id: 'trim', icon: '✂️', label: 'Trim' },
  { id: 'cover', icon: '🎞', label: 'Cover' },
  { id: 'sound', icon: '🎵', label: 'Sound' },
  { id: 'effects', icon: '✨', label: 'Effects' },
  { id: 'text', icon: 'Aa', label: 'Text' },
  { id: 'stickers', icon: '🏷', label: 'Stickers' },
  { id: 'filters', icon: '🎨', label: 'Filters' },
  { id: 'voiceover', icon: '🎙', label: 'Voiceover' },
  { id: 'speed', icon: '⚡', label: 'Speed' },
  { id: 'crop', icon: '⛶', label: 'Crop' },
  { id: 'rotate', icon: '🔄', label: 'Rotate' },
];

export default function CreateDropScreen({
  onPosted,
  initialSound = null,
  replyToDropId = null,
}: {
  onPosted: () => void;
  initialSound?: string | null;
  replyToDropId?: string | null;
}) {
  const [step, setStep] = useState<Step>('create');
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
  const [soundOpen, setSoundOpen] = useState(false);
  const [textLayerOpen, setTextLayerOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [exitAsk, setExitAsk] = useState(false);
  const [draft, setDraft] = useState<{ id: string; updated_at: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [livePulse] = useState(new Animated.Value(1));

  const firstIsVideo = assets.length > 0 && (assets[0].mimeType?.startsWith('video') ?? false);
  const firstVideoUri = firstIsVideo ? assets[0].uri : null;
  const coverSource = firstVideoUri; // what the hidden cover-capture player plays
  const player = useVideoPlayer(firstVideoUri ? { uri: firstVideoUri } : null, (p) => {
    p.loop = true;
    p.playbackRate = 1;
  });

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

  // ---- auto cover: hidden paused player + view-shot capture ----
  const coverCaptureRef = useRef<View>(null);
  const capturePlayer = useVideoPlayer(coverSource ? { uri: coverSource } : null, (p) => {
    p.loop = false;
    p.play();
  });
  useEffect(() => {
    if (!capturePlayer) return;
    const sub = capturePlayer.addListener('timeUpdate', ({ currentTime }: { currentTime: number }) => {
      if (currentTime >= 0.4) capturePlayer.pause();
    });
    return () => sub.remove();
  }, [capturePlayer]);
  useEffect(() => {
    if (capturePlayer && coverSource) {
      try {
        capturePlayer.replace({ uri: coverSource });
        capturePlayer.play();
      } catch {
        // ignore
      }
    }
  }, [capturePlayer, coverSource]);

  const captureCoverNow = useCallback(async (): Promise<string | null> => {
    if (!coverCaptureRef.current || !capturePlayer) return null;
    try {
      capturePlayer.currentTime = 0;
      capturePlayer.play();
      await new Promise((r) => setTimeout(r, 700));
      capturePlayer.pause();
      const uri = await captureRef(coverCaptureRef.current, {
        format: 'jpg',
        quality: 0.7,
        result: 'tmpfile',
      });
      return uri;
    } catch {
      return null;
    }
  }, [capturePlayer]);

  // create-intent: reply-to-drop chain link
  useEffect(() => {
    if (replyToDropId) setParentDropId(replyToDropId);
  }, [replyToDropId]);

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

  // live drop fetch + draft fetch on mount
  useEffect(() => {
    (async () => {
      const [{ data: dropRows }, { data: draftRows }] = await Promise.all([
        supabase.from('drops').select('*').eq('status', 'live').order('ends_at', { ascending: true }).limit(1),
        supabase.from('drafts').select('id, updated_at').order('updated_at', { ascending: false }).limit(1),
      ]);
      const drop = (dropRows?.[0] as Drop) ?? null;
      setLiveDrop(drop);
      setPostToDrop(!!drop);
      setDraft((draftRows?.[0] as { id: string; updated_at: string }) ?? null);
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
  const imagesOnly = assets.every((a) => !(a.mimeType?.startsWith('video') ?? false));
  const hasAnyContent = hasMedia || content.trim().length > 0 || caption.trim().length > 0;

  const ratioOf = RATIOS.find((r) => r.id === ratio)?.ratio ?? null;

  const resetAll = () => {
    setMode('media');
    setAssets([]);
    setCaption('');
    setContent('');
    setCoverUri(null);
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

  const backFromEditor = () => {
    if (hasAnyContent) setExitAsk(true);
    else {
      player?.pause();
      setStep('create');
    }
  };

  const backFromPreview = () => {
    if (hasAnyContent) setExitAsk(true);
    else setStep('create');
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
    filter,
    effect,
    speed,
    ratio,
    rotation,
    trimStart,
    trimEnd,
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

  const saveDraft = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('drafts').upsert({ user_id: user.id, payload: draftPayload() }, { onConflict: 'user_id' });
    setExitAsk(false);
    onPosted();
  };

  const loadDraft = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from('drafts').select('payload').eq('id', draft?.id).maybeSingle();
    const p = data?.payload as any;
    if (!p) return;
    setMode(p.mode ?? 'media');
    setAssets((p.assets ?? []).map((a: any) => ({ uri: a.uri, mimeType: a.mimeType, fileName: a.fileName, width: a.width, height: a.height })));
    setCaption(p.caption ?? '');
    setContent(p.content ?? '');
    setTextColor(p.textColor ?? TEXT_DROP_COLORS[0]);
    setSound(p.sound ?? null);
    setCoverUri(p.coverUri ?? null);
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
    setDraft(null);
  };

  const discardDraft = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && draft) await supabase.from('drafts').delete().eq('id', draft.id);
    setDraft(null);
    setExitAsk(false);
    resetAll();
  };

  // ---- publish ----
  const publish = async () => {
    if (uploading) return;
    if (mode === 'media' && !hasMedia) return;
    if (mode === 'text' && !content.trim()) return;
    setUploading(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in');

      const row: any = { user_id: user.id };
      let bakedVideo = false;

      if (mode === 'media') {
        const items: { url: string; type: string }[] = [];
        for (let i = 0; i < assets.length; i++) {
          const asset = assets[i];
          const isVideo = asset.mimeType?.startsWith('video') ?? false;
          let uri = asset.uri;

          // Native builds: bake trim/speed/rotation/filter/voiceover into the
          // actual file with ffmpeg. Expo Go has no ffmpeg → metadata-only path.
          if (isVideo && i === 0 && hasNativeFFmpeg()) {
            let voLocal: string | null = null;
            if (voiceoverUrl) {
              try {
                const fs: any = await import('expo-file-system');
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
          const publicUrl = await uploadMedia(
            `${user.id}/drop-${Date.now()}-${i}.${ext}`,
            uri,
            asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
          );
          items.push({ url: publicUrl, type: isVideo ? 'video' : 'image' });

          // cover: user-picked, else auto-capture a frame (view-shot, works
          // everywhere), else ffmpeg frame in native builds.
          if (isVideo && i === 0) {
            let coverSrc: string | null = coverUri;
            if (!coverSrc) {
              try {
                coverSrc = await captureCoverNow();
              } catch {}
            }
            if (!coverSrc && hasNativeFFmpeg()) {
              try {
                coverSrc = await extractVideoCover(asset.uri);
              } catch {}
            }
            if (coverSrc) {
              try {
                row.cover_url = await uploadMedia(`${user.id}/cover-${Date.now()}.jpg`, coverSrc, 'image/jpeg');
              } catch {}
            }
          }
        }
        row.media_url = items[0].url;
        row.media_type = items[0].type;
        if (items.length > 1) row.media_items = items;
        row.caption = caption.trim() || null;
      } else {
        row.content = content.trim();
        row.text_bg = textColor;
        row.text_color = ['#0D1426', '#1E2A47'].includes(textColor) ? '#FFFFFF' : '#0D1426';
      }

      row.sound = sound?.name ?? null;
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

      // expires_at is NOT sent — DB default sets created_at and expires_at (+48h)
      const { error: err } = await supabase.from('posts').insert(row);
      if (err) throw new Error(err.message);

      // clean up the draft (if any) — the drop is live now
      await supabase.from('drafts').delete().eq('user_id', user.id);

      // DROP LIVE animation
      setStep('live');
      Animated.loop(
        Animated.sequence([
          Animated.timing(livePulse, { toValue: 1.25, duration: 500, useNativeDriver: true }),
          Animated.timing(livePulse, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      ).start();
    } catch (e: any) {
      console.error('[publish] drop failed:', e?.code, e?.message, e?.stack);
      setError(e?.code ? `[${e.code}] ${e.message}` : (e?.message ?? 'Drop failed — try again.'));
      setUploading(false);
    }
  };

  const addSticker = (emoji: string) => {
    setStickers((s) => [
      ...s,
      { id: `s-${Date.now()}`, emoji, x: 60 + Math.random() * 140, y: 140 + Math.random() * 200, size: 52 },
    ]);
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <View style={styles.container}>
      {step === 'create' && (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.createContent} keyboardShouldPersistTaps="handled">
            <LogoHeader subtitle="Gone in 48 hours. Make it count." />

            {/* Media | Text toggle */}
            {parentDropId && (
              <View style={styles.replyBanner}>
                <Text style={styles.replyBannerText}>
                  🎥 Replying to a Drop — this links back to the original and gets its own 48 hours.
                </Text>
              </View>
            )}
            <View style={styles.segment}>
              {(['media', 'text'] as Mode[]).map((m) => (
                <Pressable
                  key={m}
                  style={[styles.segmentBtn, mode === m && styles.segmentBtnActive]}
                  onPress={() => setMode(m)}
                >
                  <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
                    {m === 'media' ? '📹 Media' : '✍️ Text'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {draft && (
              <Pressable style={styles.draftBanner} onPress={loadDraft}>
                <Text style={styles.draftBannerText}>💾 You have a draft from {new Date(draft.updated_at).toLocaleString()}</Text>
                <Text style={styles.draftBannerCta}>Resume →</Text>
              </Pressable>
            )}

            {mode === 'media' ? (
              <>
                <Pressable style={styles.previewBox} onPress={() => setPickerOpen(true)}>
                  {hasMedia ? (
                    firstIsVideo ? (
                      <VideoView player={player} style={styles.previewMedia} contentFit="cover" />
                    ) : (
                      <CollageView assets={assets} collage={assets.length > 1 ? collage : 'single'} style={styles.previewMedia} />
                    )
                  ) : (
                    <View style={styles.previewEmpty}>
                      <Text style={styles.previewPlus}>+</Text>
                      <Text style={styles.previewEmptyText}>Pick up to 6 photos or a video</Text>
                    </View>
                  )}
                  {hasMedia && (
                    <View style={styles.countBadge}>
                      <Text style={styles.countBadgeText}>{assets.length} media</Text>
                    </View>
                  )}
                </Pressable>

                <View style={styles.mediaActions}>
                  <Button variant="secondary" title={hasMedia ? 'Change / add media' : 'Choose media'} onPress={() => setPickerOpen(true)} />
                  {hasMedia && imagesOnly && assets.length > 1 && (
                    <Button variant="secondary" title="🖼 Photo layout" onPress={() => setPhotoEditorOpen(true)} style={{ marginLeft: 10 }} />
                  )}
                </View>

                {hasMedia && (
                  <Button
                    title="Continue → editor"
                    onPress={goEditor}
                    style={{ marginTop: 14 }}
                  />
                )}
              </>
            ) : (
              <>
                <View style={[styles.textDropCard, { backgroundColor: textColor }]}>
                  <TextInput
                    style={[styles.textDropInput, { color: textColor === '#0D1426' || textColor === '#1E2A47' ? colors.text : colors.bg }]}
                    placeholder="Say something worth seeing..."
                    placeholderTextColor="rgba(255,255,255,0.45)"
                    multiline
                    maxLength={220}
                    value={content}
                    onChangeText={setContent}
                  />
                  <Text style={styles.textDropHint}>⏳ This text drop vanishes in 48 hours</Text>
                </View>
                <View style={styles.chipRow}>
                  {TEXT_DROP_COLORS.map((c) => (
                    <Pressable
                      key={c}
                      style={[styles.colorSwatch, { backgroundColor: c }, textColor === c && styles.colorSwatchActive]}
                      onPress={() => setTextColor(c)}
                    />
                  ))}
                </View>
                {content.trim().length > 0 && (
                  <Button title="Continue → preview" onPress={goPreview} style={{ marginTop: 10 }} />
                )}
              </>
            )}

            {!!error && <Text style={styles.error}>{error}</Text>}
            <Text style={styles.footer48}>⏳ Gone in 48 hours. Make it count.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {step === 'editor' && (
        <View style={styles.flex}>
          <View style={styles.editorTop}>
            <Pressable onPress={backFromEditor} hitSlop={8} style={styles.editorTopBtn}>
              <Text style={styles.editorTopText}>✕</Text>
            </Pressable>
            <Text style={styles.editorTitle}>Edit drop</Text>
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
                <Text style={styles.trimBadgeText}>✂️ {fmtTime(trimStart)} – {fmtTime(trimEnd)}</Text>
              </View>
            )}
            {sound && (
              <View pointerEvents="none" style={styles.soundBadge}>
                <Text style={styles.soundBadgeText}>♪ {sound.name}</Text>
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
                <Text style={styles.toolIcon}>{t.icon}</Text>
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
                    <Text style={styles.panelVal}>♪ {sound.name} · {sound.artist ?? 'GEN Z'}</Text>
                    <Pressable style={styles.resetBtn} onPress={() => setSound(null)}><Text style={styles.resetText}>✕ Remove</Text></Pressable>
                  </>
                ) : (
                  <Button variant="secondary" title="🎵 Browse sounds" onPress={() => setSoundOpen(true)} />
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
                <Button variant="secondary" title="🏷 Add sticker" onPress={() => setStickerOpen(true)} />
              </View>
            )}
            {overlay === 'filters' && <FilterCarousel value={filter} onChange={setFilter} />}
            {overlay === 'cover' && (
              <View style={styles.panelColumn}>
                <Text style={styles.panelHint}>
                  Pick a photo as this video's cover — it shows on your profile grid and everywhere the Drop is listed.
                </Text>
                {coverUri ? (
                  <View style={styles.coverPreviewRow}>
                    <Image source={{ uri: coverUri }} style={styles.coverPreview} />
                    <Pressable onPress={() => setCoverUri(null)} hitSlop={8}>
                      <Text style={styles.coverRemove}>✕ Remove cover</Text>
                    </Pressable>
                  </View>
                ) : (
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
                      }}
                    />
                    <Button
                      variant="secondary"
                      title={coverBusy ? 'Generating…' : '⚡ Auto (first frame)'}
                      disabled={coverBusy}
                      onPress={async () => {
                        setCoverBusy(true);
                        try {
                          const local = await captureCoverNow();
                          if (local) setCoverUri(local);
                        } finally {
                          setCoverBusy(false);
                        }
                      }}
                    />
                  </View>
                )}
                {!coverUri && (
                  <Text style={styles.panelHint}>
                    No cover chosen? We auto-capture the first frame at publish — or use ⚡ Auto now.
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

      {step === 'preview' && (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.previewContent} keyboardShouldPersistTaps="handled">
            <View style={styles.previewTop}>
              <Pressable onPress={backFromPreview} hitSlop={8}>
                <Text style={styles.previewBack}>✕</Text>
              </Pressable>
              <Text style={styles.previewTitle}>Preview</Text>
              <View style={{ width: 24 }} />
            </View>

            {mode === 'media' ? (
              <View style={styles.previewMediaBox}>
                {firstIsVideo ? (
                  <VideoView player={player} style={styles.previewMediaSm} contentFit="cover" />
                ) : (
                  <CollageView assets={assets} collage={assets.length > 1 ? collage : 'single'} style={styles.previewMediaSm} />
                )}
              </View>
            ) : (
              <View style={[styles.textDropCardSm, { backgroundColor: textColor }]}>
                <Text style={[styles.textDropBody, { color: textColor === '#0D1426' || textColor === '#1E2A47' ? colors.text : colors.bg }]} numberOfLines={6}>
                  {content}
                </Text>
              </View>
            )}

            <TextInput
              style={styles.input}
              placeholder={mode === 'media' ? 'Write a caption... #hashtags @mentions' : 'Add a caption (optional)...'}
              placeholderTextColor={colors.textFaint}
              multiline
              value={caption}
              onChangeText={setCaption}
            />

            <TextInput
              style={styles.input}
              placeholder="Add location (optional)"
              placeholderTextColor={colors.textFaint}
              value={location}
              onChangeText={setLocation}
            />

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
                <Text style={styles.dropToggleTitle}>{postToDrop ? '📦 Posting to the LIVE drop' : '📦 Post to the live drop'}</Text>
                <Text style={styles.dropTogglePrompt} numberOfLines={2}>“{liveDrop.prompt}”</Text>
              </Pressable>
            )}

            {/* privacy */}
            <Text style={styles.sectionTitle}>Who can see this</Text>
            <View style={styles.chipRow}>
              {([
                { id: 'everyone', label: '🌍 Everyone' },
                { id: 'followers', label: '👥 Followers' },
                { id: 'only_me', label: '🔒 Only me' },
              ] as { id: Visibility; label: string }[]).map((v) => (
                <Pressable key={v.id} style={[styles.chip, visibility === v.id && styles.chipActive]} onPress={() => setVisibility(v.id)}>
                  <Text style={[styles.chipText, visibility === v.id && styles.chipTextActive]}>{v.label}</Text>
                </Pressable>
              ))}
            </View>

            {/* interactions */}
            <Text style={styles.sectionTitle}>Interaction settings</Text>
            <ToggleRow label="Likes" value={allowLikes} onChange={setAllowLikes} />
            <ToggleRow label="Comments" value={allowComments} onChange={setAllowComments} />
            <ToggleRow label="Shares" value={allowShares} onChange={setAllowShares} />
            <ToggleRow label="Reposts" value={allowReposts} onChange={setAllowReposts} />
            <ToggleRow label="Downloads" value={allowDownloads} onChange={setAllowDownloads} />
            <ToggleRow label="Mentions" value={allowMentions} onChange={setAllowMentions} />

            {/* 48h confirmation */}
            <View style={styles.fortyEight}>
              <Text style={styles.fortyEightIcon}>⏳</Text>
              <View style={styles.fortyEightBody}>
                <Text style={styles.fortyEightTitle}>This Drop disappears in 48 hours</Text>
                <Text style={styles.fortyEightSub}>
                  It goes live the moment you tap DROP IT. No edits, no resets — after 48h it's gone forever.
                </Text>
              </View>
            </View>

            {!!error && <Text style={styles.error}>{error}</Text>}

            <Pressable style={[styles.dropBtn, uploading && styles.dropBtnDisabled]} onPress={publish} disabled={uploading}>
              {uploading ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.dropBtnText}>🔥 DROP IT</Text>
              )}
            </Pressable>
            <Text style={styles.footer48}>Gone in 48 hours. Make it count.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {step === 'live' && (
        <View style={styles.liveWrap}>
          <Animated.Text style={[styles.liveFlame, { transform: [{ scale: livePulse }] }]}>🔥</Animated.Text>
          <Text style={styles.liveTitle}>DROP LIVE</Text>
          <Text style={styles.liveSub}>Your drop is live for 48 hours.</Text>
          <Text style={styles.liveSub2}>Gone in 48 hours. Make it count.</Text>
          <Button title="Back to feed" onPress={() => { resetAll(); setStep('create'); onPosted(); }} style={{ marginTop: 28, minWidth: 220 }} />
        </View>
      )}

      {/* modals & sheets */}
      <MediaPickerSheet
        visible={pickerOpen}
        assets={assets}
        onClose={() => setPickerOpen(false)}
        onPicked={(a) => setAssets(a)}
      />
      <SoundPickerModal visible={soundOpen} onClose={() => setSoundOpen(false)} onSelect={(s) => { setSound(s); setSoundOpen(false); }} />
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

      {/* exit → save draft? */}
      <Modal visible={exitAsk} animationType="fade" transparent onRequestClose={() => setExitAsk(false)}>
        <View style={styles.exitOverlay}>
          <View style={styles.exitSheet}>
            <Text style={styles.exitTitle}>Save as draft?</Text>
            <Text style={styles.exitSub}>Drafts never start the 48-hour timer. Your drop only goes live when you hit 🔥 DROP IT.</Text>
            <Button title="💾 Save draft" onPress={saveDraft} style={{ marginTop: 16 }} />
            <Button variant="secondary" title="🗑 Discard" onPress={discardDraft} style={{ marginTop: 10 }} />
            <Pressable style={styles.exitCancel} onPress={() => setExitAsk(false)}>
              <Text style={styles.exitCancelText}>Keep editing</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  flex: { flex: 1 },
  createContent: { padding: 22, paddingTop: TOP_INSET + 16, paddingBottom: 40 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: 16,
  },
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
  segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  segmentTextActive: { color: colors.bg },
  draftBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 16,
  },
  draftBannerText: { color: colors.text, fontSize: 12, flex: 1 },
  draftBannerCta: { color: colors.accent, fontSize: 13, fontWeight: '800', marginLeft: 10 },
  previewBox: {
    width: '100%',
    height: 380,
    borderRadius: radius.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  previewMedia: { width: '100%', height: '100%' },
  previewEmpty: { alignItems: 'center' },
  previewPlus: { color: colors.accent, fontSize: 44, fontWeight: '300' },
  previewEmptyText: { color: colors.textMuted, fontSize: 14, marginTop: 8 },
  countBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  countBadgeText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  mediaActions: { flexDirection: 'row', marginTop: 14 },
  textDropCard: {
    borderRadius: radius.lg,
    minHeight: 240,
    padding: 20,
    justifyContent: 'space-between',
    ...shadows.md,
  },
  textDropInput: { fontSize: 26, fontWeight: '800', minHeight: 160, textAlignVertical: 'top' },
  textDropHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 10 },
  textDropCardSm: { borderRadius: radius.lg, padding: 18, minHeight: 130, ...shadows.md },
  textDropBody: { fontSize: 20, fontWeight: '800' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' },
  colorSwatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: 'transparent' },
  colorSwatchActive: { borderColor: colors.accent },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  footer48: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 22, fontWeight: '600' },
  editorTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 12,
  },
  editorTopBtn: { padding: 6 },
  editorTopText: { color: colors.text, fontSize: 18 },
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
  previewMediaBox: { height: 220, borderRadius: radius.lg, overflow: 'hidden', marginBottom: 14, ...shadows.md },
  previewMediaSm: { width: '100%', height: '100%' },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: colors.text,
    fontSize: 15,
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
  dropBtnText: { color: colors.bg, fontSize: 18, fontWeight: '900', letterSpacing: 0.5, lineHeight: 24 },
  liveWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgDeep, padding: 24 },
  liveFlame: { fontSize: 84 },
  liveTitle: { color: colors.accent, fontSize: 34, fontWeight: '900', letterSpacing: 2, marginTop: 10, ...shadows.glow },
  liveSub: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 10 },
  liveSub2: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
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
