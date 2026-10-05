import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../../theme';
import { removeJob, useUploads } from '../../utils/uploadManager';

/**
 * Ambient upload status, sitting directly above the tab bar.
 *
 * This is what replaces making the user watch a spinner while a post uploads:
 * they are free to use the rest of the app, and this strip tells them it is still
 * happening and how much is left. It renders itself only while there is
 * something to say, so it costs nothing the rest of the time.
 *
 * It is a plain flex child of HomeScreen rather than an absolutely-positioned
 * overlay, so it can never cover the tab bar or guess at the tab bar's height.
 */
export default function UploadBar() {
  const jobs = useUploads();
  if (jobs.length === 0) return null;

  const running = jobs.filter((j) => j.status === 'running');
  const failed = jobs.find((j) => j.status === 'error');
  const done = jobs.find((j) => j.status === 'done');

  // A failure is the one thing the user must not miss, so it takes precedence.
  if (failed) {
    return (
      <Pressable
        style={[styles.wrap, styles.failed]}
        onPress={() => removeJob(failed.id)}
        accessibilityRole="button"
        accessibilityLabel="Upload failed, tap to dismiss"
      >
        <Text style={styles.title} numberOfLines={1}>
          Upload failed
        </Text>
        <Text style={styles.detail} numberOfLines={2}>
          {failed.error ?? 'Tap to dismiss'}
        </Text>
      </Pressable>
    );
  }

  if (running.length > 0) {
    const overall = running.reduce((sum, j) => sum + j.progress, 0) / running.length;
    // "Percentage remaining" is what was asked for, so show the remainder rather
    // than the progress — it is the number that tells the user how long to wait.
    const remaining = Math.max(0, Math.round((1 - overall) * 100));
    const pct = Math.round(overall * 100);

    return (
      <View style={styles.wrap} accessibilityRole="progressbar">
        <View style={styles.headRow}>
          <Text style={styles.title} numberOfLines={1}>
            {running.length > 1
              ? `Uploading ${running.length} posts…`
              : `Uploading your ${running[0].label}…`}
          </Text>
          <Text style={styles.pct}>{remaining}% left</Text>
        </View>

        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pct}%` }]} />
        </View>

        <Text style={styles.detail} numberOfLines={1}>
          {running.length > 1
            ? "Keep using the app — we'll tell you when they're live."
            : running[0].detail || 'Keep using the app — we’ll tell you when it’s live.'}
        </Text>
      </View>
    );
  }

  if (done) {
    return (
      <Pressable
        style={[styles.wrap, styles.done]}
        onPress={() => removeJob(done.id)}
        accessibilityRole="button"
        accessibilityLabel="Post uploaded, tap to dismiss"
      >
        <Text style={styles.title} numberOfLines={1}>
          Post successfully uploaded
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          Your drop is live.
        </Text>
      </Pressable>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md ?? 14,
    backgroundColor: 'rgba(20,28,48,0.96)',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  done: {
    borderColor: 'rgba(52,211,153,0.55)',
  },
  failed: {
    borderColor: 'rgba(255,92,124,0.6)',
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '700',
  },
  pct: {
    marginLeft: 10,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
  },
  track: {
    height: 5,
    marginTop: 8,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  detail: {
    marginTop: 6,
    color: colors.textFaint,
    fontSize: 11.5,
  },
});
