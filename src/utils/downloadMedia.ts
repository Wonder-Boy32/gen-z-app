// ============================================================
// Download-to-gallery helpers (TikTok-style saves)
// - respects the creator's allow_downloads choice
// - fetches remote media to cache, then hands it to the UI
//   (photo watermark) or the ffmpeg bake (video watermark +
//   jingle outro), then saves the final file to the gallery
// ============================================================
import { supabase } from '../supabase/client';

export type DownloadMediaItem = { url: string; type: 'video' | 'image' };

// A post's downloadable media set — primary file first.
export function mediaItemsOf(post: {
  media_url: string | null;
  media_type: 'video' | 'image' | null;
  media_items?: { url: string; type: string }[] | null;
}): DownloadMediaItem[] {
  if (post.media_items && post.media_items.length > 0) {
    return post.media_items
      .filter((m) => m.url && (m.type === 'video' || m.type === 'image'))
      .map((m) => ({ url: m.url, type: m.type as 'video' | 'image' }));
  }
  if (post.media_url && post.media_type) {
    return [{ url: post.media_url, type: post.media_type }];
  }
  return [];
}

// True unless the creator explicitly switched downloads OFF.
export async function postAllowsDownload(postId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('posts')
      .select('allow_downloads')
      .eq('id', postId)
      .maybeSingle();
    return data?.allow_downloads !== false; // default true
  } catch {
    return true;
  }
}

// Download a remote media file into the app cache; returns a file:// uri.
export async function fetchMediaToCache(url: string, name?: string): Promise<string> {
  const fs: any = await import('expo-file-system/legacy');
  const dir = `${fs.cacheDirectory}downloads/`;
  try {
    await fs.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // exists
  }
  const ext = (url.split('?')[0].split('.').pop() ?? 'bin').slice(0, 5);
  const dest = `${dir}${name ?? 'media'}-${Date.now()}.${ext}`;
  await fs.downloadAsync(url, dest);
  return dest;
}

// Download file names like GenZ_2026-09-07_0810 (local date + HHmm)
export function genzDownloadStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `GenZ_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Save a local file to the photo library. When baseName is given the file
// is copied to a properly named cache file first, so the gallery shows
// e.g. GenZ_2026-09-07_0810.jpg instead of a random temp name.
export async function saveToGallery(uri: string, baseName?: string): Promise<void> {
  const fs: any = await import('expo-file-system/legacy');
  const MediaLibrary: any = await import('expo-media-library/legacy');
  let finalUri = uri;
  if (baseName) {
    try {
      const ext = (uri.split('?')[0].split('.').pop() ?? 'jpg').toLowerCase().slice(0, 5);
      const dest = `${fs.cacheDirectory}${baseName}.${ext}`;
      await fs.copyAsync({ from: uri, to: dest });
      finalUri = dest;
    } catch {
      // keep the original file if copy fails
    }
  }
  // writeOnly avoids requesting READ/AUDIO granular permissions (which Expo
  // Go can't grant and aren't needed just to save a file we created).
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) {
    throw new Error('Photo access is needed to save. Allow it in Settings.');
  }
  await MediaLibrary.createAssetAsync(finalUri);
}
