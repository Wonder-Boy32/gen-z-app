import React, { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { VideoView, useVideoPlayer } from 'expo-video';
import { supabase } from '../supabase/client';
import { colors, radius, shadows } from '../theme';
import LogoHeader from '../components/LogoHeader';
import Icon from '../components/ui/Icon';
import Countdown from '../components/Countdown';
import Button from '../components/Button';
import { uploadMedia } from '../utils/upload';

type Drop = {
  id: string;
  prompt: string;
  status: 'scheduled' | 'live' | 'voting' | 'closed';
  starts_at: string;
  ends_at: string;
  voting_ends_at: string;
};

type Mode = 'media' | 'text';

export default function UploadStoryScreen({ onPosted }: { onPosted: () => void }) {
  const [mode, setMode] = useState<Mode>('media');
  const [assets, setAssets] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [caption, setCaption] = useState('');
  const [content, setContent] = useState('');
  const [audio, setAudio] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveDrop, setLiveDrop] = useState<Drop | null>(null);
  const [postToDrop, setPostToDrop] = useState(false);

  const firstIsVideo = assets.length > 0 && (assets[0].mimeType?.startsWith('video') ?? false);
  const player = useVideoPlayer(firstIsVideo ? { uri: assets[0].uri } : null, (p) => {
    p.loop = true;
  });

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('drops')
        .select('*')
        .eq('status', 'live')
        .order('ends_at', { ascending: true })
        .limit(1);
      const drop = (data?.[0] as Drop) ?? null;
      setLiveDrop(drop);
      setPostToDrop(!!drop);
    })();
  }, []);

  const pick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Allow photo access to post a story.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 6,
      quality: 0.8,
    });
    if (!res.canceled) {
      setAssets(res.assets);
      setError(null);
    }
  };

  const upload = async () => {
    if (mode === 'media' && !assets.length) return;
    if (mode === 'text' && !content.trim()) return;
    setUploading(true);
    setError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not logged in');

      const dropId = postToDrop && liveDrop ? liveDrop.id : null;

      if (mode === 'text') {
        const { error: err } = await supabase.from('posts').insert({
          user_id: user.id,
          content: content.trim(),
          audio: audio.trim() || null,
          drop_id: dropId,
        });
        if (err) throw new Error(err.message);
      } else {
        const items: { url: string; type: string }[] = [];
        for (const asset of assets) {
          const isVideo = asset.mimeType?.startsWith('video') ?? false;
          const ext = asset.fileName?.split('.').pop() ?? (isVideo ? 'mp4' : 'jpg');
          const path = `${user.id}/${Date.now()}-${items.length}.${ext}`;
          const publicUrl = await uploadMedia(
            path,
            asset.uri,
            asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
          );
          items.push({ url: publicUrl, type: isVideo ? 'video' : 'image' });
        }
        const first = items[0];
        const { error: err } = await supabase.from('posts').insert({
          user_id: user.id,
          media_url: first.url,
          media_type: first.type,
          media_items: items.length > 1 ? items : null,
          caption: caption.trim() || null,
          audio: audio.trim() || null,
          drop_id: dropId,
        });
        if (err) throw new Error(err.message);
      }

      setAssets([]);
      setCaption('');
      setContent('');
      setAudio('');
      onPosted();
    } catch (e: any) {
      setError(e?.message ?? 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <LogoHeader subtitle="Gone in 48 hours. Make it count." />

      {liveDrop && (
        <Pressable style={styles.dropToggle} onPress={() => setPostToDrop((v) => !v)}>
          <View style={styles.dropToggleTitleRow}>
            <Icon name="cube-outline" size={15} color={colors.accent} />
            <Text style={styles.dropToggleTitle}>
              {postToDrop ? 'Posting to the LIVE drop' : 'Post to the live drop'}
            </Text>
          </View>
          <Text style={styles.dropTogglePrompt} numberOfLines={2}>
            “{liveDrop.prompt}”
          </Text>
          <Countdown expiresAt={liveDrop.ends_at} style={styles.dropToggleTime} />
        </Pressable>
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

      {mode === 'media' ? (
        <>
          <Pressable style={styles.previewBox} onPress={pick}>
            {assets.length > 0 ? (
              firstIsVideo ? (
                <VideoView player={player} style={styles.previewMedia} contentFit="cover" />
              ) : (
                <Image
                  source={{ uri: assets[0].uri }}
                  style={styles.previewMedia}
                  resizeMode="cover"
                />
              )
            ) : (
              <View style={styles.previewEmpty}>
                <Text style={styles.previewPlus}>+</Text>
                <Text style={styles.previewEmptyText}>Pick up to 6 photos or a video</Text>
              </View>
            )}
          </Pressable>

          {assets.length > 1 && (
            <View style={styles.thumbRow}>
              {assets.map((a, i) => (
                <Image key={i} source={{ uri: a.uri }} style={styles.thumb} />
              ))}
            </View>
          )}

          <TextInput
            style={styles.input}
            placeholder="Add a caption..."
            placeholderTextColor={colors.textFaint}
            value={caption}
            onChangeText={setCaption}
          />
        </>
      ) : (
        <>
          <TextInput
            style={[styles.input, styles.textPostInput]}
            placeholder="Say something... (text post)"
            placeholderTextColor={colors.textFaint}
            multiline
            value={content}
            onChangeText={setContent}
          />
        </>
      )}

      <TextInput
        style={styles.input}
        placeholder="Audio / song name (optional)"
        placeholderTextColor={colors.textFaint}
        value={audio}
        onChangeText={setAudio}
      />

      {!!error && <Text style={styles.error}>{error}</Text>}

      {mode === 'media' && (
        <Button
          variant="secondary"
          title={assets.length ? 'Change / add media' : 'Choose media'}
          onPress={pick}
          disabled={uploading}
          style={{ marginTop: 16 }}
        />
      )}

      <Button
        title="Post to the feed"
        onPress={upload}
        disabled={
          uploading ||
          (mode === 'media' && !assets.length) ||
          (mode === 'text' && !content.trim())
        }
        loading={uploading}
        style={{ marginTop: 12 }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 22,
    paddingTop: 54,
  },
  dropToggle: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 16,
  },
  dropToggleTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dropToggleTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  dropTogglePrompt: {
    color: colors.text,
    fontSize: 13,
    marginTop: 4,
  },
  dropToggleTime: {
    marginTop: 6,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: 16,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.bg,
  },
  previewBox: {
    width: '100%',
    height: 300,
    borderRadius: radius.lg,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  previewMedia: {
    width: '100%',
    height: '100%',
  },
  previewEmpty: {
    alignItems: 'center',
  },
  previewPlus: {
    color: colors.accent,
    fontSize: 44,
    fontWeight: '300',
  },
  previewEmptyText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 8,
  },
  thumbRow: {
    flexDirection: 'row',
    marginTop: 10,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    backgroundColor: colors.surfaceInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: colors.text,
    fontSize: 15,
    marginTop: 16,
  },
  textPostInput: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 10,
  },
});
